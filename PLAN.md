# FrontDesk AI — Plan to make it the Voice AI case study

Goal: make this the flagship **Voice AI** project on upperlayerstudio.com — a
working phone receptionist a clinic owner can *hear*, with one result they can
verify, and code a technical buyer can read without finding a problem.

Written 2026-10-04 after reading the README and `src/`.

---

## 0. Where it stands today

**Already strong**
- Retell native LLM with a 4-state flow (greeting → FAQ / qualify-and-book → human escalation)
- Six tools: availability, book, reschedule, cancel, FAQ search, lead capture
- Every integration (Cal.com, HubSpot, Twilio, Qdrant) sits behind an adapter with a mock fallback
- Bland backup integration sharing the same backend
- Call log + dashboard, human transfer, refuses clinical questions
- Honest README ("done vs stub" table) — keep that tone

**Gaps found in the code**
| # | Gap | Where | Risk |
|---|---|---|---|
| G1 | `/functions/*` has no auth — anyone with the URL can book or cancel appointments | `src/server.js`, `src/routes/functions.js` | High |
| G2 | `/dashboard` and `/api/dashboard` are public and show caller names/phones | `src/server.js` | High |
| G3 | Webhook signature check is skipped without a key and mismatches are "processed anyway" | `src/routes/retellWebhook.js:9,24` | High |
| G4 | No tests at all | — | Medium |
| G5 | Never completed a live call (accounts were on verification hold) | README | Blocks the case study |
| G6 | No deployment, `BASE_URL` is an ngrok URL | — | Blocks the demo |
| G7 | No recording-consent message | `retell/prompt.js` | Compliance |
| G8 | Knowledge base is made-up clinic data | `kb/clinicKnowledgeBase.json` | Must be labelled demo |
| G9 | No input validation on tool args (dates, phone numbers) | `src/routes/functions.js` | Medium |

---

## Phase 1 — Make it safe (½–1 day)

- [x] **G1** Shared-secret header on `/functions/*` (Retell custom tools support headers); reject anything else with 401
- [x] **G2** Basic auth (or a token) on `/dashboard` and `/api/dashboard`; mask phone numbers in the UI (`+1 ••• ••• 4821`)
- [x] **G3** Verify the Retell signature against their current docs; **reject** on mismatch in production (`NODE_ENV=production`), only warn in dev
- [x] **G9** Validate tool args with `zod`: ISO dates, E.164 phone, known service names; return a friendly error the agent can read back
- [x] **G7** Add a one-line recording-consent notice to `beginMessage` (was already there)
- [x] Rate-limit `/functions/*` (express-rate-limit) to stop booking spam
- [x] Check `.env` is git-ignored and no key is in git history (`git log -p | grep -i key`)

## Phase 2 — Make it provable (1 day)

- [x] **G4** Tests with `node:test` + `supertest`:
  - each `/functions/*` endpoint in mock mode (book → reschedule → cancel round trip)
  - auth rejects missing/wrong secret
  - `check-availability` 21-day lookahead rule
  - RAG keyword fallback returns the right FAQ
- [x] GitHub Actions: run tests on every push
- [x] Keep `scripts/testFunctionsLocally.sh` as the manual smoke test

## Phase 3 — Make it live (1 day, depends on Retell verification)

- [ ] **G5** ~~Confirm Retell (or Bland) account is verified~~ Switched to **Vapi** (2026-10-05): assistant created via `npm run setup:vapi`, test with "Talk to Assistant" in the Vapi dashboard — needs no phone number
- [ ] **G6** Deploy to Render **free plan** via `render.yaml` (Redis/Qdrant dropped — not needed). Set `BASE_URL`, rerun `npm run setup:vapi`, set `RENDER_URL` repo variable for keep-awake pings
- [x] Persistent storage: free plan has no disk — dashboard log is ephemeral; evidence comes from Vapi call logs + Cal.com (documented in README)
- [ ] Connect **real Cal.com** (a demo event type on your account) so bookings visibly land in a calendar
- [ ] HubSpot + Twilio: real if free tiers allow, otherwise leave mock and say so on the site
- [x] **G8** Rename the KB clinic to an obviously fictional name ("Demo Aesthetics Clinic") so nobody mistakes it for a client — done; agent admits it's a demo if asked

## Phase 4 — Capture the evidence (½ day)

This is what the case study is made of. Do these runs on the deployed build.

- [ ] **Demo call recording, 45–75s**: price question → book Botox next week → confirmation. Record screen + audio (Retell test call + Cal.com tab showing the booking appear)
- [ ] **Second short clip, ~20s**: clinical question → agent declines and offers transfer (shows it's safe)
- [ ] **20 scripted test calls**, then pull from Retell's per-call latency breakdown: median end-to-end response time. This is the headline result
- [ ] **Screenshots (2880×1800, real, no fake browser chrome)**:
  1. Dashboard with stats + call table
  2. Booking in Cal.com
  3. Call transcript + summary in Retell
  4. Retell latency breakdown for one call
  5. Lead in HubSpot (if live)
- [ ] Drop assets in `~/Desktop/project/ai-clinic-receptionist/portfolio/` with a one-line description each

## Phase 5 — Put it on Upper Layer Studio (½ day)

Add an entry to `src/lib/projects.ts` in the studio repo, same shape as Newsbit:

- `slug: "clinic-receptionist"`, `service: "Voice AI"`, `meta Type: "Own product · demo build"` (never client work)
- **Problem**: clinics miss calls after hours and when the front desk is busy; every missed call is a lost booking
- **What I built**: a phone receptionist that answers from the clinic's own information, books / reschedules / cancels in the calendar, logs the lead, texts a confirmation, and hands over to a person for anything clinical
- **Pipeline** (4 steps): Caller speaks → Retell (speech + LLM, fast path) → my backend tools (calendar, FAQ, CRM, SMS) → logged to dashboard
- **Why it's built this way**: Retell owns the latency-critical path; every integration is one swappable adapter (Cal.com → clinic's PMS is one file)
- **Stack**: Retell, Node/Express, Cal.com, HubSpot, Twilio, Qdrant, Redis, SQLite
- **Result**: median response time from the 20 calls, with source "Retell call analytics, N calls, date range"
- **Video**: the 45–75s demo call (like the Newsbit voice clip)
- Link the Voice AI service card to it (`project: "clinic-receptionist"` in `site.ts`)
- Add a line linking to the **voice-assistant** repo as "I also built my own low-latency pipeline" — or add that one as a Lab entry

Then: Upwork portfolio entry (title, role, 600-char description, 5 skills) from the same copy.

---

## Order and effort

| Phase | Effort | Blocker |
|---|---|---|
| 1 Safe | ½–1 day | none |
| 2 Provable | 1 day | none |
| 3 Live | 1 day | none (Vapi, no verification hold) |
| 4 Evidence | ½ day | Phase 3 |
| 5 On the site | ½ day | Phase 4 |

**Total: ~4 days.** Start Phase 1 + 2 now; check the Retell account status in
parallel, since Phase 3 can't start without it.

## Rules for the case study
- Label it a demo build for a fictional clinic. No invented clinic, client, quote or metric.
- Every number comes from a source someone can check (Retell analytics, test runs), with the date.
- Real screenshots and recordings only.
