# Routing Desk Live

A public, customer-facing support site and routing backend:

**Customer reaches out (live chat via Zendesk, or plain email) → priority triage (P1/P2/P3, same rubric as the `support-ticket-priority-triage` skill) → HubSpot ticket created → Slack notified in the right queue → you resolve in HubSpot.**

The homepage (`views/homepage.html`) is a real B2B marketing page — hero, feature grid, "how it works," testimonial — with a **Zendesk live chat widget** and a **support email address** built into a "Talk to us" section. Chat conversations land in Zendesk as tickets; a Zendesk webhook forwards each one here, where it's triaged and routed exactly the same way a ticket submitted any other way would be. There's no custom multi-channel form anymore — Zendesk covers chat, and email is just a `mailto:` link plus your own email handling. Phone/voice intake was explicitly dropped for now.

This replaces the earlier downloadable single-file tool, which ran entirely in the browser and couldn't safely hold a HubSpot token or receive webhooks. This is a small real backend (Node/Express) instead, meant to be deployed somewhere public (Render, by default) so an audience — and real customers — can hit it directly.

## Architecture

```
Customer
  │
  ├─ Live chat (Zendesk widget on the homepage)
  │     └─► Zendesk ticket created
  │           └─► Zendesk trigger fires a webhook ──┐
  │                                                   │
  └─ Email (mailto: link on the homepage)             │
        └─► however you already handle support email  │
                                                        ▼
                                          POST /api/zendesk-webhook  ──┐
                                                                        │
                                          POST /api/tickets (any       │
                                          other direct integration) ───┤
                                                                        ▼
                                                createAndRouteTicket()  (server.js)
                                                   │
                                                   ├─► src/triage.js    → priority (P1/P2/P3) + category, rule-based
                                                   │                        (or real AI if ANTHROPIC_API_KEY is set)
                                                   ├─► src/hubspot.js   → creates the ticket, links/creates the contact,
                                                   │                        notes the originating Zendesk ticket
                                                   └─► src/slack.js     → posts to the Technical (P1/P2) or General (P3)
                                                                            webhook, linking to both the HubSpot ticket
                                                                            and the original Zendesk conversation
```

Both intake paths — the direct API and the Zendesk webhook — funnel through one shared `createAndRouteTicket()` function in `server.js`, so triage, HubSpot creation, and Slack routing behave identically no matter which channel a ticket came in on.

Separately, once a ticket is marked **Solved** in Zendesk, a second trigger can hit `POST /api/zendesk-transcript-sync`, which pulls the full comment thread from the Zendesk API and logs it onto the matching HubSpot ticket as a Note — see 7c below. This is optional and independent of the flow above; without it, HubSpot only ever has the opening message.

Nothing secret ever reaches the browser — the HubSpot token, Slack webhook URLs, Zendesk webhook secret, and (optional) Anthropic key all live only in server environment variables. The Zendesk **widget key** is the one exception: it's meant to be public (it's embedded in every page view), so it's not treated as a secret.

If a credential isn't set yet, that piece quietly runs in "dry run" / "not configured" mode instead of failing — so you can stand the whole app up and click through it locally before any real accounts are wired in.

## 1. Run it locally first (recommended before deploying)

```bash
npm install
cp .env.example .env     # leave everything blank for now — dry-run mode
npm start
```

Visit `http://localhost:3000` — you'll see the homepage. With `.env` blank, the chat widget won't appear (there's a note that live chat isn't connected yet) and the mailto link falls back to `support@example.com`. Hit `http://localhost:3000/api/health` to see which integrations are configured.

Run `npm test` any time to check the triage rules (P1/P2/P3 keyword logic) still behave as expected.

## 2. Create a HubSpot private app (for `HUBSPOT_TOKEN`)

1. Log into HubSpot → the gear icon (Settings) → left sidebar **Integrations → Private Apps**. (HubSpot may steer new portals toward "Service Keys" instead — functionally the same bearer-token auth for our purposes; either works. Private Apps are being retired September 28, 2026, so if you're setting this up after that date, use whichever option HubSpot offers you.)
2. Click **Create a private app**, name it something like "Routing Desk".
3. Go to the **Scopes** tab and add:
   - `tickets` (read + write)
   - `crm.objects.contacts.read`
   - `crm.objects.contacts.write`
4. Click **Create app**, confirm, then copy the access token it shows you (starts with `pat-na1-...` or similar). That's `HUBSPOT_TOKEN` — you only see it once, so save it somewhere safe.

## 3. Find your HubSpot portal ID (for `HUBSPOT_PORTAL_ID`)

While logged into HubSpot, look at the URL: `https://app.hubspot.com/contacts/12345678/...` — the number right after `/contacts/` is your portal ID.

## 4. Ticket pipeline/stage (usually no change needed)

`HUBSPOT_PIPELINE_ID=0` and `HUBSPOT_PIPELINE_STAGE_ID=1` are HubSpot's defaults ("Support Pipeline" → "New") and work for almost every account out of the box. Only look these up if you've customized your ticket pipeline: **Settings → Objects → Tickets → Pipelines**, or call `GET /crm/v3/pipelines/tickets` with your token and read the `id` fields.

## 5. Create the two Slack Incoming Webhooks

Repeat this twice — once for your **Technical (P1 + P2)** channel, once for your **General (P3)** channel:

1. Go to https://api.slack.com/apps → **Create New App → From scratch** → name it, pick your workspace. (You only need to do this app-creation step once; both webhooks can live on the same app.)
2. In the app's sidebar, click **Incoming Webhooks**, toggle it on.
3. Click **Add New Webhook to Workspace**, pick the channel, click **Allow**.
4. Copy the URL it gives you (`https://hooks.slack.com/services/...`).
5. Click **Add New Webhook to Workspace** again and repeat for the second channel.

You'll end up with two different URLs → `SLACK_TECHNICAL_WEBHOOK_URL` (P1 + P2) and `SLACK_GENERAL_WEBHOOK_URL` (P3).

> If your workspace requires admin approval for custom apps, an admin approves it once under **Settings & administration → Manage apps** — after that both webhooks work normally.

## 6. (Optional) Real AI classification

Get a key at https://console.anthropic.com and set `ANTHROPIC_API_KEY`. Unlike the old browser-based tool, it's safe to put this in server env vars — it never reaches a browser. Leave it blank to use keyword-rule classification only (still fully functional, just less nuanced on ambiguous wording).

## 7. Connect Zendesk (chat widget + webhook)

You said you already have a Zendesk account, so this is just wiring it to this app — no new signup needed. Two independent pieces: the **widget** (puts live chat on the homepage) and the **webhook** (sends each new Zendesk ticket here to be triaged, logged in HubSpot, and posted to Slack).

### 7a. Embed the chat widget (`ZENDESK_WIDGET_KEY`)

1. In Zendesk **Admin Center**, go to **Channels → Messaging and social → Messaging**.
2. Open your Web Widget (create one if you don't have one yet — Zendesk will walk you through a couple of quick prompts).
3. Open its **Installation** tab and copy the snippet. You only need the `key=` value out of it, e.g.:
   ```html
   <script id="ze-snippet" src="https://static.zdassets.com/ekr/snippet.js?key=YOUR_WIDGET_KEY"> </script>
   ```
4. Set `ZENDESK_WIDGET_KEY` to `YOUR_WIDGET_KEY`. This value is meant to be public (it ships in every page load), so it's fine to store it plainly — it's not treated as a secret in this app.

Once set, the homepage automatically injects the real widget script and the chat bubble appears; until then, the page shows a "live chat isn't connected yet" note instead.

### 7b. Forward new tickets here (`ZENDESK_WEBHOOK_SECRET`)

This has three parts: a secret, a webhook, and a trigger that fires it.

**Pick a secret.** Make up a long random string yourself (a password manager's generator is fine) — this isn't something Zendesk gives you, it's a shared secret only the two of you know. Set it as `ZENDESK_WEBHOOK_SECRET` in this app's environment. **Don't send this value to me in chat** — enter it directly wherever you're setting environment variables (see step 8).

**Create the webhook.** In Admin Center, go to **Apps and integrations → Webhooks → Webhooks**, click **Create webhook**.
- Name it something like "Routing Desk Live".
- Endpoint URL: `https://<your-deployed-url>/api/zendesk-webhook` (use your real Render URL once you have it — you can come back and fill this in after step 8).
- Request method: `POST`. Request format: `JSON`.
- Authentication: choose **Basic authentication**, username can be anything (e.g. `zendesk`), password = the same secret you put in `ZENDESK_WEBHOOK_SECRET`. (Zendesk itself recommends Basic/Bearer auth over stuffing a secret into a custom header, which is why we're using it here.)
- Save it.

**Create the trigger.** In Admin Center, go to **Objects and rules → Business rules → Triggers**, click **Add trigger**.
- Conditions: **Meet ALL of the following** → add `Ticket > Ticket` **Is** `Created`. This is the condition that fires exactly once, at the moment a ticket is created — not on every update — regardless of whether it came in by chat, email, or anything else.
- Actions: add **Notify active webhook**, pick the webhook you just created, and set the JSON body to:
  ```json
  {
    "ticket_id": "{{ticket.id}}",
    "channel": "{{ticket.via}}",
    "description": "{{ticket.latest_comment}}",
    "requester_name": "{{ticket.requester.name}}",
    "requester_email": "{{ticket.requester.email}}",
    "requester_phone": "{{ticket.requester.phone}}",
    "ticket_link": "{{ticket.link}}"
  }
  ```
- Save it.

From then on, every new Zendesk ticket (chat included) hits `/api/zendesk-webhook`, gets triaged with the same P1/P2/P3 rubric as everything else, becomes a HubSpot ticket noting the originating Zendesk ticket, and posts to the right Slack queue with links to both.

`/api/zendesk-webhook` refuses every request (401) until `ZENDESK_WEBHOOK_SECRET` is set and the incoming Basic-auth password matches, so it's safe to leave the webhook pointed at a not-yet-deployed or not-yet-configured URL.

### 7c. Log the full conversation to HubSpot (optional, `/api/zendesk-transcript-sync`)

Everything above logs a *snapshot* - the opening message, captured the instant the ticket is created. It never hears about anything said afterward, so the HubSpot ticket sits there showing only the first line forever, even after an agent picks it up and resolves it. This step closes that gap: once a ticket is marked **Solved** in Zendesk, this pulls the *entire* comment thread (public replies and internal notes alike) and logs it onto the matching HubSpot ticket as a Note - so the CRM ends up with a record of what actually happened, not just how it started.

This needs three things, on top of what you already set up in 7a/7b:

**A HubSpot ticket property to link on.** The Zendesk ticket ID is already noted in the ticket body text for a human to read, but that's not searchable. Go to HubSpot **Settings → Objects → Tickets → Properties → Create property**, make a single-line text property (call it whatever you like, e.g. "Zendesk Ticket ID"), and set `HUBSPOT_ZENDESK_ID_PROPERTY` in your environment to its **internal name** (shown when you create it, not the display label). From then on, every new ticket `createTicket()` makes will stamp this property automatically - it only works for tickets created *after* you set it, though; anything created earlier has nothing to search on.

**Zendesk API credentials, if you haven't already set these** (`ZENDESK_SUBDOMAIN`, `ZENDESK_API_EMAIL`, `ZENDESK_API_TOKEN`) - Admin Center → Apps and integrations → APIs → Zendesk API → Add API token. `ZENDESK_SUBDOMAIN` is the part before `.zendesk.com` in your Zendesk URL.

**A second webhook + trigger**, same pattern as 7b but pointed at the new endpoint:
- **Webhook** (Admin Center → Apps and integrations → Webhooks → Create webhook): Endpoint URL `https://<your-deployed-url>/api/zendesk-transcript-sync`, method `POST`, format `JSON`, Basic auth with the *same* `ZENDESK_WEBHOOK_SECRET` you already have - no need to manage a second password.
- **Trigger** (Objects and rules → Business rules → Triggers → Add trigger): Conditions → `Ticket > Status` **Changed to** `Solved`. Action → **Notify active webhook**, pick the new webhook, JSON body:
  ```json
  {
    "ticket_id": "{{ticket.id}}"
  }
  ```

Fires on **Solved** rather than on every new message, deliberately - one clean transcript per resolution beats a flood of webhook calls mid-conversation, and "what happened on this ticket" is almost always what you want to know *after* it's done. If a ticket gets reopened and solved again later, that just adds a second Note rather than overwriting the first, so the history stays intact.

Check `transcriptSyncConfigured` at `/api/health` to confirm both halves (the Zendesk API creds and the HubSpot property) are set before wiring up the trigger.

## 8. Push this project to GitHub

```bash
git init
git add .
git commit -m "Routing Desk Live"
```

Create a new empty repository on github.com, then:

```bash
git remote add origin https://github.com/<you>/routing-desk-live.git
git branch -M main
git push -u origin main
```

## 9. Deploy to Render

1. Go to https://render.com and sign in (GitHub sign-in is easiest).
2. **New → Web Service**, connect the repo you just pushed.
3. Render should pick up `render.yaml` automatically. If it asks you to configure manually instead: Build Command `npm install`, Start Command `npm start`, plan **Free**.
4. In the **Environment** tab, fill in the real values for: `HUBSPOT_TOKEN`, `HUBSPOT_PORTAL_ID`, `SLACK_TECHNICAL_WEBHOOK_URL`, `SLACK_GENERAL_WEBHOOK_URL`, `SUPPORT_EMAIL`, `ZENDESK_WIDGET_KEY`, `ZENDESK_WEBHOOK_SECRET`, and `ANTHROPIC_API_KEY` if you're using it.
5. Deploy. After the build finishes (a minute or two), Render gives you a public URL like `https://routing-desk-live.onrender.com` — that's what you share with the audience, and what you plug into the Zendesk webhook's Endpoint URL from step 7b.

Visit `<your-url>/api/health` any time to confirm which integrations are actually configured (`hubspotConfigured`, `slackTechnicalConfigured`, `slackGeneralConfigured`, `zendeskWidgetConfigured`, `zendeskWebhookConfigured`, etc.) without needing to submit a real ticket.

## 10. Before you go on stage

Render's **free** tier spins the service down after 15 minutes of no traffic, and the next request takes 30-50 seconds to wake it back up — awkward mid-demo. A couple of minutes before you present, load the URL yourself (or `curl <your-url>/api/health`) once to warm it up. If you want zero cold-start risk, upgrade that one service to Render's cheapest paid instance type for the day of the demo.

Also worth a dry run: open the homepage, use the chat widget yourself to send a test message, and watch it show up in Slack and HubSpot within a few seconds. That's the whole audience-facing loop in one pass.

## What's built vs. what's next

**Built now:** a real B2B homepage with a Zendesk live-chat widget and a support email address → every chat ticket is forwarded here automatically → priority + category triage → HubSpot ticket creation with a linked contact and a link back to the original Zendesk ticket → Slack notification in the right queue, linking to both HubSpot and Zendesk. You resolve tickets in HubSpot itself. Optionally, once a ticket's marked Solved in Zendesk, its full conversation (not just the opening message) gets logged onto the HubSpot ticket as a Note — see 7c. Phone/voice intake was intentionally left out of this phase.

**Phase 2 (the "nice to have" from our conversation):** resolving a ticket directly from a button inside Slack, which then writes the resolution back to HubSpot automatically. That needs a real Slack bot (not just an incoming webhook) with an Interactivity endpoint Slack can call — happy to build that once the base flow above is live and working for you.
