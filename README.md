# Routing Desk Live

A public, customer-facing support intake demo:

**Customer submits (email / chat / call) → priority triage (P1/P2/P3, same rubric as the `support-ticket-priority-triage` skill) → HubSpot ticket created → Slack notified in the right queue → you resolve in HubSpot.**

This replaces the earlier downloadable single-file tool. That version ran entirely in your browser, which worked for an internal admin tool but can't safely hold a HubSpot token or receive Slack webhooks — so this is a small real backend (Node/Express) instead, meant to be deployed somewhere public (Render, by default) so an audience can hit it directly during your demo.

## Architecture

```
Customer (browser)
   │  fills out public/index.html
   ▼
POST /api/tickets  (server.js)
   │
   ├─► src/triage.js    → priority (P1/P2/P3) + category, rule-based
   │                        (or real AI if ANTHROPIC_API_KEY is set)
   ├─► src/hubspot.js   → creates the ticket, links/creates the contact
   └─► src/slack.js     → posts to the Technical (P1/P2) or General (P3)
                            webhook, with a link straight to the HubSpot ticket
```

Nothing secret ever reaches the browser — the HubSpot token, Slack webhook URLs, and (optional) Anthropic key all live only in server environment variables.

If a credential isn't set yet, that piece quietly runs in "dry run" mode instead of failing — so you can stand the whole app up and click through it locally before any real accounts are wired in.

## 1. Run it locally first (recommended before deploying)

```bash
npm install
cp .env.example .env     # leave everything blank for now — dry-run mode
npm start
```

Visit `http://localhost:3000`, submit a test ticket, and confirm you get a "Thanks — we've got it" result with a priority/category badge. At this point HubSpot and Slack will both say "dry run" / "no webhook configured" — that's expected until you fill in `.env`.

Run `npm test` any time to check the triage rules (P1/P2/P3 keyword logic) still behave as expected.

## 2. Create a HubSpot private app (for `HUBSPOT_TOKEN`)

1. Log into HubSpot → the gear icon (Settings) → left sidebar **Integrations → Private Apps**.
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

Get a key at https://console.anthropic.com and set `ANTHROPIC_API_KEY`. Unlike the old browser-based tool, it's safe to put this in server env vars — it never reaches the audience's browser. Leave it blank to use keyword-rule classification only (still fully functional, just less nuanced on ambiguous wording).

## 7. Push this project to GitHub

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

## 8. Deploy to Render

1. Go to https://render.com and sign in (GitHub sign-in is easiest).
2. **New → Web Service**, connect the repo you just pushed.
3. Render should pick up `render.yaml` automatically. If it asks you to configure manually instead: Build Command `npm install`, Start Command `npm start`, plan **Free**.
4. In the **Environment** tab, fill in the real values for: `HUBSPOT_TOKEN`, `HUBSPOT_PORTAL_ID`, `SLACK_TECHNICAL_WEBHOOK_URL`, `SLACK_GENERAL_WEBHOOK_URL`, and `ANTHROPIC_API_KEY` if you're using it.
5. Deploy. After the build finishes (a minute or two), Render gives you a public URL like `https://routing-desk-live.onrender.com` — that's what you share with the audience.

Visit `<your-url>/api/health` any time to confirm which integrations are actually configured (`hubspotConfigured`, `slackTechnicalConfigured`, `slackGeneralConfigured`, etc.) without needing to submit a real ticket.

## 9. Before you go on stage

Render's **free** tier spins the service down after 15 minutes of no traffic, and the next request takes 30-50 seconds to wake it back up — awkward mid-demo. A couple of minutes before you present, load the URL yourself (or `curl <your-url>/api/health`) once to warm it up. If you want zero cold-start risk, upgrade that one service to Render's cheapest paid instance type for the day of the demo.

## What's built vs. what's next

**Built now:** customer intake (email/chat/call) → priority + category triage → HubSpot ticket creation with a linked contact → Slack notification in the right queue, linking straight to the HubSpot ticket. You resolve tickets in HubSpot itself.

**Phase 2 (the "nice to have" from our conversation):** resolving a ticket directly from a button inside Slack, which then writes the resolution back to HubSpot automatically. That needs a real Slack bot (not just an incoming webhook) with an Interactivity endpoint Slack can call — happy to build that once the base flow above is live and working for you.
