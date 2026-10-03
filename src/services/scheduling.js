import axios from 'axios';
import { config } from '../config.js';
import { getCachedAvailability, setCachedAvailability } from './cache.js';

const isLive = Boolean(config.calcom.apiKey && config.calcom.eventTypeId);

/**
 * Adapter boundary: this is the ONLY file that talks to the booking backend.
 * Swap the bodies of these three functions for the clinic's real PMS
 * (Boulevard / Zenoti / Mindbody / Vagaro) API and nothing else needs to change.
 */

export async function checkAvailability({ service, dateFrom, dateTo }) {
  const cacheKey = `${service}:${dateFrom}:${dateTo}`;
  const cached = await getCachedAvailability(cacheKey);
  if (cached) return cached;

  let slots;
  if (isLive) {
    const res = await axios.get('https://api.cal.com/v2/slots', {
      headers: { Authorization: `Bearer ${config.calcom.apiKey}`, 'cal-api-version': '2024-09-04' },
      params: { eventTypeId: config.calcom.eventTypeId, start: dateFrom, end: dateTo, timeZone: config.clinicTimezone },
      timeout: 4000,
    });
    // v2 returns { data: { "<date>": [{start, ...}, ...], ... } } - an object keyed by
    // date, not a flat array - flatten it so the rest of the app can treat slots uniformly.
    const raw = res.data?.data ?? {};
    slots = Object.values(raw).flat();
  } else {
    slots = mockSlots(dateFrom);
  }

  // Attach a pre-formatted, human-readable label in the clinic's own timezone alongside the
  // raw ISO start time. The LLM was mis-stating AM as PM when left to convert the ISO
  // timestamp itself on a real call — giving it the exact words to say removes that failure
  // mode instead of hoping its own time-zone math is right every time.
  slots = slots.map((slot) => ({
    ...slot,
    label: new Date(slot.start).toLocaleString('en-US', { timeStyle: 'short', timeZone: config.clinicTimezone }),
  }));

  await setCachedAvailability(cacheKey, slots);
  return slots;
}

export async function bookSlot({ service, startTime, name, phone, email }) {
  if (isLive) {
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
  if (isLive) {
    await axios.post(
      `https://api.cal.com/v2/bookings/${externalBookingId}/cancel`,
      { cancellationReason: reason || 'Patient requested cancellation' },
      { headers: { Authorization: `Bearer ${config.calcom.apiKey}`, 'cal-api-version': '2024-08-13' }, timeout: 6000 }
    );
  }
  return { status: 'cancelled' };
}

function mockSlots(dateFrom) {
  const base = new Date(dateFrom || Date.now());
  base.setHours(9, 0, 0, 0);
  const slots = [];
  for (let day = 0; day < 3; day++) {
    for (const hour of [9, 11, 14, 16]) {
      const d = new Date(base);
      d.setDate(d.getDate() + day);
      d.setHours(hour, 0, 0, 0);
      if (d.getDay() === 0 || d.getDay() === 6) continue; // skip weekends
      slots.push({ start: d.toISOString() });
    }
  }
  return slots.slice(0, 6);
}

export const schedulingMode = isLive ? 'cal.com (live)' : 'mock (no CALCOM_API_KEY set)';
