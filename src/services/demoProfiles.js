import { getDemoProfileRow, saveDemoProfileRow } from '../db.js';
import { getIndustry } from '../industries/registry.js';
import { keywordSearch } from './rag.js';
import { buildSiteProfile, demoIdForUrl, normalizeSiteUrl, profileSchema, profileToKnowledgeBase, profileFactsLine } from './siteProfile.js';

/**
 * Personalised demos: one profile per prospect website, used by the demo assistant's prompt
 * variables (set by the Upper Layer Studio demo page) and by its tools (knowledge base answers,
 * fake slots). Profiles live in SQLite; Render's free plan wipes that on restart, so any profile
 * can be rebuilt from its URL - demo links carry the URL and never go stale.
 */

const inflight = new Map();
// Vapi call id -> demo id, registered by the demo page right after the call starts. A fallback
// for tool calls whose webhook doesn't carry the call's variableValues.
const callDemoIds = new Map();
const CALL_MAP_TTL_MS = 2 * 60 * 60 * 1000;

const PLACEHOLDER_DOCTORS = /^(doctor|dr\.?|team|owner|manager|sir|madam)$/i;

// Details from the demo link (business name, city...) - the outreach sheet is usually more
// accurate than a scrape for these, so they win when given.
export function applyOverrides(profile, overrides = {}) {
  const o = Object.fromEntries(Object.entries(overrides).filter(([, v]) => typeof v === 'string' && v.trim()));
  const doctors = o.doctor && !PLACEHOLDER_DOCTORS.test(o.doctor.trim()) ? [o.doctor.trim(), ...profile.doctors.filter((d) => d !== o.doctor.trim())] : profile.doctors;
  return {
    ...profile,
    name: o.name || profile.name,
    city: o.city || profile.city,
    niche: o.niche || profile.niche,
    language: o.language || profile.language,
    doctors,
  };
}

// Used when the site can't be read (blocks bots, is down): a profile from the link details alone.
export function fallbackProfile({ url = '', name, city, niche, doctor, language } = {}) {
  let host = '';
  try {
    host = url ? normalizeSiteUrl(url).hostname.replace(/^www\./, '') : '';
  } catch {
    // ignore - just no hostname
  }
  return profileSchema.parse(
    applyOverrides(
      { url, name: name || host || 'our clinic', niche: 'clinic', doctors: [], services: [], faqs: [], source: 'heuristic' },
      { city, niche, doctor, language }
    )
  );
}

export async function getOrBuildDemoProfile({ url, id, overrides = {} } = {}) {
  const demoId = url ? demoIdForUrl(url) : id;
  if (!demoId) throw new Error('url or id is required');

  const row = getDemoProfileRow(demoId);
  if (row) return { id: demoId, profile: applyOverrides(row.profile, overrides), cached: true };
  if (!url) return null;

  if (!inflight.has(demoId)) {
    inflight.set(
      demoId,
      (async () => {
        let profile;
        let error = null;
        try {
          profile = await buildSiteProfile(url);
        } catch (e) {
          // A refused address is the caller's mistake (or abuse) - don't save anything for it.
          if (/not allowed|unsupported|only http/i.test(e.message)) throw e;
          error = e.message;
          profile = fallbackProfile({ url, ...overrides });
        }
        saveDemoProfileRow({ id: demoId, url: normalizeSiteUrl(url).toString(), profile });
        return { profile, error };
      })().finally(() => inflight.delete(demoId))
    );
  }
  const { profile, error } = await inflight.get(demoId);
  return { id: demoId, profile: applyOverrides(profile, overrides), cached: false, error };
}

export function registerDemoCall(callId, demoId) {
  callDemoIds.set(callId, { demoId, at: Date.now() });
  for (const [k, v] of callDemoIds) if (Date.now() - v.at > CALL_MAP_TTL_MS) callDemoIds.delete(k);
}

export function demoIdForCall(callId) {
  return callDemoIds.get(callId)?.demoId || null;
}

// Prompt variables for the demo assistant (filled in by Vapi's {{...}} templating).
export function demoVariables(id, profile) {
  return {
    demo_id: id,
    demo_url: profile.url,
    clinic_name: profile.name,
    niche: profile.niche,
    city: profile.city || 'town',
    doctor: profile.doctors[0] || 'our doctor',
    currency: profile.currency,
    timezone: profile.timezone,
    language: profile.language,
    clinic_facts: profileFactsLine(profile),
  };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * An industry preset for one demo clinic: the clinic preset with this clinic's own services,
 * knowledge base and timezone. Any service the caller names is accepted (mapped onto the
 * clinic's own list when it matches) - a demo should never refuse a treatment the site offers
 * but the scrape missed.
 */
export function makeDemoIndustry(profile) {
  const clinic = getIndustry('clinic');
  const services = [
    ...profile.services.map((s) => ({ name: s.name, match: new RegExp(escapeRegex(s.name.split(/\s+/)[0]), 'i') })),
    { name: 'Consultation', match: /consult/i },
  ];
  const knowledgeBase = profileToKnowledgeBase(profile);
  return {
    ...clinic,
    id: 'clinic',
    businessName: profile.name,
    location: profile.city,
    timezone: profile.timezone,
    services,
    canonicalService: (input) => {
      if (!input) return null;
      const match = services.find((s) => s.match.test(input));
      return match ? match.name : String(input).trim().slice(0, 80);
    },
    knowledgeBase,
    searchKnowledgeBase: (query, topK = 3) => keywordSearch(query, topK, knowledgeBase),
  };
}

// Resolves the demo for a Vapi webhook: by id (variableValues or the call registry), rebuilt from
// demo_url if this server restarted, or - as a last resort - from the prompt variables alone.
export async function resolveDemo({ callId, variables = {} }) {
  const id = variables.demo_id || (callId && demoIdForCall(callId)) || null;
  let found = null;
  if (variables.demo_url) {
    found = await getOrBuildDemoProfile({ url: variables.demo_url }).catch(() => null);
  } else if (id) {
    found = await getOrBuildDemoProfile({ id }).catch(() => null);
  }
  const profile = found?.profile || fallbackProfile({ name: variables.clinic_name, city: variables.city, niche: variables.niche });
  return { id: found?.id || id || 'demo', profile, industry: makeDemoIndustry(profile) };
}
