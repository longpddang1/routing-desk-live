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
  const { comments } = await fetchCommentsWithUsers(ticketId, { includeUsers: false });
  return comments;
}

/**
 * Fetches a ticket's full comment thread, in order - public replies and
 * (by default) internal notes alike, everything Zendesk has for the
 * ticket, not just the first message. Pass `includeUsers: true` (the
 * default) to also side-load the commenting users so callers can turn
 * `author_id` into a name without a second round trip; pass `false` to
 * skip that when only the raw comments are needed (keeps the original
 * getFirstPublicComment() call cheap).
 *
 * Returns { comments: [], users: [] } - empty arrays on any failure,
 * never throws, same "fail quiet" contract as the rest of this module.
 */
async function fetchCommentsWithUsers(ticketId, opts) {
  const includeUsers = !opts || opts.includeUsers !== false;
  const subdomain = (process.env.ZENDESK_SUBDOMAIN || '').trim();
  if (!subdomain || !ticketId) return { comments: [], users: [] };
  const url = `https://${subdomain}.zendesk.com/api/v2/tickets/${encodeURIComponent(ticketId)}/comments.json`
    + (includeUsers ? '?include=users' : '');
  try {
    const resp = await fetch(url, {
      headers: { authorization: authHeader(), 'content-type': 'application/json' }
    });
    if (!resp.ok) {
      console.error(`[zendesk] GET comments failed for ticket ${ticketId}: ${resp.status}`);
      return { comments: [], users: [] };
    }
    const data = await resp.json();
    return {
      comments: Array.isArray(data.comments) ? data.comments : [],
      users: Array.isArray(data.users) ? data.users : []
    };
  } catch (e) {
    console.error(`[zendesk] GET comments errored for ticket ${ticketId}:`, e.message);
    return { comments: [], users: [] };
  }
}

/**
 * Renders a ticket's comment thread as a plain-text transcript, oldest
 * first - "<when> — <who> [internal note if private]: <body>", blank
 * line between turns. Internal notes are included (marked as such)
 * rather than dropped, since "what did the agent try/say internally"
 * is often exactly what you want in the CRM record later.
 */
function formatTranscript(comments, users) {
  const nameById = new Map((users || []).map((u) => [u.id, u.name || u.email || `User ${u.id}`]));
  return (comments || [])
    .map((c) => {
      const who = nameById.get(c.author_id) || `User ${c.author_id || 'unknown'}`;
      const when = c.created_at ? new Date(c.created_at).toLocaleString() : '';
      const visibility = c.public === false ? ' [internal note]' : '';
      const body = (c.plain_body || c.body || '').trim();
      return `${when} — ${who}${visibility}:\n${body}`;
    })
    .join('\n\n');
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

module.exports = { isConfigured, fetchComments, fetchCommentsWithUsers, formatTranscript, getFirstPublicComment };
