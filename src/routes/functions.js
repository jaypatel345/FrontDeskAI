import { Router } from 'express';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { checkAvailability, bookSlot, cancelBooking } from '../services/scheduling.js';
import { pushLeadToCrm } from '../services/crm.js';
import { sendConfirmationSms } from '../services/sms.js';
import { searchKnowledgeBase } from '../services/rag.js';
import { insertLead, insertBooking, upsertCall, findLatestBookingByPhone, updateBookingStatus } from '../db.js';

export const functionsRouter = Router();

// Retell posts either { call, name, args } or (if "payload: args only" is on) just the args object.
function extractArgs(req) {
  return req.body?.args ?? req.body ?? {};
}
function extractCallId(req) {
  return req.body?.call?.call_id ?? req.body?.call_id ?? null;
}

const MIN_LOOKAHEAD_DAYS = 21;

functionsRouter.post('/check-availability', async (req, res) => {
  try {
    const { service, date_from, date_to } = extractArgs(req);
    const dateFrom = date_from || new Date().toISOString();

    // The LLM computes date_to itself, and voice LLMs are unreliable at date arithmetic
    // without explicit "today" grounding - a caller asking for "this month" can still end up
    // with a narrow guessed window. Rather than trust it completely, always search at least
    // MIN_LOOKAHEAD_DAYS out so a real opening further away than the LLM guessed isn't missed -
    // this is what turned "no availability the whole month" (when Sept 30 was open) into a
    // real bug rather than a one-off.
    const minDateTo = new Date(new Date(dateFrom).getTime() + MIN_LOOKAHEAD_DAYS * 24 * 3600 * 1000).toISOString();
    const dateTo = date_to && date_to > minDateTo ? date_to : minDateTo;

    const slots = await checkAvailability({ service, dateFrom, dateTo });
    res.json({ available: slots.length > 0, slots: slots.slice(0, 4) });
  } catch (err) {
    console.error('[check-availability]', err.message);
    res.status(200).json({ available: false, error: 'Could not reach the scheduling system right now.' });
  }
});

functionsRouter.post('/book-appointment', async (req, res) => {
  try {
    const { service, start_time, name, phone, email } = extractArgs(req);
    const callId = extractCallId(req);

    if (!service || !start_time || !name || !phone) {
      return res.status(200).json({ success: false, error: 'Missing required booking details (service, start_time, name, phone).' });
    }
    // Cal.com requires a real, deliverable email per booking - there's no safe placeholder to
    // fall back to (see scheduling.js), so ask the caller for one instead of failing opaquely.
    if (!email) {
      return res.status(200).json({ success: false, error: 'Missing email - ask the caller for an email address to send their confirmation to, then try again.' });
    }

    const booking = await bookSlot({ service, startTime: start_time, name, phone, email });

    insertBooking({
      id: nanoid(),
      call_id: callId,
      external_booking_id: booking.externalBookingId,
      service,
      name,
      phone,
      email,
      start_time,
      end_time: null,
      status: booking.status,
      created_at: Date.now(),
    });

    // CRM push and SMS aren't needed to answer the caller — fire them without awaiting so
    // HubSpot/Twilio latency never adds to the spoken response time.
    pushLeadToCrm({ name, phone, email, treatmentInterest: service, budget: null, urgency: 'booked', callId }).catch((e) =>
      console.error('[crm push failed]', e.message)
    );

    const when = new Date(start_time).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: config.clinicTimezone });
    sendConfirmationSms({
      to: phone,
      body: `You're confirmed for ${service} on ${when}. Reply to this text if you need to reschedule. - The Clinic`,
    }).catch((e) => console.error('[sms failed]', e.message));

    res.json({ success: true, confirmed_time: start_time, message: `Booked ${service} for ${when}.` });
  } catch (err) {
    console.error('[book-appointment]', err.message);
    res.status(200).json({ success: false, error: 'Could not complete the booking right now, offer a callback instead.' });
  }
});

functionsRouter.post('/search-knowledge-base', async (req, res) => {
  try {
    const { query } = extractArgs(req);
    const results = await searchKnowledgeBase(query, 3);
    res.json({ results: results.map((r) => ({ topic: r.id, info: r.text })) });
  } catch (err) {
    console.error('[search-knowledge-base]', err.message);
    res.status(200).json({ results: [], error: 'Knowledge base lookup failed.' });
  }
});

functionsRouter.post('/capture-lead', async (req, res) => {
  try {
    const { name, phone, email, treatment_interest, budget, urgency } = extractArgs(req);
    const callId = extractCallId(req);
    const leadId = nanoid();

    insertLead({
      id: leadId,
      call_id: callId,
      name: name || null,
      phone: phone || null,
      email: email || null,
      treatment_interest: treatment_interest || null,
      budget: budget || null,
      urgency: urgency || null,
      created_at: Date.now(),
    });

    if (callId) {
      upsertCall({
        call_id: callId,
        agent_id: null,
        from_number: phone || null,
        to_number: null,
        status: 'in_progress',
        started_at: Date.now(),
        ended_at: null,
        disconnection_reason: null,
        transcript: null,
        recording_url: null,
        intent: treatment_interest || null,
        escalated: 0,
      });
    }

    pushLeadToCrm({ name, phone, email, treatmentInterest: treatment_interest, budget, urgency, callId }).catch((e) =>
      console.error('[crm push failed]', e.message)
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[capture-lead]', err.message);
    res.status(200).json({ success: false });
  }
});

functionsRouter.post('/lookup-appointment', async (req, res) => {
  try {
    const { phone } = extractArgs(req);
    if (!phone) return res.status(200).json({ found: false, error: 'Need the phone number the booking was made under.' });

    const existing = findLatestBookingByPhone(phone);
    if (!existing) return res.json({ found: false });

    const when = new Date(existing.start_time).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: config.clinicTimezone });
    res.json({ found: true, service: existing.service, when });
  } catch (err) {
    console.error('[lookup-appointment]', err.message);
    res.status(200).json({ found: false, error: 'Could not look that up right now.' });
  }
});

functionsRouter.post('/cancel-appointment', async (req, res) => {
  try {
    const { phone } = extractArgs(req);
    if (!phone) return res.status(200).json({ success: false, error: 'Need the phone number the booking was made under.' });

    const existing = findLatestBookingByPhone(phone);
    if (!existing) return res.status(200).json({ success: false, error: 'No upcoming appointment found for that phone number.' });

    await cancelBooking({ externalBookingId: existing.external_booking_id, reason: 'Patient requested cancellation' });
    updateBookingStatus(existing.id, 'cancelled');

    res.json({ success: true, message: `Cancelled the ${existing.service} appointment.` });
  } catch (err) {
    console.error('[cancel-appointment]', err.message);
    res.status(200).json({ success: false, error: 'Could not cancel right now, offer a callback instead.' });
  }
});

functionsRouter.post('/reschedule-appointment', async (req, res) => {
  try {
    const { phone, new_start_time } = extractArgs(req);
    const callId = extractCallId(req);
    if (!phone || !new_start_time) {
      return res.status(200).json({ success: false, error: 'Need the phone number on the booking and the new time.' });
    }

    const existing = findLatestBookingByPhone(phone);
    if (!existing) return res.status(200).json({ success: false, error: 'No upcoming appointment found for that phone number.' });

    await cancelBooking({ externalBookingId: existing.external_booking_id, reason: 'Rescheduled by patient' });
    updateBookingStatus(existing.id, 'cancelled');

    const rebooked = await bookSlot({ service: existing.service, startTime: new_start_time, name: existing.name, phone, email: existing.email });
    insertBooking({
      id: nanoid(),
      call_id: callId,
      external_booking_id: rebooked.externalBookingId,
      service: existing.service,
      name: existing.name,
      phone,
      email: existing.email,
      start_time: new_start_time,
      end_time: null,
      status: rebooked.status,
      created_at: Date.now(),
    });

    const when = new Date(new_start_time).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: config.clinicTimezone });
    sendConfirmationSms({
      to: phone,
      body: `Your ${existing.service} appointment was moved to ${when}. - The Clinic`,
    }).catch((e) => console.error('[sms failed]', e.message));

    res.json({ success: true, message: `Moved your ${existing.service} appointment to ${when}.` });
  } catch (err) {
    console.error('[reschedule-appointment]', err.message);
    res.status(200).json({ success: false, error: 'Could not reschedule right now, offer a callback instead.' });
  }
});

functionsRouter.post('/update-appointment-details', async (req, res) => {
  try {
    const { phone, new_name, new_email, new_phone } = extractArgs(req);
    const callId = extractCallId(req);
    if (!phone) return res.status(200).json({ success: false, error: 'Need the phone number the booking was made under.' });

    const existing = findLatestBookingByPhone(phone);
    if (!existing) return res.status(200).json({ success: false, error: 'No upcoming appointment found for that phone number.' });

    // Cal.com has no endpoint to edit an attendee's name/email/phone directly - only
    // cancel+rebook. Same pattern as reschedule, but the time stays fixed.
    await cancelBooking({ externalBookingId: existing.external_booking_id, reason: 'Updating contact details' });
    updateBookingStatus(existing.id, 'cancelled');

    const name = new_name || existing.name;
    const email = new_email || existing.email;
    const updatedPhone = new_phone || phone;

    const rebooked = await bookSlot({ service: existing.service, startTime: existing.start_time, name, phone: updatedPhone, email });
    insertBooking({
      id: nanoid(),
      call_id: callId,
      external_booking_id: rebooked.externalBookingId,
      service: existing.service,
      name,
      phone: updatedPhone,
      email,
      start_time: existing.start_time,
      end_time: null,
      status: rebooked.status,
      created_at: Date.now(),
    });

    res.json({ success: true, message: 'Updated the details on your appointment.' });
  } catch (err) {
    console.error('[update-appointment-details]', err.message);
    res.status(200).json({ success: false, error: 'Could not update those details right now, offer a callback instead.' });
  }
});
