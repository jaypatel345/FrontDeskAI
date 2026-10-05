import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { checkAvailability, bookSlot, cancelBooking } from '../services/scheduling.js';
import { pushLeadToCrm } from '../services/crm.js';
import { sendConfirmationSms } from '../services/sms.js';
import { searchKnowledgeBase } from '../services/rag.js';
import { schemas, validateArgs } from '../validation/toolArgs.js';
import { insertLead, insertBooking, upsertCall, findLatestBookingByPhone, updateBookingStatus } from '../db.js';

/**
 * The receptionist's tools, independent of which voice platform calls them. Retell/Bland hit
 * one HTTP route per tool (src/routes/functions.js); Vapi batches calls into one webhook
 * (src/routes/vapiWebhook.js). Both end up in runTool() below, so behaviour can't drift apart.
 *
 * Each tool has:
 *   schema  - zod schema for its arguments
 *   invalid - the response shape for a validation error (read back to the agent)
 *   failed  - the response when something throws (scheduling down, etc.)
 *   run     - (validated args, { callId }) => response object
 */

const MIN_LOOKAHEAD_DAYS = 21;

// The LLM computes date_to itself, and voice LLMs are unreliable at date arithmetic
// without explicit "today" grounding - a caller asking for "this month" can still end up
// with a narrow guessed window. Rather than trust it completely, always search at least
// MIN_LOOKAHEAD_DAYS out so a real opening further away than the LLM guessed isn't missed -
// this is what turned "no availability the whole month" (when Sept 30 was open) into a
// real bug rather than a one-off. Compared as timestamps, not strings: "...-07:00" and "...Z"
// values don't sort correctly as text.
export function searchWindowEnd(dateFrom, dateTo) {
  const minDateTo = new Date(Date.parse(dateFrom) + MIN_LOOKAHEAD_DAYS * 24 * 3600 * 1000).toISOString();
  return dateTo && Date.parse(dateTo) > Date.parse(minDateTo) ? dateTo : minDateTo;
}

const spokenTime = (iso, dateStyle = 'medium') =>
  new Date(iso).toLocaleString('en-US', { dateStyle, timeStyle: 'short', timeZone: config.clinicTimezone });

const NO_BOOKING = { success: false, error: 'No upcoming appointment found for that phone number.' };

export const tools = {
  check_availability: {
    schema: schemas.checkAvailability,
    invalid: (error) => ({ available: false, error }),
    failed: { available: false, error: 'Could not reach the scheduling system right now.' },
    async run({ service, date_from, date_to }) {
      const dateFrom = date_from || new Date().toISOString();
      const dateTo = searchWindowEnd(dateFrom, date_to);
      const slots = await checkAvailability({ service, dateFrom, dateTo });
      return { available: slots.length > 0, slots: slots.slice(0, 4) };
    },
  },

  book_appointment: {
    // Cal.com requires a real, deliverable email per booking - there's no safe placeholder to
    // fall back to (see scheduling.js), so the schema makes the agent ask the caller for one.
    schema: schemas.bookAppointment,
    invalid: (error) => ({ success: false, error }),
    failed: { success: false, error: 'Could not complete the booking right now, offer a callback instead.' },
    async run({ service, start_time, name, phone, email }, { callId }) {
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

      const when = spokenTime(start_time);
      sendConfirmationSms({
        to: phone,
        body: `You're confirmed for ${service} on ${when}. Reply to this text if you need to reschedule. - The Clinic`,
      }).catch((e) => console.error('[sms failed]', e.message));

      return { success: true, confirmed_time: start_time, message: `Booked ${service} for ${when}.` };
    },
  },

  search_knowledge_base: {
    schema: schemas.searchKnowledgeBase,
    invalid: (error) => ({ results: [], error }),
    failed: { results: [], error: 'Knowledge base lookup failed.' },
    async run({ query }) {
      const results = await searchKnowledgeBase(query, 3);
      return { results: results.map((r) => ({ topic: r.id, info: r.text })) };
    },
  },

  capture_lead: {
    schema: schemas.captureLead,
    invalid: (error) => ({ success: false, error }),
    failed: { success: false },
    async run({ name, phone, email, treatment_interest, budget, urgency }, { callId }) {
      insertLead({
        id: nanoid(),
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

      return { success: true };
    },
  },

  lookup_appointment: {
    schema: schemas.phoneOnly,
    invalid: (error) => ({ found: false, error }),
    failed: { found: false, error: 'Could not look that up right now.' },
    async run({ phone }) {
      const existing = findLatestBookingByPhone(phone);
      if (!existing) return { found: false };
      return { found: true, service: existing.service, when: spokenTime(existing.start_time, 'full') };
    },
  },

  cancel_appointment: {
    schema: schemas.phoneOnly,
    invalid: (error) => ({ success: false, error }),
    failed: { success: false, error: 'Could not cancel right now, offer a callback instead.' },
    async run({ phone }) {
      const existing = findLatestBookingByPhone(phone);
      if (!existing) return NO_BOOKING;

      await cancelBooking({ externalBookingId: existing.external_booking_id, reason: 'Patient requested cancellation' });
      updateBookingStatus(existing.id, 'cancelled');

      return { success: true, message: `Cancelled the ${existing.service} appointment.` };
    },
  },

  reschedule_appointment: {
    schema: schemas.rescheduleAppointment,
    invalid: (error) => ({ success: false, error }),
    failed: { success: false, error: 'Could not reschedule right now, offer a callback instead.' },
    async run({ phone, new_start_time }, { callId }) {
      const existing = findLatestBookingByPhone(phone);
      if (!existing) return NO_BOOKING;

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

      const when = spokenTime(new_start_time);
      sendConfirmationSms({
        to: phone,
        body: `Your ${existing.service} appointment was moved to ${when}. - The Clinic`,
      }).catch((e) => console.error('[sms failed]', e.message));

      return { success: true, message: `Moved your ${existing.service} appointment to ${when}.` };
    },
  },

  update_appointment_details: {
    schema: schemas.updateAppointmentDetails,
    invalid: (error) => ({ success: false, error }),
    failed: { success: false, error: 'Could not update those details right now, offer a callback instead.' },
    async run({ phone, new_name, new_email, new_phone }, { callId }) {
      const existing = findLatestBookingByPhone(phone);
      if (!existing) return NO_BOOKING;

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

      return { success: true, message: 'Updated the details on your appointment.' };
    },
  },
};

// Validates, runs, and never throws: every outcome is a plain object the agent can read, because a
// voice platform that gets an HTTP error just goes quiet instead of telling the caller anything.
export async function runTool(name, args, { callId = null } = {}) {
  const tool = tools[name];
  if (!tool) return { success: false, error: `Unknown tool "${name}".` };

  const { data, error } = validateArgs(tool.schema, args);
  if (error) return tool.invalid(error);

  try {
    return await tool.run(data, { callId });
  } catch (err) {
    console.error(`[${name}]`, err.message);
    return tool.failed;
  }
}
