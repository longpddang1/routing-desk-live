'use strict';
require('dotenv').config();

const express = require('express');
const path = require('path');
const { triage, DEFAULT_CATEGORIES } = require('./src/triage');
const hubspot = require('./src/hubspot');
const slack = require('./src/slack');

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const VALID_CHANNELS = ['email', 'chat', 'phone'];

function isValidEmailShape(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

// Health/wake-up endpoint - hit this a minute or two before a live demo
// if the app is on a host that sleeps after inactivity (e.g. Render free tier).
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    hubspotConfigured: hubspot.isConfigured(),
    slackTechnicalConfigured: !!(process.env.SLACK_TECHNICAL_WEBHOOK_URL || '').trim(),
    slackGeneralConfigured: !!(process.env.SLACK_GENERAL_WEBHOOK_URL || '').trim(),
    aiConfigured: !!(process.env.ANTHROPIC_API_KEY || '').trim()
  });
});

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

    const result = await triage(note, DEFAULT_CATEGORIES);

    const ticketFields = { channel, name, email, phone, note, category: result.category, priority: result.priority };
    const hsTicket = await hubspot.createTicket(ticketFields);

    const slackResult = await slack.postTicketNotification({
      ...ticketFields,
      hubspotUrl: hsTicket.url,
      hubspotId: hsTicket.id
    });

    res.json({
      ticketId: hsTicket.id,
      hubspotUrl: hsTicket.url,
      hubspotDryRun: hsTicket.dryRun,
      priority: result.priority,
      category: result.category,
      classifiedBy: result.classifiedBy,
      aiError: result.aiError,
      slack: slackResult
    });
  } catch (e) {
    console.error('[POST /api/tickets] failed:', e);
    res.status(500).json({ error: 'Something went wrong creating your ticket. Please try again.' });
  }
});

app.listen(PORT, () => {
  console.log(`Routing Desk Live listening on port ${PORT}`);
  console.log(`  HubSpot configured: ${hubspot.isConfigured()}`);
  console.log(`  Slack technical webhook (P1+P2): ${!!(process.env.SLACK_TECHNICAL_WEBHOOK_URL || '').trim()}`);
  console.log(`  Slack general webhook (P3): ${!!(process.env.SLACK_GENERAL_WEBHOOK_URL || '').trim()}`);
  console.log(`  AI classification: ${!!(process.env.ANTHROPIC_API_KEY || '').trim()}`);
});
