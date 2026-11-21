# FrontDesk AI: faster replies + a personalised demo for every client

## Context

- **FrontDesk AI** (`~/Desktop/project/ai-clinic-receptionist`) is the voice receptionist. It runs on Vapi, with an Express backend on Render (free plan, Oregon).
- **Upper Layer Studio's demo page** (`upper layer studio/src/app/demo/clinic/page.tsx`) starts the same Vapi assistant (`4b2bd285…`). It then replaces the model, prompt and turn timing with its own, and drops the tools. So the demo is slower than FrontDesk, and it makes up appointment times instead of checking them.
- Measured speed (last 15 Vapi calls, Nov 11–19): **~1.5s per turn**. LLM ~530ms, endpointing ~350ms, voice ~280ms, transcriber ~150ms, network ~65ms.
- Goal: (1) make FrontDesk faster (realistic target **~700–800ms**; 500ms needs a speech-to-speech model). (2) Make FrontDesk the only "brain", so that a link like `upperlayerstudio.com/demo/clinic?url=theirclinic.com` gives every prospect a demo built from **their own website**.
- Decisions made: demo bookings use **fake slots** (nothing reaches Cal.com, HubSpot or SMS). Profiles are built **ahead of time by the outreach script, and on demand by the demo page**.

## Baseline (measured 2026-11-21, last 15 Vapi calls, Nov 11–19)

| Stage | Avg | Worst | Target |
|---|---|---|---|
| **Turn (total)** | **~1,500ms** | 2,393ms | **~700–800ms** |
| LLM (gpt-4.1-mini) | ~530ms | 847ms | ~250ms |
| Endpointing | ~350ms | 725ms | ≤ 200ms |
| Voice (Cartesia sonic-3.5) | ~280ms | 840ms | ≤ 200ms |
| Transcriber (Deepgram nova-3) | ~150ms | 985ms | ≤ 150ms |
| Network | ~65ms | — | ~65ms |

Earlier Retell calls (Sept, 33 calls): 1,632ms average.

## Progress

- [x] 0.1 Plan in repo · [x] 0.2 Baseline
- [ ] 1.1 Per-stage timing · [ ] 1.2 Turn timing · [ ] 1.3 Shrink prompt · [ ] 1.4 Model pick · [ ] 1.5 Voice/STT · [ ] 1.6 Tool turns · [ ] 1.7 Lock in
- [ ] 2.1 Site → profile · [ ] 2.2 Storage · [ ] 2.3 API · [ ] 2.4 Demo assistant · [ ] 2.5 Tools per profile · [ ] 2.6 Deploy
- [ ] 3.1 Demo page profile · [ ] 3.2 Simple vapi.start · [ ] 3.3 Outreach links · [ ] 3.4 Check
- [ ] 4 End-to-end verification

**Order:** Phase 0 → 1 (speed) → 2 (FrontDesk demo profiles) → 3 (ULS demo page and outreach) → 4 (end-to-end check). Each step ends with a check, so we know it worked before moving on.

---

## Phase 0: Setup

**0.1 Put this plan in the repo.** Copy this file to `ai-clinic-receptionist/docs/PLAN-latency-and-client-demos.md`, so you can follow progress there. Leave the existing `PLAN.md` alone; it has uncommitted edits of yours.

**0.2 Save the baseline.** Write down today's numbers (1.5s turn, per-stage list above) at the top of the doc. Every later step is compared against them.

---

## Phase 1: Speed (FrontDesk repo)

**1.1 Record the per-stage timing, not just the total.**
- `src/db.js`: add columns `model_ms`, `voice_ms`, `transcriber_ms`, `endpointing_ms` to `calls` (same `ALTER TABLE … try/catch` pattern already in that file).
- `src/routes/vapiWebhook.js` → `handleEndOfCallReport`: save `artifact.performanceMetrics.*LatencyAverage` next to the existing `turnLatencyAverage`.
- `src/public/dashboard.html`: show the 4 numbers per call.
- New `scripts/latencyReport.js` (read-only): pulls the last N calls from the Vapi API (`VAPI_PRIVATE_KEY`) and prints the average of each stage. `npm run latency`.
- Check: `npm test` passes, and one test call shows all 4 numbers on the dashboard.

**1.2 Ship the faster turn timing that's already written.**
- `vapi/assistant.js` already has uncommitted values (`waitSeconds 0.1`, `onNoPunctuation 0.35`, `stopSpeaking numWords 1`). Deploy with `npm run setup:vapi:all`, then make 5 test calls.
- Watch for the agent cutting callers off, especially while they read out phone numbers (`onNumberSeconds 0.4`). If it does, raise that value only.
- Try Vapi's smart endpointing (`smartEndpointingPlan`) on 5 calls and keep whichever is faster without cutting people off.
- Check: endpointing averages ≤ 200ms in `npm run latency`. Commit.

**1.3 Shrink what the LLM reads every turn (biggest win).**
- Today every turn sends ~16k characters (~4k tokens): `src/industries/clinic/prompt.js` (7.9k) plus 10 tool definitions from `retell/tools.js` (10k).
- Prompt: cut the six long "caller mood" examples down to one line each, remove repeated rules, and keep the booking flow and safety rules. Target ≤ 3k characters.
- Tools: shorten each `description` to 1–2 lines and remove repeated parameter explanations. Keep names and schemas the same (Retell and Bland share them, and the tests use them).
- Do the same for `real-estate` and `general-business`.
- Check: `npm test` passes. Run 5 scripted test calls (FAQ, book, reschedule, cancel, ask for a human) and confirm the agent still does each one right. LLM stage drops by ~100–200ms.

**1.4 Pick the fastest model that still calls tools correctly.**
- Compare `gpt-4.1-mini` (current), `gpt-4.1-nano`, `gpt-4o-mini` and one Groq or Gemini Flash option. Switch with `VAPI_MODEL_PROVIDER`/`VAPI_MODEL` in `.env`; no code change is needed (`src/config.js`).
- Lower `temperature` from 0.7 to 0.3–0.4 in `vapi/assistant.js` (shorter, steadier replies).
- Run the same 5 test calls per model. Score: LLM ms, plus whether every tool call was right.
- Check: choose the winner, write the results table into the plan doc, and set it as the default in `config.js`.

**1.5 Voice and transcriber.**
- Prompt rule: "start every reply with a short first sentence (under 8 words)". The voice starts speaking after the first sentence, so a shorter one means sound comes sooner.
- Compare Cartesia `sonic-3.5` with the fastest Cartesia option for the same voice, and keep Deepgram `nova-3`. Look at the spikes (voice up to 840ms, transcriber up to 990ms) and see whether they come from long replies.
- Check: voice ≤ 200ms and transcriber ≤ 150ms on average.

**1.6 Tool-call turns (booking and FAQ).**
- Confirm the GitHub repo variable `RENDER_URL` is set, so `.github/workflows/keep-awake.yml` actually pings Render. Without it, the first call after 15 quiet minutes hits a sleeping server. Moving to Render Starter (~$7/mo) removes the problem for good.
- Pre-fetch calendar slots when a call starts: on `status-update` = `in-progress` in `vapiWebhook.js`, call `checkAvailability` in the background so `check_availability` hits the cache (`src/services/cache.js`, 60s TTL).
- The tools already speak a filler line while they run (`speak_during_execution`), so keep that.
- Check: availability tool replies in < 100ms from cache, and no tool timeouts in 10 calls.

**1.7 Lock it in.**
- `npm test`, commit, and redeploy (`npm run setup:vapi:all`). Update the README and the ULS case study (`case-studies/frontdeskai.md`) with the new measured average.
- **Target:** ~700–800ms average turn.

---

## Phase 2: Per-client demo profiles (FrontDesk repo)

**2.1 Website → clinic profile.** New `src/services/siteProfile.js`:
- Fetch the homepage plus up to 5 internal pages whose links look like services, prices, about, contact or team. Strip HTML to text and cap the size.
- Safety: only `http`/`https`, block private and local IP addresses, use an 8s timeout per page, and set a max page size.
- Send the text to an LLM (OpenAI is already a dependency; needs `OPENAI_API_KEY`) and validate the reply with **zod**. Fields: name, doctor(s), niche, city, address, phone, hours, currency, language, services `[{name, price}]` and 5–10 FAQ facts.
- Turn the profile into knowledge-base entries (`{id, category, text}`), the same shape as `src/industries/clinic/knowledgeBase.json`.

**2.2 Storage.**
- New `demo_profiles` table in `src/db.js` (id, url, profile JSON, created_at). The id is a short hash of the normalised URL, so the same site always gets the same id.
- The Render free plan wipes the database on restart, so a missing id is rebuilt from the URL. Demo links therefore carry `?url=` and never break.

**2.3 API routes.** New `src/routes/demo.js`, mounted in `src/app.js`:
- `POST /demo/profiles {url}` → `{id, profile}` (returns the saved profile if one exists, otherwise builds it).
- `GET /demo/profiles/:id`.
- Called from the browser, so: CORS limited to `upperlayerstudio.com` and localhost, plus a strict rate limit (reuse the `express-rate-limit` setup in `app.js`).

**2.4 A separate demo assistant.**
- In `vapi/assistant.js` add `getVapiDemoAssistant()`. It uses the same tools and Phase 1 speed settings, with a short prompt that has placeholders: `{{clinic_name}}`, `{{doctor}}`, `{{city}}`, `{{services}}`, `{{hours}}`, `{{currency}}`, `{{language}}` and `{{demo_id}}`. It says plainly that this is a demo if asked.
- `npm run setup:vapi:demo` → `vapi/.deployed-assistant-demo.json`.
- Your real phone-line assistant stays untouched.

**2.5 Tools answer from that client's profile.**
- `vapiWebhook.js`: read `demo_id` from the call. First check whether Vapi includes `variableValues` in tool-call webhooks (`message.call.assistantOverrides.variableValues`); if it doesn't, pass it as call `metadata`. Then pass it to `runTool(..., { demoId })`.
- `src/tools/handlers.js`:
  - `search_knowledge_base` → keyword search over the profile's entries (export and reuse `keywordSearch` from `src/services/rag.js`).
  - `check_availability`, `book_appointment`, reschedule and cancel → always use the **mock slots** in `src/services/scheduling.js` (fake times, nothing reaches Cal.com).
  - `capture_lead` → save to the local `leads` table marked as demo, with **no HubSpot and no SMS**.
- Check: new tests in `test/` covering profile parsing with a saved HTML fixture (no network) and demo tool routing (mock slots, no CRM call). `npm test` passes.

**2.6 Deploy.** Add `OPENAI_API_KEY` and the allowed origins to Render env vars (`render.yaml`), deploy, then `curl` `POST /demo/profiles` with 3 real clinic sites and check the profiles look right.

---

## Phase 3: ULS demo page + outreach (Upper Layer Studio repo)

> Read the Next.js guide in `node_modules/next/dist/docs/` before editing, as `AGENTS.md` requires.

**3.1 Demo page loads the profile.** In `src/app/demo/clinic/page.tsx`:
- Read `?url=` or `?id=`, call `POST /demo/profiles` on FrontDesk, and show "Setting up Ava for {clinic}…" while it loads.
- Fill the page (name, doctor, logo, services, city) from the profile.
- Keep the existing query parameters (`name`, `doctor`, `city`, `services`, `fee`, `hours`, `lang`…) as **manual overrides**, so links already emailed keep working. An old link with no `url` builds the same variables from those parameters.

**3.2 Start the call the simple way.**
- `vapi.start(DEMO_ASSISTANT_ID, { variableValues: { ...profile, demo_id } })`.
- **Delete** the `systemPrompt` and the `model`, `startSpeakingPlan` and `stopSpeakingPlan` overrides (~lines 374–463).
- Keep only the voice/transcriber swap for Hindi, Gujarati, Arabic and India English, with `{{language}}` telling the prompt which language to speak.
- Move the hard-coded assistant IDs and the FrontDesk URL into env vars (`NEXT_PUBLIC_FRONTDESK_API_URL`, `NEXT_PUBLIC_VAPI_DEMO_ASSISTANT_ID`).
- First check what the India assistant (`327e…`) has that the clinic one doesn't, then fold it into the demo assistant.

**3.3 Outreach links.**
- In `scripts/uls_outreach.py` (~line 1230), build `demo_link` as `…/demo/clinic?url=<lead website>` (plus `lang`/`country` where already known).
- Before sending, call `POST /demo/profiles` to pre-build the profile, and skip the URL version if it fails (fall back to today's `name=&doctor=` link).
- **Sending volume, pacing, inbox rotation and MX checks stay exactly as they are** (anti-spam policy in `AGENTS.md`).

**3.4 Check.**
- `npm run build` passes.
- Open the demo locally with 3 real clinic URLs plus 1 old-style link. Make a browser call on each: the agent uses the right clinic name, services and prices, offers fake slots and "books" one.
- `/api/track-demo` still fires.

---

## Phase 4: End-to-end verification

1. `npm test` in FrontDesk and `npm run build` in ULS.
2. `npm run latency` over 10 new calls: average turn **≤ ~800ms**, no tool timeouts.
3. Personalised demo: 3 real clinic sites, plus Hindi and Gujarati links. The right facts are spoken, booking uses fake slots, and nothing new appears in Cal.com or HubSpot.
4. Phone line (real assistant): book, reschedule and cancel still go to Cal.com and HubSpot as before.
5. Update the case study and README with the measured numbers; commit each repo separately.

## Critical files

- **FrontDesk:** `vapi/assistant.js`, `src/routes/vapiWebhook.js`, `src/tools/handlers.js`, `src/services/rag.js`, `src/services/scheduling.js`, `src/db.js`, `src/app.js`, `src/industries/*/prompt.js`, `retell/tools.js`, new `src/services/siteProfile.js`, new `src/routes/demo.js`, new `scripts/latencyReport.js`.
- **ULS:** `src/app/demo/clinic/page.tsx`, `scripts/uls_outreach.py`, `case-studies/frontdeskai.md`.
