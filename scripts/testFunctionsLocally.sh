#!/usr/bin/env bash
# Quick sanity checks against the local backend, bypassing Retell entirely.
# Run `npm run dev` in another terminal first.
set -e
BASE="http://localhost:3000"

echo "== health =="
curl -s "$BASE/health"; echo

echo "== search_knowledge_base =="
curl -s -X POST "$BASE/functions/search-knowledge-base" \
  -H "Content-Type: application/json" \
  -d '{"args": {"query": "how much does botox cost"}}'; echo

echo "== check_availability =="
curl -s -X POST "$BASE/functions/check-availability" \
  -H "Content-Type: application/json" \
  -d '{"args": {"service": "Botox"}}'; echo

echo "== capture_lead =="
curl -s -X POST "$BASE/functions/capture-lead" \
  -H "Content-Type: application/json" \
  -d '{"call": {"call_id": "test-call-1"}, "args": {"name": "Jane Doe", "phone": "+15551234567", "treatment_interest": "Botox", "urgency": "this week"}}'; echo

echo "== book_appointment =="
curl -s -X POST "$BASE/functions/book-appointment" \
  -H "Content-Type: application/json" \
  -d '{"call": {"call_id": "test-call-1"}, "args": {"service": "Botox", "start_time": "2026-09-22T14:00:00-07:00", "name": "Jane Doe", "phone": "+15551234567"}}'; echo

echo "== reschedule_appointment =="
curl -s -X POST "$BASE/functions/reschedule-appointment" \
  -H "Content-Type: application/json" \
  -d '{"call": {"call_id": "test-call-1"}, "args": {"phone": "+15551234567", "new_start_time": "2026-09-23T15:00:00-07:00"}}'; echo

echo "== cancel_appointment =="
curl -s -X POST "$BASE/functions/cancel-appointment" \
  -H "Content-Type: application/json" \
  -d '{"args": {"phone": "+15551234567"}}'; echo

echo "== dashboard stats =="
curl -s "$BASE/api/dashboard/stats"; echo
