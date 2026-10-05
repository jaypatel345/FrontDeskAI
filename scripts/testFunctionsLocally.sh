#!/usr/bin/env bash
# Quick sanity checks against the local backend, bypassing Retell entirely.
# Run `npm run dev` in another terminal first.
set -e
BASE="${BASE:-http://localhost:3000}"
# Reads FUNCTIONS_SECRET from your shell or .env so /functions/* calls are authorised.
# Booking times must be in the future (the API rejects past times), so compute them.
BOOK_AT="$(node -e 'const d=new Date();d.setUTCDate(d.getUTCDate()+7);d.setUTCHours(17,0,0,0);console.log(d.toISOString())')"
MOVE_TO="$(node -e 'const d=new Date();d.setUTCDate(d.getUTCDate()+8);d.setUTCHours(18,0,0,0);console.log(d.toISOString())')"
SECRET="${FUNCTIONS_SECRET:-$(grep -E '^FUNCTIONS_SECRET=' .env 2>/dev/null | cut -d= -f2-)}"

echo "== health =="
curl -s "$BASE/health"; echo

echo "== search_knowledge_base =="
curl -s -X POST "$BASE/functions/search-knowledge-base" \
  -H "Content-Type: application/json" -H "x-functions-secret: $SECRET" \
  -d '{"args": {"query": "how much does botox cost"}}'; echo

echo "== check_availability =="
curl -s -X POST "$BASE/functions/check-availability" \
  -H "Content-Type: application/json" -H "x-functions-secret: $SECRET" \
  -d '{"args": {"service": "Botox"}}'; echo

echo "== capture_lead =="
curl -s -X POST "$BASE/functions/capture-lead" \
  -H "Content-Type: application/json" -H "x-functions-secret: $SECRET" \
  -d '{"call": {"call_id": "test-call-1"}, "args": {"name": "Jane Doe", "phone": "+15551234567", "treatment_interest": "Botox", "urgency": "this week"}}'; echo

echo "== book_appointment =="
curl -s -X POST "$BASE/functions/book-appointment" \
  -H "Content-Type: application/json" -H "x-functions-secret: $SECRET" \
  -d '{"call": {"call_id": "test-call-1"}, "args": {"service": "Botox", "start_time": "'"$BOOK_AT"'", "name": "Jane Doe", "phone": "+15551234567", "email": "jane.doe.test@example.org"}}'; echo

echo "== reschedule_appointment =="
curl -s -X POST "$BASE/functions/reschedule-appointment" \
  -H "Content-Type: application/json" -H "x-functions-secret: $SECRET" \
  -d '{"call": {"call_id": "test-call-1"}, "args": {"phone": "+15551234567", "new_start_time": "'"$MOVE_TO"'"}}'; echo

echo "== cancel_appointment =="
curl -s -X POST "$BASE/functions/cancel-appointment" \
  -H "Content-Type: application/json" -H "x-functions-secret: $SECRET" \
  -d '{"args": {"phone": "+15551234567"}}'; echo

echo "== dashboard stats =="
DASH_PASS="${DASHBOARD_PASSWORD:-$(grep -E '^DASHBOARD_PASSWORD=' .env 2>/dev/null | cut -d= -f2-)}"
curl -s -u "admin:$DASH_PASS" "$BASE/api/dashboard/stats"; echo
