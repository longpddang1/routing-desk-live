'use strict';

/**
 * Zendesk REST API client - used to fetch the *real* text of a ticket's
 * first public comment.
 *
 * Why this exists: Zendesk trigger placeholders like {{ticket.description}}
 * and {{ticket.comments_formatted}} are evaluated the instant the "ticket
 * created" trigger fires. For Messaging/chat-channel tickets, the actual
 * customer message has not synced into the ticket's formal comment list
 * yet at that instant - the placeholder only sees an internal system note
 * (something like "Conversation with <name>", marked private). So the
 * webhook payload's "description" field is unreliable for chat tickets.
 *
 * The fix: the trigger only needs to tell us the ticket_id. We then call
 * Zendesk's own API a moment later (with a couple of short retries, since
 * even the API can lag slightly behind ticket creation) to pull the
 * ticket's real comments directly and use the first PUBLIC one as the
 * ticket content.
 *
 * Requires an API token (Admin Center -> Apps and integrations -> APIs ->
 * Zendesk API -> Add API token) plus the admin email it's tied to. Basic
 * auth format Zendesk expects: "{email}/token" as the username, the token
 * itself as the password.
 */

function isConfigured() {
  return !!(
    (process.env.ZENDESK_SUBDOMAIN || '').trim() &&
    (process.env.ZENDESK_API_EMAIL || '').trim() &&
    (process.env.ZENDESK_API_TOKEN || '').trim()
  );
}

function authHeader() {
  const email = (process.env.ZENDESK_API_EMAIL || '').trim();
  const token = (process.env.ZENDESK_API_TOKEN || '').trim();
  const encoded = Buffer.from(`${email}/token:${token}`).toString('base64');
  return `Basic ${encoded}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetches raw comments for a ticket. Returns [] on any failure (never throws). */
async function fetchComments(ticketId) {
  const subdomain = (process.env.ZENDESK_SUBDOMAIN || '').trim();
  if (!subdomain || !ticketId) return [];
  const url = `https://${subdomain}.zendesk.com/api/v2/tickets/${encodeURIComponent(ticketId)}/comments.json`;
  try {
    const resp = await fetch(url, {
      headers: { authorization: authHeader(), 'content-type': 'application/json' }
    });
    if (!resp.ok) {
      console.error(`[zendesk] GET comments failed for ticket ${ticketId}: ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    return Array.isArray(data.comments) ? data.comments : [];
  } catch (e) {
    console.error(`[zendesk] GET comments errored for ticket ${ticketId}:`, e.message);
    return [];
  }
}

/**
 * Returns the plain-text body of the ticket's first PUBLIC comment (the
 * customer's real message), retrying briefly since the comment can lag a
 * second or two behind ticket creation. Returns null if none is found
 * after retrying, or if Zendesk API credentials aren't configured -
 * callers should fall back to the trigger payload's own description in
 * that case.
 */
async function getFirstPublicComment(ticketId, opts) {
  if (!isConfigured() || !ticketId) return null;
  const attempts = (opts && opts.attempts) || 3;
  const delayMs = (opts && opts.delayMs) || 800;

  for (let i = 0; i < attempts; i++) {
    const comments = await fetchComments(ticketId);
    // Comments come back oldest-first from this endpoint; take the first
    // public one, which for a fresh ticket is the customer's own message.
    const publicComment = comments.find((c) => c.public);
    if (publicComment && (publicComment.plain_body || publicComment.body || '').trim()) {
      return (publicComment.plain_body || publicComment.body).trim();
    }
    if (i < attempts - 1) await sleep(delayMs);
  }
  return null;
}

module.exports = { isConfigured, fetchComments, getFirstPublicComment };
