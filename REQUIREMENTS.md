# Project Requirements — AI Clinic Receptionist

Original spec as given. See [README.md](README.md) for what's actually implemented, what's
mocked vs. live, and how to test — this file is the source-of-truth requirement, kept verbatim
for reference.

## Objective

Build an AI receptionist for a U.S. cosmetic clinic that answers calls, qualifies patients, books
appointments, and handles FAQs with near-zero latency and strict compliance.

## Core Stack

- Voice Layer: Retell (ElevenLabs/Cartesia voice providers)
- LLM: fast model for live calls (gpt-4o-mini default)
- Orchestration: custom Node backend
- Scheduling: Cal.com / clinic PMS API
- CRM: HubSpot
- Telephony: Retell (Twilio-backed number provisioning)
- Memory: Redis cache + vector DB (Qdrant)
- Storage: AWS (HIPAA-ready configs)

## Call Flow (must implement exactly)

1. Incoming call → Retell answers instantly
2. Greet + identify intent (booking / inquiry / support)
3. Real-time transcription → partial streaming to LLM
4. Parallel:
   - Intent classification
   - RAG fetch (clinic data, services, pricing ranges)
5. Response streamed back to caller (no full-response wait)
6. If booking:
   - Check availability via API
   - Confirm slot
   - Capture details (name, phone, email)
7. Push to CRM
8. Send SMS/email confirmation
9. End call or escalate to human if needed

**Latency target: <1 second response start**

## Prompt / Agent Behavior

- Speak like a professional U.S. clinic receptionist
- No long answers
- Always guide toward booking
- Never hallucinate pricing or medical claims
- If unsure → transfer or offer callback
- Maintain structured conversation (intent → qualify → convert)

## Knowledge Base (RAG)

Include:
- Services: Botox, fillers, laser, skin treatments
- Pricing ranges (not exact unless verified)
- Doctor profiles
- Clinic hours, location
- Pre/post treatment instructions
- FAQs (pain, recovery, side effects)

Top_k: 2 or 3 only (keep latency low)

## Key Features to Build

- Appointment booking + rescheduling + cancellation
- Lead qualification (budget, treatment interest, urgency)
- Multi-location support
- SMS follow-up automation
- Call recording + transcript logging
- Dashboard: call logs, conversion rate, missed calls

## Compliance

- HIPAA-safe handling of patient data
- No diagnosis or medical advice
- Store minimal sensitive data
- Consent before recording calls

## Edge Case Handling

- Silence > 3 sec → reprompt
- Confusion → simplify question
- Angry user → escalate immediately
- Complex medical query → human transfer

## Developer Deliverables

- Retell agent configured with streaming
- Backend APIs (booking, CRM push, logging)
- Prompt + fallback flows
- RAG pipeline (Qdrant + embeddings)
- Admin dashboard
- Deployment on AWS (secure setup)

## Metrics to Track

- Call answer rate
- Booking conversion %
- Avg response latency
- Drop-off rate
- Human escalation %

## Non-negotiable Constraints

- No delay pipelines (no full transcription wait)
- No heavy prompts (>1000 tokens)
- No large RAG fetch
- Everything streaming, parallel execution

## Output Expected From Developer

- Working inbound call flow
- Test numbers
- Live booking integration
- CRM sync
- Demo with real-time conversation
