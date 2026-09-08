'use strict';
require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const { triage, DEFAULT_CATEGORIES } = require('./src/triage');
const hubspot = require('./src/hubspot');
const slack = require('./src/slack');

const app = express();
app.use(express.json({ limit: '100kb' }));

const PORT = process.env.PORT || 3000;
const VALID_CHANNELS = ['email', 'chat', 'phone'];

function isValidEmailShape(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

/* ---------------------------------------------------------------
   Homepage - a small server-rendered template (not a static file)
   so the Zendesk widget script and support email can be injected
   from environment variables without touching HTML.
----------------------------------------------------------------*/
let homepageTemplateCache = null;
function loadHomepageTemplate() {
  // Re-read from disk in dev so edits show up without a restart; a
  // production boot just reads it once.
  if (!homepageTemplateCache || process.env.NODE_ENV !== 'production') {
    homepageTemplateCache = fs.readFileSync(path.join(__dirname, 'views', 'homepage.html'), 'utf8');
  }
  return homepageTemplateCache;
}
function renderHomepage() {
  const supportEmail = (process.env.SUPPORT_EMAIL || 'support@example.com').trim();
  const widgetKey = (process.env.ZENDESK_WIDGET_KEY || '').trim();
  const widgetScript = widgetKey
    ? `<script id="ze-snippet" src="https://static.zdassets.com/ekr/snippet.js?key=${widgetKey}"> </script>`
    : '<!-- Zendesk live chat not configured yet: set ZENDESK_WIDGET_KEY -->';
  const liveChatNote = widgetKey
    ? 'Click the chat bubble in the corner of this page — a real person (backed by our own routing automation) will be right with you.'
    : "Live chat isn't connected yet — reach out by email in the meantime.";

  return loadHomepageTemplate()
    .split('{{SUPPORT_EMAIL}}').join(supportEmail)
    .split('{{ZENDESK_WIDGET_SCRIPT}}').join(widgetScript)
    .split('{{LIVE_CHAT_NOTE}}').join(liveChatNote);
}

app.get('/', (req, res) => {
  res.type('html').send(renderHomepage());
});

// Any other static assets (images, etc.) can still live in public/.
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------------------------------------------------------
   Shared pipeline: triage -> HubSpot ticket -> Slack notification.
   Used by both the direct API (/api/tickets) and the Zendesk
   webhook receiver, so every channel gets identical handling.
----------------------------------------------------------------*/
async function createAndRouteTicket(fields, meta) {
  meta = meta || {};
  const result = await triage(fields.note, DEFAULT_CATEGORIES);
  const priority = ['P1', 'P2', 'P3'].includes(fields.priority) ? fields.priority : result.priority;

  const ticketFields = {
    channel: fields.channel,
    name: fields.name,
    email: fields.email,
    phone: fields.phone,
    note: fields.note,
    category: result.category,
    priority,
    zendeskTicketId: meta.zendeskTicketId || null,
    zendeskTicketUrl: meta.zendeskTicketUrl || null
  };

  const hsTicket = await hubspot.createTicket(ticketFields);

  const slackResult = await slack.postTicketNotification({
    ...ticketFields,
    hubspotUrl: hsTicket.url,
    hubspotId: hsTicket.id
  });

  return { triageResult: result, priority, hsTicket, slackResult };
}

// Health/wake-up endpoint - hit this a minute or two before a live demo
// if the app is on a host that sleeps after inactivity (e.g. Render free tier).
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    hubspotConfigured: hubspot.isConfigured(),
    slackTechnicalConfigured: !!(process.env.SLACK_TECHNICAL_WEBHOOK_URL || '').trim(),
    slackGeneralConfigured: !!(process.env.SLACK_GENERAL_WEBHOOK_URL || '').trim(),
    aiConfigured: !!(process.env.ANTHROPIC_API_KEY || '').trim(),
    zendeskWidgetConfigured: !!(process.env.ZENDESK_WIDGET_KEY || '').trim(),
    zendeskWebhookConfigured: !!(process.env.ZENDESK_WEBHOOK_SECRET || '').trim(),
    supportEmail: (process.env.SUPPORT_EMAIL || 'support@example.com').trim()
  });
});

// Direct API - used for manual/internal ticket creation and testing.
app.post('/api/tickets', async (req, res) => {
  try {
    const body = req.body || {};
    const channel = VALID_CHANNELS.includes(body.channel) ? body.channel : null;
    const name = (body.name || '').trim().slice(0, 200);
    const email = (body.email || '').trim().slice(0, 320);
    const phone = (body.phone || '').trim().slice(0, 60);
    const note = (body.note || '').trim().slice(0, 4000);

    if (!channel) return res.status(400).json({ error: 'channel must be one of: email, chat, phone' });
    if (!note) return res.status(400).json({ error: 'Tell us what you need help with.' });
    if (!email && !phone) return res.status(400).json({ error: 'An email address or phone number is required.' });
    if (email && !isValidEmailShape(email)) return res.status(400).json({ error: 'That email address doesn’t look valid.' });

    const { triageResult, priority, hsTicket, slackResult } = await createAndRouteTicket({ channel, name, email, phone, note });

    res.json({
      ticketId: hsTicket.id,
      hubspotUrl: hsTicket.url,
      hubspotDryRun: hsTicket.dryRun,
      priority,
      category: triageResult.category,
      classifiedBy: triageResult.classifiedBy,
      aiError: triageResult.aiError,
      slack: slackResult
    });
  } catch (e) {
    console.error('[POST /api/tickets] failed:', e);
    res.status(500).json({ error: 'Something went wrong creating your ticket. Please try again.' });
  }
});

/* ---------------------------------------------------------------
   Zendesk webhook receiver. Configure a Zendesk trigger ("ticket
   created") to Notify this URL with a JSON body built from Zendesk
   placeholders - see README.md for the exact trigger setup and the
   payload template to paste into it.

   Auth: Zendesk's webhook is configured with HTTP Basic
   authentication; the password must match ZENDESK_WEBHOOK_SECRET.
   (The username isn't checked - Zendesk requires one to be set, but
   the secret does the actual verifying.) If ZENDESK_WEBHOOK_SECRET
   isn't set on the server, this endpoint refuses every request
   rather than silently accepting unauthenticated ones.
----------------------------------------------------------------*/
function verifyZendeskAuth(req) {
  const expected = (process.env.ZENDESK_WEBHOOK_SECRET || '').trim();
  if (!expected) return false;
  const header = req.headers['authorization'] || '';
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) return false;
  let decoded;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch (e) {
    return false;
  }
  const sep = decoded.indexOf(':');
  const password = sep === -1 ? decoded : decoded.slice(sep + 1);
  return password === expected;
}

function inferChannel(viaRaw) {
  const via = (viaRaw || '').toString().toLowerCase();
  if (via.includes('chat') || via.includes('messaging') || via.includes('web widget')) return 'chat';
  if (via.includes('phone') || via.includes('voice') || via.includes('talk')) return 'phone';
  return 'email';
}

app.post('/api/zendesk-webhook', async (req, res) => {
  if (!verifyZendeskAuth(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const body = req.body || {};
    const note = (body.description || '').toString().trim().slice(0, 4000);
    const name = (body.requester_name || '').toString().trim().slice(0, 200);
    const email = (body.requester_email || '').toString().trim().slice(0, 320);
    const phone = (body.requester_phone || '').toString().trim().slice(0, 60);
    const channel = inferChannel(body.channel);
    const zendeskTicketId = body.ticket_id ? String(body.ticket_id).slice(0, 60) : null;
    const zendeskTicketUrl = body.ticket_link ? String(body.ticket_link).slice(0, 500) : null;

    if (!note) return res.status(400).json({ error: 'Missing ticket description in payload.' });

    const { triageResult, priority, hsTicket, slackResult } = await createAndRouteTicket(
      { channel, name, email, phone, note },
      { zendeskTicketId, zendeskTicketUrl }
    );

    res.json({
      ok: true,
      hubspotTicketId: hsTicket.id,
      hubspotUrl: hsTicket.url,
      priority,
      category: triageResult.category,
      slack: slackResult
    });
  } catch (e) {
    console.error('[POST /api/zendesk-webhook] failed:', e);
    res.status(500).json({ error: 'Failed to process Zendesk webhook.' });
  }
});

app.listen(PORT, () => {
  console.log(`Routing Desk Live listening on port ${PORT}`);
  console.log(`  HubSpot configured: ${hubspot.isConfigured()}`);
  console.log(`  Slack technical webhook (P1+P2): ${!!(process.env.SLACK_TECHNICAL_WEBHOOK_URL || '').trim()}`);
  console.log(`  Slack general webhook (P3): ${!!(process.env.SLACK_GENERAL_WEBHOOK_URL || '').trim()}`);
  console.log(`  AI classification: ${!!(process.env.ANTHROPIC_API_KEY || '').trim()}`);
  console.log(`  Zendesk widget: ${!!(process.env.ZENDESK_WIDGET_KEY || '').trim()}`);
  console.log(`  Zendesk webhook secret set: ${!!(process.env.ZENDESK_WEBHOOK_SECRET || '').trim()}`);
});
