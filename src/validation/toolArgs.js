import { z } from 'zod';
import { getIndustry } from '../industries/registry.js';
import { SERVICES as CLINIC_SERVICES, canonicalService as clinicCanonicalService } from '../industries/clinic/services.js';

// The default services (clinic) for backward compatibility
export const SERVICES = CLINIC_SERVICES;
export const canonicalService = clinicCanonicalService;

// Turns whatever the LLM heard ("(555) 123-4567", "5551234567", "+44 20 7946 0958") into E.164.
// Bare 10-digit numbers are treated as US/Canada, matching this clinic.
export function toE164(input) {
  const raw = String(input).trim();
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

// LLMs (and Bland's {{input.x}} templating) often send "" for a field they didn't fill -
// treat that the same as leaving it out.
const optional = (schema) => z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional());

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

const isoDateTime = z
  .string({ required_error: 'is required' })
  .trim()
  .refine((v) => ISO_DATETIME.test(v) && !Number.isNaN(Date.parse(v)), {
    message: 'must be an ISO 8601 date-time like 2026-10-12T14:00:00-07:00',
  });

// A minute of slack so a slot that started while the caller was saying "yes" isn't rejected.
// (An unparseable value already failed above, so it passes here to avoid a second, confusing error.)
// For search windows a bare date ("2026-11-23") is fine - LLMs often send one, and rejecting it
// cost a whole extra tool round trip while the caller waited. Start of day for date_from, end of
// day for date_to.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const searchDate = (endOfDay) =>
  z.preprocess(
    (v) => (typeof v === 'string' && DATE_ONLY.test(v.trim()) ? `${v.trim()}T${endOfDay ? '23:59:59' : '00:00:00'}Z` : v),
    isoDateTime
  );

const futureDateTime = isoDateTime.refine((v) => Number.isNaN(Date.parse(v)) || Date.parse(v) > Date.now() - 60 * 1000, {
  message: 'is in the past - pick a time from check_availability',
});

const phone = z
  .string({ required_error: 'is required' })
  .transform((v, ctx) => {
    const e164 = toE164(v);
    if (!e164) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "doesn't look like a full phone number - read it back to the caller and confirm every digit" });
      return z.NEVER;
    }
    return e164;
  });

const DIGIT_WORDS = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
const FREE_MAIL = /^(gmail|googlemail|yahoo|hotmail|outlook|icloud|live|aol|proton|protonmail|rediffmail)$/;

// Turns a spoken email into a real one, in case the agent passes it on as heard:
// "Jay Patel 2 1 0 7 7 6 at the rate gmail dot com" -> "jaypatel210776@gmail.com".
export function normalizeSpokenEmail(input) {
  let v = String(input).trim().toLowerCase();
  if (!v) return v;
  v = v
    .replace(/\s+at\s+the\s+rate(\s+of)?\s+/g, ' @ ')
    .replace(/\s+dot\s+/g, ' . ')
    .replace(/\b(double|triple)\s+(\w+)/g, (_, n, w) => (DIGIT_WORDS[w] ?? w).repeat(n === 'double' ? 2 : 3))
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine)\b/g, (w) => DIGIT_WORDS[w]);
  if (!v.includes('@')) v = v.replace(/\s+at\s+(?=[\w.-]+(\s*\.\s*|\s*$))/, ' @ ');
  v = v.replace(/\s+/g, '');
  const [local, domain] = v.split('@');
  if (domain && FREE_MAIL.test(domain)) v = `${local}@${domain}.com`;
  return v;
}

const email = z.preprocess(
  (v) => (typeof v === 'string' ? normalizeSpokenEmail(v) : v),
  z
    .string({ required_error: 'is required - ask the caller for an email address to send their confirmation to' })
    .email("doesn't look like a valid email - read it back to the caller and ask them to spell the part before the @")
);

// Takes an industry key, or an industry object directly (a personalised demo's own preset).
export function createServiceValidator(industryKey = 'clinic') {
  const industry = industryKey && typeof industryKey === 'object' ? industryKey : getIndustry(industryKey);
  const svcList = industry.services || CLINIC_SERVICES;
  const canonicalFn = industry.canonicalService || clinicCanonicalService;

  return z
    .string({ required_error: 'is required' })
    .transform((v, ctx) => {
      const name = canonicalFn(v);
      if (!name) {
        const errorMsg =
          industry.id === 'clinic'
            ? `"${v}" isn't a service the clinic offers. Offered services: ${svcList.map((s) => s.name).join(', ')}`
            : `"${v}" isn't an offered service. Offered options: ${svcList.map((s) => s.name).join(', ')}`;

        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: errorMsg,
        });
        return z.NEVER;
      }
      return name;
    });
}

const name = z.string({ required_error: 'is required' }).trim().min(1, 'is required').max(100);
const shortText = z.string().trim().max(200);

export function buildSchemas(industryKey = 'clinic') {
  const service = createServiceValidator(industryKey);
  return {
    checkAvailability: z.object({
      service,
      date_from: optional(searchDate(false)),
      date_to: optional(searchDate(true)),
      industry: optional(shortText),
    }),
    bookAppointment: z.object({
      service,
      start_time: futureDateTime,
      name,
      phone,
      email,
      industry: optional(shortText),
    }),
    searchKnowledgeBase: z.object({
      query: z.string({ required_error: 'is required' }).trim().min(1, 'is required').max(500),
      industry: optional(shortText),
    }),
    captureLead: z.object({
      name: optional(name),
      phone: optional(phone),
      email: optional(email),
      treatment_interest: optional(shortText),
      interest: optional(shortText),
      notes: optional(shortText),
      company: optional(shortText),
      budget: optional(shortText),
      urgency: optional(shortText),
      industry: optional(shortText),
    }).transform((data) => ({
      ...data,
      treatment_interest: data.treatment_interest || data.interest || data.notes || null,
    })),
    phoneOnly: z.object({ phone, industry: optional(shortText) }),
    rescheduleAppointment: z.object({ phone, new_start_time: futureDateTime, industry: optional(shortText) }),
    updateAppointmentDetails: z.object({
      phone,
      new_name: optional(name),
      new_email: optional(email),
      new_phone: optional(phone),
      industry: optional(shortText),
    }),
  };
}

// Default clinic schemas for backward compatibility with existing tests and callers
export const schemas = buildSchemas('clinic');

// Returns { data } on success or { error } with a sentence the agent can act on or read back,
// e.g. "phone doesn't look like a full phone number - read it back to the caller...".
export function validateArgs(schema, args) {
  const result = schema.safeParse(args ?? {});
  if (result.success) return { data: result.data };
  const problems = result.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`);
  return { error: `${problems.join('; ')}.` };
}

