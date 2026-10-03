# AI Clinic Receptionist (Retell)

Inbound AI receptionist for a U.S. cosmetic clinic: answers FAQs, qualifies leads, books /
reschedules / cancels appointments, pushes to CRM, sends SMS confirmations, and logs every call.

Original project spec: [REQUIREMENTS.md](REQUIREMENTS.md).

## How it's built

- **Voice + LLM turn-taking**: Retell's native `retell-llm` (not a custom WebSocket LLM) — this
  keeps latency low because Retell owns the hot path (ASR → LLM → TTS streaming); our backend only
  handles the specific tool calls (check availability, book, search FAQ, etc).
- **Conversation**: a 4-state machine (`greeting → faq_inquiry / qualify_and_book →
  human_escalation`) defined in [`retell/prompt.js`](retell/prompt.js), tools in
  [`retell/tools.js`](retell/tools.js).
- **Backend**: Node/Express in `src/`, one route per Retell custom tool.
- **RAG**: Qdrant + OpenAI embeddings, `top_k=3`. **Falls back to local keyword search** over
  [`kb/clinicKnowledgeBase.json`](kb/clinicKnowledgeBase.json) if `OPENAI_API_KEY` isn't set — so
  you can test the whole flow before paying for anything.
- **Scheduling**: Cal.com adapter in [`src/services/scheduling.js`](src/services/scheduling.js) —
  swap this one file for the clinic's real PMS (Boulevard/Zenoti/Mindbody/Vagaro) later. **Falls
  back to mock in-memory slots** if `CALCOM_API_KEY` isn't set.
- **CRM**: HubSpot adapter, **falls back to console/SQLite logging** if `HUBSPOT_API_KEY` isn't set.
- **SMS**: Twilio, **falls back to console logging** if Twilio creds aren't set.
- **Storage**: SQLite (via Node's built-in `node:sqlite`, zero native build step) for call logs,
  leads, and bookings — good enough for the MVP dashboard. Swap for AWS RDS/Postgres before real
  production volume.

Every external integration has a mock fallback **by design** — you can run and test the entire
call flow today with zero paid accounts, then flip on real credentials one at a time.

## Backup platform: Bland

Both Retell and Bland put brand-new accounts on hold for manual anti-fraud verification before
allowing live calls — this is industry-standard, not specific to either platform. Rather than
lose time waiting on one, the same backend now supports either:

- [`retell/`](retell) — the primary integration (state machine, tools, `npm run setup:agent`).
- [`bland/`](bland) — a parallel integration (flattened prompt in `bland/prompt.js`, same six
  tools re-expressed in Bland's schema in `bland/tools.js`, `npm run setup:bland-agent`).

**Nothing in `src/` changed to support this** — the `/functions/*` endpoints, scheduling/CRM/SMS/
RAG adapters, database, and dashboard are shared by both, because they were built provider-
agnostic from the start. Whichever platform clears verification first, run its setup script and
you're live; the other stays ready as a fallback.

`npm run setup:bland-agent` writes the full config to `bland/.agent-config.json` regardless of
whether the API call itself succeeds (useful if the account is still on hold — config generation
worked in testing even before verification clears). If you've bought/assigned a number in Bland
(`BLAND_PHONE_NUMBER` in `.env`), it also attempts to attach the config via
`/v1/inbound-number-update`.

Bland's field names in `bland/tools.js`/`setupAgent.js` are built from their documented schema,
but a couple of endpoints (`/v2/tools`, `/api-reference/inbound/update-inbound-number`) 404'd
while researching this, so cross-check against a real payload or their dashboard once your
account clears, the same way `retell/setupAgent.js` tells you to for Retell.

## What's actually done vs. what's still a stub

| Piece | Status |
|---|---|
| Retell agent config (states, prompt, tools) | Done, in code |
| Bland agent config (backup, same tools) | Done, in code — untested live (account also under verification) |
| Booking / reschedule / cancel | Done, against Cal.com adapter (mock fallback) |
| FAQ RAG | Done, against Qdrant (keyword fallback) |
| Lead capture → CRM | Done, against HubSpot (console fallback) |
| SMS confirmation | Done, against Twilio (console fallback) |
| Call logging + dashboard | Done, minimal (stats + call table) |
| Human transfer / escalation | Done, via Retell's native `transfer_call` tool |
| HIPAA BAA | Retell offers self-serve BAA (click-agreements.retellai.com) — **you still need to sign it**, plus BAAs from any other vendor touching PHI |
| Multi-location support | **Not built** — single clinic config only |
| AWS deployment | **Not built** — needs your AWS account; this repo runs anywhere Node runs (see Deploying below) |
| Real clinic data | **Placeholder** — `kb/clinicKnowledgeBase.json` has made-up services/pricing/doctors, replace before going live |

## Setup

```bash
npm install
cp .env.example .env
docker compose up -d        # local Redis + Qdrant (requires Docker Desktop running)
```

Fill in `.env`:
1. `RETELL_API_KEY` — from the Retell dashboard.
2. `RETELL_VOICE_ID` — pick a voice under Dashboard → Voices. For lowest latency + most natural
   sound, use an ElevenLabs Flash v2.5 or Cartesia Sonic voice.
3. `BASE_URL` — a public URL Retell can reach. For local testing, run `ngrok http 3000` and paste
   the `https://...ngrok-free.app` URL here.
4. Everything else (`CALCOM_*`, `HUBSPOT_API_KEY`, `TWILIO_*`, `OPENAI_API_KEY`) is optional — leave
   blank to use mock mode.

Start the backend:
```bash
npm run dev
```

If using real RAG, seed Qdrant once:
```bash
npm run seed:kb
```

Create (or update) the Retell agent from code:
```bash
npm run setup:agent
```
This is idempotent — it writes `retell/.deployed-agent.json` and reuses those IDs on the next run
instead of creating duplicates.

## How to test manually

### 1. Backend only, no Retell involved (fastest sanity check)
```bash
npm run dev                        # terminal 1
bash scripts/testFunctionsLocally.sh   # terminal 2
```
This hits every function endpoint directly with curl — availability, booking, reschedule, cancel,
FAQ search, lead capture — and prints the JSON each one returns. Confirms the backend logic works
before Retell is even in the loop. Check the terminal running `npm run dev` for `[crm:mock]` /
`[sms:mock]` logs showing what would have been sent.

### 2. Dashboard
Open `http://localhost:3000/dashboard` after step 1 — you should see the test call, the booking,
and conversion/escalation stats update live.

### 3. Retell web test call (no phone number needed)
1. Run `ngrok http 3000`, put that URL in `.env` as `BASE_URL`, restart `npm run dev`.
2. `npm run setup:agent`.
3. In the Retell dashboard, open the agent and click **Test Call** (browser-based, uses your
   mic/speakers — no telephony setup required).
4. Try these scripts out loud:
   - *"Hi, how much is Botox?"* → should answer with a price range and pivot to booking.
   - *"I'd like to book a Botox appointment next week"* → should qualify, offer times, collect your
     name/phone, confirm the booking. Check the dashboard afterward.
   - *"Actually can I move my appointment?"* (same phone number as before) → should reschedule.
   - *"I want to cancel"* → should cancel.
   - Say nothing for 5+ seconds mid-call → agent should check in rather than going silent or
     repeating itself verbatim.
   - *"This is ridiculous, let me talk to a person"* → should transfer immediately (will show as
     `escalated: yes` on the dashboard; without a real transfer number configured it'll attempt to
     dial `HUMAN_TRANSFER_NUMBER` from `.env`, so put in a real number you can answer to hear it).
   - Ask something clearly clinical, e.g. *"Is Botox safe with my blood pressure medication?"* →
     should decline to answer and transfer/offer a callback, not guess.
5. In the Retell dashboard's call detail view, check the **latency breakdown** per turn (LLM time,
   TTS time, total) — that's the authoritative source for the <1s target, not anything in this
   repo's dashboard.

### 4. Real phone call
Attach a phone number to the agent (Retell dashboard → Phone Numbers → buy or port a number, then
assign it to this agent) and call it from your own phone. Same test script as above.

### 5. Confirm the mock-vs-live integrations
The `npm run dev` startup log and `/api/dashboard/stats` both print which integrations are live
vs. mocked, e.g.:
```
scheduling: mock (no CALCOM_API_KEY set)
crm:        mock (no HUBSPOT_API_KEY set)
```
Add one real credential at a time to `.env`, restart, and re-run the relevant test from step 1 or
3 to confirm it actually hits the real service before moving to the next one.

## Before going live (compliance)

- Sign Retell's BAA (self-serve, no enterprise contract needed) before any real patient PHI flows
  through it.
- If you turn on OpenAI embeddings for RAG, get a BAA with OpenAI too, or use an embedding
  provider that already covers your existing BAA.
- Twilio and HubSpot both offer BAAs on qualifying plans — confirm before sending real patient
  phone numbers/names through them.
- Keep the knowledge base to ranges and general info only (already the default) — never put a
  specific patient's health info into the KB or general prompt.
- Get informed consent for call recording before go-live (this repo doesn't currently play a
  recording-consent message — add one to `beginMessage` in `retell/prompt.js` if your state
  requires it; several U.S. states are two-party consent).

## Deploying

This is a plain Node/Express app — deploy it anywhere that runs Node 18+ (Fly.io, Render, ECS/
Fargate, EC2, etc). Point managed Redis (e.g. Upstash) and managed Qdrant (Qdrant Cloud) at it via
`REDIS_URL` / `QDRANT_URL`, swap SQLite for RDS/Postgres if call volume grows, and set `BASE_URL`
to your real domain before re-running `npm run setup:agent`.
