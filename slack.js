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
 */

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

function ticketMessage(ticket) {
  const tier = (ticket.priority === 'P1' || ticket.priority === 'P2') ? 'Technical' : 'General';
  const lines = [
    `*[${ticket.priority}] New ${ticket.channel} ticket*${ticket.name ? ` from ${ticket.name}` : ''}`,
    [ticket.email, ticket.phone].filter(Boolean).join('  ·  '),
    ticket.category ? `Category: ${ticket.category}` : null,
    ticket.note ? `> ${ticket.note}` : null,
    ticket.hubspotUrl ? `<${ticket.hubspotUrl}|Open in HubSpot>` : (ticket.hubspotId ? `HubSpot ticket: ${ticket.hubspotId} (dry run - no real ticket created)` : null)
  ].filter(Boolean);
  return {
    text: `[${ticket.priority}] New ${tier.toLowerCase()}-queue ticket from ${ticket.name || ticket.email || ticket.phone || 'a customer'}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }
    ]
  };
}

/** Posts a new-ticket notification to the correct queue's webhook. Returns { sent, reason, tier }. */
async function postTicketNotification(ticket) {
  const tier = (ticket.priority === 'P1' || ticket.priority === 'P2') ? 'technical' : 'general';
  const url = webhookForPriority(ticket.priority);
  const res = await postToWebhook(url, ticketMessage(ticket));
  return { ...res, tier };
}

module.exports = { postTicketNotification, postToWebhook, webhookForPriority };
