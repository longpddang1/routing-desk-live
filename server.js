'use strict';
require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const { triage, DEFAULT_CATEGORIES } = require('./src/triage');
const hubspot = require('./src/hubspot');
const slack = require('./src/slack');
const zendesk = require('./src/zendesk');

const app = express();
app.use(express.json({ limit: '100kb' }));

const PORT = process.env.PORT || 3000;
const VALID_CHANNELS = ['email', 'chat', 'phone'];

function isValidEmailShape(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

/* ---------------------------------------------------------------
   Company inference from an email domain.

   A B2B support desk almost always cares which account a ticket
   belongs to, but asking "what company are you with?" is one more
   question between an angry customer and a human. The domain
   already answers it for business addresses, so we derive it and
   mark the value as inferred (never presented as confirmed fact).

   Consumer mailbox providers are excluded - otherwise every Gmail
   user gets filed under "Gmail". A personal address simply yields
   no company, which is the honest answer.
----------------------------------------------------------------*/
const CONSUMER_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com',
  'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'gmx.com', 'gmx.de',
  'proton.me', 'protonmail.com', 'pm.me', 'yandex.com', 'zoho.com',
  'fastmail.com', 'hey.com', 'duck.com', 'tutanota.com', 'mail.com',
  'comcast.net', 'verizon.net', 'sbcglobal.net', 'btinternet.com'
]);

// Second-level labels that are part of the public suffix rather than the
// organisation's own name (acme.co.uk -> Acme, not Co).
const PUBLIC_SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'ac', 'gov', 'edu', 'or', 'ne']);

function companyFromEmail(rawEmail) {
  const email = (rawEmail || '').trim().toLowerCase();
  const match = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/.exec(email);
  if (!match) return null;

  const domain = match[1];
  if (CONSUMER_EMAIL_DOMAINS.has(domain)) return null;

  const parts = domain.split('.').filter(Boolean);
  if (parts.length < 2) return null;

  const core = (parts.length >= 3 && PUBLIC_SECOND_LEVEL.has(parts[parts.length - 2]))
    ? parts[parts.length - 3]
    : parts[parts.length - 2];
  if (!core || core.length < 2) return null;

  return core
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
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

  /* Note on how chat text reaches this service:
     Zendesk Messaging keeps conversation content in its own event
     stream, NOT in the ticket's comment field - so trigger placeholders
     like {{ticket.description}} and {{ticket.comments_formatted}} can
     never see what the customer typed (they only resolve to an internal
     "Conversation with <name>" stub, and are additionally suppressed on
     ticket-created triggers by Zendesk's anti-spam rules).
     The working path is entirely inside Zendesk: the AI agent's flow
     asks "what's going on?", collects the answer as a parameter, and on
     escalation runs a Sunshine Conversations "Update conversation"
     action writing metadata key zen:ticket_field:<ZENDESK_ISSUE_FIELD_ID>.
     Zendesk maps that onto the custom ticket field (which must be a Text
     field with "Customers can edit" enabled), and the ticket trigger
     sends it here as {{ticket.ticket_field_<id>}} in the webhook body.
     Target must be "Sunshine Conversations", not "Conversation" - the
     latter is the bot's internal scratch context and never leaves it. */

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

  // A company the customer told us always wins; otherwise infer one from
  // their email domain and flag it as inferred so the UI can say so.
  const statedCompany = (fields.company || '').trim();
  const inferredCompany = statedCompany ? null : companyFromEmail(fields.email);

  const ticketFields = {
    channel: fields.channel,
    name: fields.name,
    email: fields.email,
    phone: fields.phone,
    company: statedCompany || inferredCompany || '',
    companyInferred: !statedCompany && !!inferredCompany,
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
    zendeskApiConfigured: zendesk.isConfigured(),
    zendeskIssueFieldConfigured: !!(process.env.ZENDESK_ISSUE_FIELD_ID || '').trim(),
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
    const name = (body.requester_name || '').toString().trim().slice(0, 200);
    // Zendesk won't accept an email silently set on an anonymous messaging
    // user (it treats end-user email as a verified identity), so
    // requester_email is usually blank for chat. The bot instead captures
    // the address into a custom ticket field; the trigger sends it as
    // customer_email, and we prefer that when the requester record is bare.
    const email = ((body.customer_email || '').toString().trim()
      || (body.requester_email || '').toString().trim()).slice(0, 320);
    const phone = (body.requester_phone || '').toString().trim().slice(0, 60);
    const company = (body.company || '').toString().trim().slice(0, 200);
    const channel = inferChannel(body.channel);
    const zendeskTicketId = body.ticket_id ? String(body.ticket_id).slice(0, 60) : null;
    const zendeskTicketUrl = body.ticket_link ? String(body.ticket_link).slice(0, 500) : null;

    // The trigger payload's own "description" placeholder is unreliable
    // for chat/Messaging tickets (Zendesk hasn't synced the real customer
    // message into the ticket's comments yet at the instant the "ticket
    // created" trigger fires - it only sees an internal system note). If
    // a Zendesk API token is configured, go fetch the real first public
    // comment directly instead, retrying briefly for the sync to land.
    // Falls back to the trigger payload's description if that's not
    // configured or nothing comes back, so this never breaks the demo.
    const fetchedNote = zendesk.isConfigured() && zendeskTicketId
      ? await zendesk.getFirstPublicComment(zendeskTicketId)
      : null;
    const note = (fetchedNote || (body.description || '').toString()).trim().slice(0, 4000);

    if (!note) return res.status(400).json({ error: 'Missing ticket description in payload.' });

    const { triageResult, priority, hsTicket, slackResult } = await createAndRouteTicket(
      { channel, name, email, phone, company, note },
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
  console.log(`  Zendesk API (real comment fetch) configured: ${zendesk.isConfigured()}`);
});
