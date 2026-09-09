'use strict';

/**
 * Slack notifications via Incoming Webhooks.
 *
 * Unlike the old downloadable browser tool, this runs on the server, so
 * there's no CORS workaround needed - a normal fetch() gets Slack's real
 * response back, and we can tell the caller whether delivery actually
 * succeeded instead of just "the request left the browser."
 *
 * Two webhooks map to the two queues:
 *   SLACK_TECHNICAL_WEBHOOK_URL  - P1 and P2 tickets (urgent + degraded)
 *   SLACK_GENERAL_WEBHOOK_URL    - P3 tickets (how-to, billing, minor bugs)
 *
 * Optional:
 *   SLACK_P1_MENTION - "here" or "channel" to ping the queue on P1 only.
 *                      Left unset, nothing is pinged (safer default: a
 *                      demo that cries wolf on every message trains people
 *                      to ignore it).
 */

const PRIORITY_STYLE = {
  P1: { color: '#e01e5a', dot: '🔴', label: 'Urgent' },
  P2: { color: '#ecb22e', dot: '🟠', label: 'Degraded' },
  P3: { color: '#2eb67d', dot: '🟢', label: 'Standard' }
};

function styleFor(priority) {
  return PRIORITY_STYLE[priority] || PRIORITY_STYLE.P3;
}

function webhookForPriority(priority) {
  const url = (priority === 'P1' || priority === 'P2')
    ? process.env.SLACK_TECHNICAL_WEBHOOK_URL
    : process.env.SLACK_GENERAL_WEBHOOK_URL;
  return (url || '').trim() || null;
}

async function postToWebhook(url, payload) {
  if (!url) return { sent: false, reason: 'No webhook URL configured for this queue.' };
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const bodyText = await resp.text().catch(() => '');
    if (!resp.ok) {
      return { sent: false, reason: `Slack responded ${resp.status}: ${bodyText || 'no body'}` };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

/** Slack renders <!here>/<!channel>; anything else is ignored rather than pinged. */
function mentionPrefix(priority) {
  if (priority !== 'P1') return '';
  const who = (process.env.SLACK_P1_MENTION || '').trim().toLowerCase();
  if (who === 'here') return '<!here> ';
  if (who === 'channel') return '<!channel> ';
  return '';
}

/** Anonymous messaging users come through as "Web User 6aa0f588cb48..." - not worth showing. */
function displayName(ticket) {
  const name = (ticket.name || '').trim();
  if (name && !/^web user\s+[0-9a-f]{8,}$/i.test(name)) return name;
  if ((ticket.email || '').trim()) return ticket.email.trim();
  return 'an unidentified visitor';
}

function contactLine(ticket) {
  const parts = [ticket.email, ticket.phone].map((v) => (v || '').trim()).filter(Boolean);
  return parts.length ? parts.join('  ·  ') : '_no contact details captured_';
}

function truncate(s, max) {
  const t = (s || '').trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + '…';
}

function ticketMessage(ticket) {
  const style = styleFor(ticket.priority);
  const who = displayName(ticket);
  const category = ticket.category || 'Uncategorized';
  const receivedTs = Math.floor(Date.now() / 1000);

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${style.dot} ${ticket.priority} · ${category}`,
        emoji: true
      }
    },
    // When AI triage is on, lead with its one-line read. An agent scanning
    // a busy queue gets the gist before deciding whether to read the raw
    // message - which matters most for long email threads.
    ...((ticket.summary || '').trim()
      ? [{ type: 'section', text: { type: 'mrkdwn', text: `*${truncate(ticket.summary, 300)}*` } }]
      : []),
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        // Blockquote keeps the customer's own words visually distinct from
        // our metadata, which is what an agent actually scans for first.
        text: `>>> ${truncate(ticket.note, 2800) || '_no message captured_'}`
      }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*From*\n${who}` },
        { type: 'mrkdwn', text: `*Contact*\n${contactLine(ticket)}` },
        ...((ticket.company || '').trim()
          ? [{
              type: 'mrkdwn',
              // Inferred values are labelled - an agent should know the
              // difference between what the customer said and what we guessed.
              text: `*Company*\n${ticket.company.trim()}${ticket.companyInferred ? '  _(from email domain)_' : ''}`
            }]
          : []),
        { type: 'mrkdwn', text: `*Channel*\n${ticket.channel || 'unknown'}` },
        {
          type: 'mrkdwn',
          text: `*Received*\n<!date^${receivedTs}^{time} {date_short_pretty}|just now>`
        }
      ]
    }
  ];

  const buttons = [];
  if (ticket.hubspotUrl) {
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Open in HubSpot', emoji: false },
      url: ticket.hubspotUrl,
      style: ticket.priority === 'P1' ? 'danger' : 'primary'
    });
  }
  if (ticket.zendeskTicketUrl) {
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: 'View in Zendesk', emoji: false },
      url: ticket.zendeskTicketUrl
    });
  }
  if (buttons.length) {
    blocks.push({ type: 'actions', elements: buttons });
  } else if (ticket.hubspotId) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `HubSpot ticket \`${ticket.hubspotId}\` (dry run — no real ticket created)` }]
    });
  }

  const how = (ticket.classifiedBy || '').startsWith('ai')
    ? 'triaged by AI'
    : 'triaged by keyword rules';
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `${style.label} · ${how}${ticket.zendeskTicketId ? ` · Zendesk #${ticket.zendeskTicketId}` : ''}`
    }]
  });

  // text[] is the notification/fallback line (phone banners, screen readers,
  // and the channel list preview all use this rather than the blocks).
  return {
    text: `${mentionPrefix(ticket.priority)}[${ticket.priority}] ${category} — ${truncate(ticket.note, 120) || 'new ticket'} (from ${who})`,
    attachments: [{ color: style.color, blocks }]
  };
}

/** Posts a new-ticket notification to the correct queue's webhook. Returns { sent, reason, tier }. */
async function postTicketNotification(ticket) {
  const tier = (ticket.priority === 'P1' || ticket.priority === 'P2') ? 'technical' : 'general';
  const url = webhookForPriority(ticket.priority);
  const res = await postToWebhook(url, ticketMessage(ticket));
  return { ...res, tier };
}

module.exports = { postTicketNotification, postToWebhook, webhookForPriority, ticketMessage, PRIORITY_STYLE };
