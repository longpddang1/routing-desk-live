'use strict';

/**
 * Minimal HubSpot client for creating support tickets and (best-effort)
 * linking them to a contact record. Uses a Private App access token -
 * see README.md for how to create one (Settings -> Integrations ->
 * Private Apps, with the "tickets" and "crm.objects.contacts" scopes).
 *
 * This module only ever runs on the server, so the token never reaches
 * a browser - safe to use even while the intake site is public during
 * a demo.
 *
 * If HUBSPOT_TOKEN isn't set, every function returns a "dry run" result
 * instead of throwing, so the rest of the app (and a local test run)
 * still works before real credentials are wired up.
 */

const HUBSPOT_API = 'https://api.hubapi.com';

function isConfigured() {
  return !!(process.env.HUBSPOT_TOKEN || '').trim();
}

function authHeaders() {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${process.env.HUBSPOT_TOKEN.trim()}`
  };
}

// HubSpot's built-in ticket priority property expects HIGH / MEDIUM / LOW.
const PRIORITY_TO_HUBSPOT = { P1: 'HIGH', P2: 'MEDIUM', P3: 'LOW' };

function ticketUrl(ticketId) {
  const portalId = (process.env.HUBSPOT_PORTAL_ID || '').trim();
  if (!portalId || !ticketId) return null;
  return `https://app.hubspot.com/contacts/${portalId}/ticket/${ticketId}`;
}

async function hsFetch(path, options) {
  const resp = await fetch(HUBSPOT_API + path, {
    ...options,
    headers: { ...authHeaders(), ...(options && options.headers) }
  });
  const bodyText = await resp.text();
  let body = null;
  try { body = bodyText ? JSON.parse(bodyText) : null; } catch (e) { /* non-JSON body */ }
  if (!resp.ok) {
    const msg = (body && (body.message || body.error)) || `HubSpot API error ${resp.status}`;
    const err = new Error(msg);
    err.status = resp.status;
    err.body = body;
    throw err;
  }
  return body;
}

/** Find a contact by email, or create one. Returns the contact id, or null on failure (never throws - contact linking is best-effort). */
async function upsertContact({ email, name, phone, company }) {
  if (!isConfigured()) return { id: 'dry-run-contact', dryRun: true };
  if (!email) return null;
  try {
    const search = await hsFetch('/crm/v3/objects/contacts/search', {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
        limit: 1
      })
    });
    if (search && search.results && search.results.length) {
      return search.results[0].id;
    }
    const [firstname, ...rest] = (name || '').trim().split(/\s+/).filter(Boolean);
    const created = await hsFetch('/crm/v3/objects/contacts', {
      method: 'POST',
      body: JSON.stringify({
        properties: {
          email,
          firstname: firstname || undefined,
          lastname: rest.join(' ') || undefined,
          phone: phone || undefined,
          company: company || undefined
        }
      })
    });
    return created.id;
  } catch (e) {
    console.error('[hubspot] upsertContact failed (continuing without contact link):', e.message);
    return null;
  }
}

async function associateTicketToContact(ticketId, contactId) {
  if (!isConfigured() || !contactId) return;
  try {
    await hsFetch(`/crm/v4/objects/tickets/${ticketId}/associations/default/contacts/${contactId}`, {
      method: 'PUT'
    });
  } catch (e) {
    console.error('[hubspot] associateTicketToContact failed (ticket still created):', e.message);
  }
}

/**
 * Creates a ticket for an incoming support message.
 * fields: { channel, name, email, phone, note, category, priority }
 * Returns { id, url, dryRun }.
 */
async function createTicket(fields) {
  const pipeline = (process.env.HUBSPOT_PIPELINE_ID || '0').trim();
  const stage = (process.env.HUBSPOT_PIPELINE_STAGE_ID || '1').trim();
  const subject = `[${fields.priority}] ${fields.category || 'Uncategorized'} - ${fields.name || fields.email || fields.phone || 'New ticket'}`;
  const content = [
    fields.summary ? `Summary: ${fields.summary}` : null,
    fields.summary ? '' : null,
    fields.note || '',
    '',
    `Channel: ${fields.channel}`,
    fields.email ? `Email: ${fields.email}` : null,
    fields.phone ? `Phone: ${fields.phone}` : null,
    fields.queue ? `Queue: ${fields.queue}` : null,
    fields.company ? `Company: ${fields.company}${fields.companyInferred ? ' (inferred from email domain)' : ''}` : null,
    fields.zendeskTicketId ? `Zendesk ticket: #${fields.zendeskTicketId}` : null,
    fields.zendeskTicketUrl ? `Zendesk link: ${fields.zendeskTicketUrl}` : null
    // Drop only omitted lines (null) - empty strings are intentional blank
    // lines separating the summary, the message, and the metadata block.
  ].filter((line) => line !== null && line !== undefined).join('\n');

  if (!isConfigured()) {
    const id = 'dry-run-' + Date.now();
    return { id, url: null, dryRun: true };
  }

  const properties = {
    subject,
    content,
    hs_pipeline: pipeline,
    hs_pipeline_stage: stage,
    hs_ticket_priority: PRIORITY_TO_HUBSPOT[fields.priority] || 'MEDIUM'
  };

  /* Write the triage category to a HubSpot ticket property so it can be
     filtered, reported on and used in workflows - not just read in the
     subject line. Set HUBSPOT_CATEGORY_PROPERTY to the property's
     internal name (a single-line text property is safest: it accepts any
     category string, so adding categories later needs no HubSpot change).

     If the property doesn't exist or rejects the value, HubSpot 400s the
     whole request - which would mean losing the ticket over a metadata
     field. So we retry once without it rather than fail the ticket. */
  const categoryProperty = (process.env.HUBSPOT_CATEGORY_PROPERTY || '').trim();
  if (categoryProperty && fields.category) {
    properties[categoryProperty] = fields.category;
  }
  // Same pattern for the routing queue (HUBSPOT_QUEUE_PROPERTY), so the
  // owning team is a filterable property rather than buried in the body.
  const queueProperty = (process.env.HUBSPOT_QUEUE_PROPERTY || '').trim();
  if (queueProperty && fields.queue) {
    properties[queueProperty] = fields.queue;
  }

  let created;
  try {
    created = await hsFetch('/crm/v3/objects/tickets', {
      method: 'POST',
      body: JSON.stringify({ properties })
    });
  } catch (e) {
    if ((categoryProperty && properties[categoryProperty] !== undefined)
        || (queueProperty && properties[queueProperty] !== undefined)) {
      console.error(`[hubspot] ticket create failed with custom properties (${e.message}); retrying without them.`);
      delete properties[categoryProperty];
      delete properties[queueProperty];
      created = await hsFetch('/crm/v3/objects/tickets', {
        method: 'POST',
        body: JSON.stringify({ properties })
      });
    } else {
      throw e;
    }
  }

  const contactId = await upsertContact({ email: fields.email, name: fields.name, phone: fields.phone, company: fields.company });
  if (contactId && !(contactId && contactId.dryRun)) {
    await associateTicketToContact(created.id, contactId);
  }

  return { id: created.id, url: ticketUrl(created.id), dryRun: false };
}

module.exports = { isConfigured, createTicket, upsertContact, associateTicketToContact, ticketUrl, PRIORITY_TO_HUBSPOT };
