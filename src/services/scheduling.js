import axios from 'axios';
import { config } from '../config.js';
import { getCachedAvailability, setCachedAvailability } from './cache.js';

const isLive = Boolean(config.calcom.apiKey && config.calcom.eventTypeId);

/**
 * Adapter boundary: this is the ONLY file that talks to the booking backend.
 * Swap the bodies of these three functions for the clinic's real PMS
 * (Boulevard / Zenoti / Mindbody / Vagaro) API and nothing else needs to change.
 */

// Cal.com's slot list doesn't depend on the service (one event type), so fetch one window of
// WINDOW_DAYS from today and filter it per request. Keyed by date only: the old key included the
// exact dateFrom timestamp, which differs on every call, so the cache never actually hit and every
// check_availability paid the full Cal.com round trip (~1.5s).
const WINDOW_DAYS = 35;
const inflight = new Map();

async function liveWindow() {
  const day = new Date().toISOString().slice(0, 10);
  const key = `calcom-window:${day}`;
  const cached = await getCachedAvailability(key);
  if (cached) return cached;
  // A prefetch at call start and the first real lookup can overlap - share one request.
  if (inflight.has(key)) return inflight.get(key);

  const request = (async () => {
    const start = new Date().toISOString();
    const end = new Date(Date.now() + WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
    const slots = await fetchCalcomSlots(start, end);
    await setCachedAvailability(key, slots);
    return slots;
  })().finally(() => inflight.delete(key));
  inflight.set(key, request);
  return request;
}

async function fetchCalcomSlots(start, end) {
  const res = await axios.get('https://api.cal.com/v2/slots', {
    headers: { Authorization: `Bearer ${config.calcom.apiKey}`, 'cal-api-version': '2024-09-04' },
    params: { eventTypeId: config.calcom.eventTypeId, start, end, timeZone: config.clinicTimezone },
    timeout: 4000,
  });
  // v2 returns { data: { "<date>": [{start, ...}, ...], ... } } - an object keyed by
  // date, not a flat array - flatten it so the rest of the app can treat slots uniformly.
  const raw = res.data?.data ?? {};
  return Object.values(raw).flat();
}

// Warm the cache when a call starts, so the caller's first availability question is answered
// from memory instead of waiting on Cal.com. Fire-and-forget; errors just mean a cold lookup later.
export function prefetchAvailability() {
  if (!isLive) return;
  liveWindow().catch((e) => console.error('[availability prefetch failed]', e.message));
}

// `mock` forces fake slots (personalised website demos never touch the real calendar); `timeZone`
// is the business's own zone, for the spoken labels.
export async function checkAvailability({ service, dateFrom, dateTo, mock = false, timeZone = config.clinicTimezone }) {
  let slots;
  if (isLive && !mock) {
    const from = Date.parse(dateFrom);
    const to = Date.parse(dateTo);
    const windowEnd = Date.now() + WINDOW_DAYS * 24 * 3600 * 1000;
    const all = to <= windowEnd ? await liveWindow() : await fetchCalcomSlots(dateFrom, dateTo);
    slots = all.filter((slot) => {
      const t = Date.parse(slot.start);
      return t >= from && t <= to;
    });
  } else {
    slots = mockSlots(dateFrom, timeZone);
  }

  // Attach a pre-formatted, human-readable label in the clinic's own timezone alongside the
  // raw ISO start time. The LLM was mis-stating AM as PM when left to convert the ISO
  // timestamp itself on a real call — giving it the exact words to say removes that failure
  // mode instead of hoping its own time-zone math is right every time.
  return slots.map((slot) => ({
    ...slot,
    label: new Date(slot.start).toLocaleString('en-US', { timeStyle: 'short', timeZone }),
  }));
}

export async function bookSlot({ service, startTime, name, phone, email, mock = false }) {
  if (isLive && !mock) {
    const res = await axios.post(
      'https://api.cal.com/v2/bookings',
      {
        eventTypeId: Number(config.calcom.eventTypeId),
        start: startTime,
        // Cal.com requires a deliverable-looking email (validates the domain's MX record) and
        // rejects reserved domains like example.com outright. A made-up address on a real
        // provider (gmail.com etc.) would pass that check but risks emailing a real stranger's
        // actual mailbox a patient's booking details - so email is a required caller input
        // upstream (see functions.js) rather than defaulted here.
        attendee: { name, email, phoneNumber: phone, timeZone: config.clinicTimezone },
        metadata: { service, source: 'ai-receptionist' },
      },
      // /v2/bookings needs its own pinned version - Cal.com's v2 API versions per-endpoint,
      // and the wrong value here 404s as if the route doesn't exist rather than erroring clearly.
      { headers: { Authorization: `Bearer ${config.calcom.apiKey}`, 'cal-api-version': '2024-08-13' }, timeout: 6000 }
    );
    const booking = res.data?.data ?? res.data;
    return { externalBookingId: String(booking.uid ?? booking.id), startTime, status: 'confirmed' };
  }

  return { externalBookingId: `MOCK-${Date.now()}`, startTime, status: 'confirmed' };
}

export async function cancelBooking({ externalBookingId, reason }) {
  // Mock bookings (demos, or no Cal.com configured) were never created there.
  if (isLive && !String(externalBookingId).startsWith('MOCK-')) {
    await axios.post(
      `https://api.cal.com/v2/bookings/${externalBookingId}/cancel`,
      { cancellationReason: reason || 'Patient requested cancellation' },
      { headers: { Authorization: `Bearer ${config.calcom.apiKey}`, 'cal-api-version': '2024-08-13' }, timeout: 6000 }
    );
  }
  return { status: 'cancelled' };
}

// Mock slots are clinic wall-clock times (9am, 11am, 2pm, 4pm in CLINIC_TIMEZONE) - building them
// with the server's own local time made them come out at e.g. 1:30 AM clinic time on a server in
// another time zone. Slots already in the past are skipped, same as a real calendar would.
function mockSlots(dateFrom, tz = config.clinicTimezone) {
  const from = Math.max(Date.parse(dateFrom) || Date.now(), Date.now());
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(from)
    .split('-')
    .map(Number);

  const slots = [];
  for (let day = 0; slots.length < 6 && day < 14; day++) {
    const weekday = new Date(Date.UTC(y, m - 1, d + day)).getUTCDay();
    if (weekday === 0 || weekday === 6) continue; // skip weekends
    for (const hour of [9, 11, 14, 16]) {
      const start = clinicTimeToUtc(y, m - 1, d + day, hour, tz);
      if (start > from) slots.push({ start: new Date(start).toISOString() });
    }
  }
  return slots.slice(0, 6);
}

// UTC ms for a wall-clock time in `tz`. Done twice so a DST change between the guess and the
// real instant still lands on the right hour.
function clinicTimeToUtc(year, monthIndex, day, hour, tz) {
  const wallClockAsUtc = Date.UTC(year, monthIndex, day, hour);
  let utc = wallClockAsUtc;
  for (let i = 0; i < 2; i++) utc = wallClockAsUtc - tzOffsetMs(utc, tz);
  return utc;
}

function tzOffsetMs(utcMs, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(utcMs)
      .map((p) => [p.type, Number(p.value)])
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

export const schedulingMode = isLive ? 'cal.com (live)' : 'mock (no CALCOM_API_KEY set)';
