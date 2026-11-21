import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { z } from 'zod';
import { config } from '../config.js';

/**
 * Website -> clinic profile, for personalised demos: a prospect's demo link carries their website,
 * and the receptionist answers with that clinic's own name, services, prices and hours.
 *
 * Reads the homepage plus up to MAX_SUBPAGES internal pages that look like services / prices /
 * about / contact. Extraction uses an LLM when OPENAI_API_KEY is set and falls back to (or fills
 * gaps from) plain heuristics - JSON-LD, tel: links, price patterns, a treatment dictionary - so it
 * works with no paid keys, like every other integration in this repo.
 */

const MAX_SUBPAGES = 5;
const PAGE_TIMEOUT_MS = 8000;
const MAX_PAGE_BYTES = 1_500_000;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'Mozilla/5.0 (compatible; FrontDeskDemoBot/1.0)';

export const profileSchema = z.object({
  url: z.string(),
  name: z.string().min(1),
  niche: z.string().default('clinic'),
  doctors: z.array(z.string()).default([]),
  city: z.string().default(''),
  address: z.string().default(''),
  phone: z.string().default(''),
  hours: z.string().default(''),
  country: z.string().default(''),
  currency: z.string().default('USD'),
  timezone: z.string().default('America/Los_Angeles'),
  language: z.string().default('english'),
  services: z.array(z.object({ name: z.string(), price: z.string().default('') })).default([]),
  faqs: z.array(z.string()).default([]),
  source: z.enum(['llm', 'heuristic']).default('heuristic'),
  builtAt: z.number().default(() => Date.now()),
});

// ---------- URL handling ----------

export function normalizeSiteUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new Error('url is required');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('only http and https sites are supported');
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  return url;
}

// Same site -> same id, whatever form the link took (www., http, trailing path).
export function demoIdForUrl(input) {
  const host = normalizeSiteUrl(input).hostname.replace(/^www\./, '');
  return crypto.createHash('sha1').update(host).digest('hex').slice(0, 12);
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

// The demo endpoint is public, so it must not become a way to make this server fetch internal
// addresses (cloud metadata, localhost services). Checked for every hop, redirects included.
async function assertPublicHost(hostname, lookup = dns.lookup) {
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('that address is not allowed');
    return;
  }
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('that address is not allowed');
  }
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) throw new Error('that address is not allowed');
}

async function fetchPage(startUrl, fetchImpl = fetch, lookup = dns.lookup) {
  let url = new URL(startUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url.hostname, lookup);
    const res = await fetchImpl(url, {
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('redirected to an unsupported address');
      continue;
    }
    if (!res.ok) throw new Error(`site answered ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (type && !/html|text/i.test(type)) throw new Error('not an HTML page');
    const html = (await res.text()).slice(0, MAX_PAGE_BYTES);
    return { url: url.toString(), html };
  }
  throw new Error('too many redirects');
}

// ---------- HTML -> text ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", ndash: '-', mdash: '-', hellip: '...', rdquo: '"', ldquo: '"', copy: '' };

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

const clean = (s) => decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

export function parseHtml(html, pageUrl) {
  const jsonLd = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1].trim());
      const items = Array.isArray(data) ? data : data['@graph'] || [data];
      jsonLd.push(...items.filter((i) => i && typeof i === 'object'));
    } catch {
      // malformed JSON-LD is common - skip it
    }
  }

  const meta = (name) =>
    clean(
      html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i'))?.[1] ||
        html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${name}["']`, 'i'))?.[1] ||
        ''
    );

  const links = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    links.push({ href: m[1].trim(), text: clean(m[2]) });
  }

  const headings = [...html.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi)].map((m) => clean(m[1])).filter(Boolean);

  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n');
  const text = decodeEntities(body.replace(/<[^>]+>/g, ' '))
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

  return {
    url: pageUrl,
    title: clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''),
    siteName: meta('og:site_name'),
    description: meta('description') || meta('og:description'),
    jsonLd,
    links,
    headings,
    text,
  };
}

const SUBPAGE_HINT = /service|treatment|procedure|price|pricing|fee|cost|about|contact|team|doctor|dentist|faq|location|hour/i;

function pickSubpages(page, base) {
  const seen = new Set([base.toString().replace(/\/$/, '')]);
  const picked = [];
  for (const { href, text } of page.links) {
    if (picked.length >= MAX_SUBPAGES) break;
    let u;
    try {
      u = new URL(href, base);
    } catch {
      continue;
    }
    if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
    if (/\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4)$/i.test(u.pathname)) continue;
    u.hash = '';
    const key = u.toString().replace(/\/$/, '');
    if (seen.has(key)) continue;
    if (!SUBPAGE_HINT.test(`${u.pathname} ${text}`)) continue;
    seen.add(key);
    picked.push(u.toString());
  }
  return picked;
}

// ---------- Heuristic extraction ----------

const TREATMENTS = [
  'Botox', 'Dermal Fillers', 'Lip Fillers', 'HydraFacial', 'Chemical Peel', 'Microneedling', 'Laser Hair Removal',
  'Laser Skin Resurfacing', 'PRP', 'Hair Transplant', 'Skin Rejuvenation', 'Acne Treatment', 'Pigmentation Treatment',
  'Thread Lift', 'Coolsculpting', 'Body Contouring', 'IV Therapy', 'Dental Implants', 'Root Canal', 'Teeth Whitening',
  'Invisalign', 'Clear Aligners', 'Braces', 'Veneers', 'Dental Crowns', 'Dental Cleaning', 'Scaling and Polishing',
  'Tooth Extraction', 'Wisdom Tooth Removal', 'Dentures', 'Smile Makeover', 'Pediatric Dentistry', 'Gum Treatment',
  'Physiotherapy', 'Chiropractic Care', 'Massage Therapy', 'Dermatology Consultation', 'Eye Exam', 'LASIK',
  'General Check-up', 'Vaccination', 'Blood Tests', 'Health Check', 'Consultation',
];

const PRICE = /(?:US\$|\$|₹|£|€|AED|Rs\.?|INR|SAR|QAR)\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:-|–|to)\s?(?:US\$|\$|₹|£|€|AED|Rs\.?|INR)?\s?\d[\d,]*)?|\d[\d,]*\s?(?:AED|INR|SAR|QAR|USD|dirhams?|rupees?)/i;

const COUNTRY_BY_TLD = { ae: 'AE', in: 'IN', uk: 'GB', au: 'AU', ca: 'CA', sa: 'SA', qa: 'QA', sg: 'SG', nz: 'NZ' };
const COUNTRY_DEFAULTS = {
  US: { currency: 'USD', timezone: 'America/New_York', language: 'english' },
  AE: { currency: 'AED', timezone: 'Asia/Dubai', language: 'english' },
  IN: { currency: 'INR', timezone: 'Asia/Kolkata', language: 'english' },
  GB: { currency: 'GBP', timezone: 'Europe/London', language: 'english' },
  AU: { currency: 'AUD', timezone: 'Australia/Sydney', language: 'english' },
  CA: { currency: 'CAD', timezone: 'America/Toronto', language: 'english' },
  SA: { currency: 'SAR', timezone: 'Asia/Riyadh', language: 'english' },
  QA: { currency: 'QAR', timezone: 'Asia/Qatar', language: 'english' },
  SG: { currency: 'SGD', timezone: 'Asia/Singapore', language: 'english' },
  NZ: { currency: 'NZD', timezone: 'Pacific/Auckland', language: 'english' },
};
const COUNTRY_NAMES = { 'united arab emirates': 'AE', uae: 'AE', dubai: 'AE', india: 'IN', 'united kingdom': 'GB', australia: 'AU', canada: 'CA', 'united states': 'US', usa: 'US', 'saudi arabia': 'SA', qatar: 'QA', singapore: 'SG' };

const BUSINESS_TYPES = /clinic|dentist|medical|physician|hospital|health|beauty|spa|business|organization|place/i;

function findBusinessLd(pages) {
  for (const p of pages) {
    for (const item of p.jsonLd) {
      const type = [].concat(item['@type'] || []).join(' ');
      if (BUSINESS_TYPES.test(type) && item.name) return item;
    }
  }
  return null;
}

function nameFromTitle(home) {
  if (home.siteName) return home.siteName;
  const parts = home.title.split(/\s[|\-–—:]\s/).map((s) => s.trim()).filter(Boolean);
  const branded = parts.find((p) => /clinic|dental|dentist|derma|skin|aesthetic|medical|health|care|spa|smile/i.test(p));
  return branded || parts[0] || '';
}

function formatLdAddress(addr) {
  if (!addr) return { address: '', city: '', country: '' };
  if (typeof addr === 'string') return { address: addr, city: '', country: '' };
  const a = Array.isArray(addr) ? addr[0] : addr;
  const country = typeof a.addressCountry === 'object' ? a.addressCountry?.name : a.addressCountry;
  return {
    address: [...new Set([a.streetAddress, a.addressLocality, a.addressRegion].filter(Boolean))].join(', '),
    city: a.addressLocality || '',
    country: country || '',
  };
}

function formatLdHours(item) {
  return formatLdHoursRaw(item)
    .replace(/^Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday\b/, 'Every day')
    .replace(/^Monday, Tuesday, Wednesday, Thursday, Friday, Saturday\b/, 'Monday to Saturday');
}

function formatLdHoursRaw(item) {
  if (!item) return '';
  if (item.openingHours) return [].concat(item.openingHours).join(', ');
  const spec = [].concat(item.openingHoursSpecification || []);
  return spec
    .map((s) => `${[].concat(s.dayOfWeek || []).map((d) => String(d).split('/').pop()).join(', ')} ${s.opens || ''}-${s.closes || ''}`.trim())
    .join('; ');
}

function guessCountry(host, text, ldCountry) {
  if (ldCountry) {
    const code = ldCountry.length === 2 ? ldCountry.toUpperCase() : COUNTRY_NAMES[ldCountry.toLowerCase()];
    if (code) return code;
  }
  const tld = host.split('.').pop();
  if (COUNTRY_BY_TLD[tld]) return COUNTRY_BY_TLD[tld];
  if (/\bAED\b|dubai|abu dhabi|sharjah/i.test(text)) return 'AE';
  if (/₹|\bINR\b|\brupees?\b|mumbai|delhi|bangalore|bengaluru|ahmedabad|pune|hyderabad|chennai/i.test(text)) return 'IN';
  return 'US';
}

const KNOWN_CITIES = ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Al Ain', 'Riyadh', 'Jeddah', 'Doha', 'Mumbai', 'New Delhi', 'Delhi', 'Ahmedabad', 'Bengaluru', 'Bangalore', 'Pune', 'Hyderabad', 'Chennai', 'Kolkata', 'Surat', 'Vadodara', 'Rajkot', 'Jaipur', 'London', 'Manchester', 'Sydney', 'Melbourne', 'Toronto', 'Singapore', 'New York', 'Los Angeles', 'Miami', 'Houston', 'Chicago'];

// Most-mentioned well-known city, when the site has no structured address.
function guessCity(text) {
  let best = '';
  let bestCount = 0;
  for (const city of KNOWN_CITIES) {
    const count = text.split(city).length - 1;
    if (count > bestCount) {
      best = city;
      bestCount = count;
    }
  }
  return best;
}

function guessNiche(text) {
  if (/dentist|dental|teeth|tooth|orthodont/i.test(text)) return 'dental clinic';
  if (/aesthetic|cosmetic|botox|filler|med\s?spa/i.test(text)) return 'aesthetics clinic';
  if (/dermatolog/i.test(text)) return 'dermatology clinic';
  if (/physiotherap|chiropract/i.test(text)) return 'physiotherapy clinic';
  if (/ophthalm|optometr|eye care/i.test(text)) return 'eye clinic';
  return 'clinic';
}

function findHours(text) {
  const line = text
    .split('\n')
    .find((l) => l.length < 160 && /(mon|tue|wed|thu|fri|sat|sun)[a-z]*/i.test(l) && /\d{1,2}(:\d{2})?\s?(am|pm|:\d{2})/i.test(l));
  return line || '';
}

function findServices(text) {
  const lower = text.toLowerCase();
  const found = [];
  for (const t of TREATMENTS) {
    const idx = lower.indexOf(t.toLowerCase());
    if (idx === -1) continue;
    const near = text.slice(idx, idx + 140).match(PRICE)?.[0] || '';
    found.push({ name: t, price: near.trim() });
  }
  return found.slice(0, 12);
}

const FAQ_HINT = /insurance|parking|payment|emergency|walk-in|appointment|consultation|free|open|located|experience|certified|years/i;

function findFacts(text, description) {
  const sentences = text
    .replace(/\n/g, '. ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(
      (s) =>
        s.length >= 40 &&
        s.length <= 220 &&
        FAQ_HINT.test(s) &&
        !/cookie|privacy|©|copyright|subscribe/i.test(s) &&
        // Testimonials ("I had to wait...") aren't facts the receptionist should repeat.
        !/\b(I|I'm|I've|my|me)\b/.test(s)
    );
  const facts = [...new Set([description, ...sentences].filter(Boolean))];
  return facts.slice(0, 8);
}

export function heuristicProfile(pages, siteUrl) {
  const home = pages[0];
  const allText = pages.map((p) => p.text).join('\n');
  const ld = findBusinessLd(pages);
  const ldAddr = formatLdAddress(ld?.address);
  const country = guessCountry(siteUrl.hostname, allText, ldAddr.country);
  const defaults = COUNTRY_DEFAULTS[country] || COUNTRY_DEFAULTS.US;

  const telLink = pages.flatMap((p) => p.links).find((l) => /^tel:/i.test(l.href))?.href.replace(/^tel:/i, '');
  const doctorNames = [...new Set([...allText.matchAll(/\bDr\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/g)].map((m) => m[0].replace(/^Dr\.?\s+/, 'Dr. ')))];
  // "Dr. Saima" next to "Dr. Saima Anwar" is the same person.
  const doctors = doctorNames.filter((d) => !doctorNames.some((o) => o !== d && o.startsWith(`${d} `))).slice(0, 4);
  const prices = allText.match(PRICE)?.[0] || '';
  // A known country decides the currency; price symbols only help when the country is a guess.
  const currency =
    country !== 'US'
      ? defaults.currency
      : /₹|\bINR\b|rupee/i.test(prices) ? 'INR' : /AED|dirham/i.test(prices) ? 'AED' : /£/.test(prices) ? 'GBP' : /€/.test(prices) ? 'EUR' : defaults.currency;

  return {
    url: siteUrl.toString(),
    name: clean(ld?.name) || nameFromTitle(home) || siteUrl.hostname.replace(/^www\./, ''),
    niche: guessNiche(allText),
    doctors,
    city: ldAddr.city || guessCity(allText),
    address: ldAddr.address,
    phone: String(ld?.telephone || telLink || '').trim(),
    hours: formatLdHours(ld) || findHours(allText),
    country,
    currency,
    timezone: defaults.timezone,
    language: defaults.language,
    services: findServices(allText),
    faqs: findFacts(allText, home.description),
    source: 'heuristic',
  };
}

// ---------- LLM extraction (optional) ----------

const llmSchema = z.object({
  name: z.string().optional(),
  niche: z.string().optional(),
  doctors: z.array(z.string()).optional(),
  city: z.string().optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  hours: z.string().optional(),
  country: z.string().optional(),
  currency: z.string().optional(),
  services: z.array(z.object({ name: z.string(), price: z.string().optional() })).optional(),
  faqs: z.array(z.string()).optional(),
});

async function llmProfile(pages, client) {
  const corpus = pages.map((p) => `### ${p.url}\n${p.title}\n${p.text}`).join('\n\n').slice(0, 24000);
  const res = await client.chat.completions.create({
    model: 'gpt-4.1-mini',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Extract facts about this clinic from its website text for a phone receptionist. Reply with JSON: ' +
          '{"name","niche" (e.g. "dental clinic"),"doctors":[],"city","address","phone","hours","country" (ISO 2-letter),' +
          '"currency" (ISO code),"services":[{"name","price"}],"faqs":[short facts a receptionist would say]}. ' +
          'Only use facts in the text; leave a field empty if it is not there. Max 12 services, 8 faqs.',
      },
      { role: 'user', content: corpus },
    ],
  });
  return llmSchema.parse(JSON.parse(res.choices[0].message.content || '{}'));
}

let openaiClient = null;
async function getOpenAI() {
  if (!config.openaiApiKey) return null;
  if (!openaiClient) {
    const { default: OpenAI } = await import('openai');
    openaiClient = new OpenAI({ apiKey: config.openaiApiKey });
  }
  return openaiClient;
}

function mergeProfiles(base, llm) {
  const pick = (a, b) => (a && String(a).trim() ? a : b);
  const country = (llm.country && llm.country.length === 2 ? llm.country.toUpperCase() : null) || base.country;
  const defaults = COUNTRY_DEFAULTS[country] || {};
  return {
    ...base,
    name: pick(llm.name, base.name),
    niche: pick(llm.niche, base.niche),
    doctors: llm.doctors?.length ? llm.doctors : base.doctors,
    city: pick(llm.city, base.city),
    address: pick(llm.address, base.address),
    phone: pick(llm.phone, base.phone),
    hours: pick(llm.hours, base.hours),
    country,
    currency: pick(llm.currency, base.currency),
    timezone: defaults.timezone || base.timezone,
    services: llm.services?.length ? llm.services.map((s) => ({ name: s.name, price: s.price || '' })) : base.services,
    faqs: llm.faqs?.length ? llm.faqs : base.faqs,
    source: 'llm',
  };
}

// ---------- Public API ----------

// fetchImpl / lookup / openai are injectable so tests run with no network.
export async function buildSiteProfile(input, { fetchImpl = fetch, lookup = dns.lookup, openai } = {}) {
  const siteUrl = normalizeSiteUrl(input);
  let homeRaw;
  try {
    homeRaw = await fetchPage(siteUrl, fetchImpl, lookup);
  } catch (err) {
    // Plenty of sites only answer on one of example.com / www.example.com.
    const alt = new URL(siteUrl);
    alt.hostname = alt.hostname.startsWith('www.') ? alt.hostname.slice(4) : `www.${alt.hostname}`;
    try {
      homeRaw = await fetchPage(alt, fetchImpl, lookup);
    } catch {
      throw err;
    }
  }
  const home = parseHtml(homeRaw.html, homeRaw.url);
  const subUrls = pickSubpages(home, new URL(homeRaw.url));
  const subs = await Promise.all(
    subUrls.map((u) =>
      fetchPage(u, fetchImpl, lookup)
        .then((p) => parseHtml(p.html, p.url))
        .catch(() => null)
    )
  );
  const pages = [home, ...subs.filter(Boolean)];

  let profile = heuristicProfile(pages, siteUrl);
  const client = openai === undefined ? await getOpenAI() : openai;
  if (client) {
    try {
      profile = mergeProfiles(profile, await llmProfile(pages, client));
    } catch (e) {
      console.error('[site-profile] LLM extraction failed, using heuristics:', e.message);
    }
  }
  return profileSchema.parse({ ...profile, builtAt: Date.now() });
}

// The receptionist's knowledge base for this clinic, same shape as the industry knowledgeBase.json.
export function profileToKnowledgeBase(p) {
  const entries = [];
  const location = [p.address || p.city, p.city && p.address && !p.address.includes(p.city) ? p.city : ''].filter(Boolean).join(', ');
  entries.push({
    id: 'hours-location',
    category: 'logistics',
    text: `${p.name}${location ? ` is at ${location}` : ''}. ${p.hours ? `Opening hours: ${p.hours}.` : 'Opening hours are on the website.'}${p.phone ? ` Phone: ${p.phone}.` : ''} Parking, directions, hours, address, open, timings, location.`,
  });
  for (const s of p.services) {
    entries.push({
      id: `service-${s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      category: 'services',
      text: `${s.name}${s.price ? `: price ${s.price}` : ': pricing is confirmed at consultation'}. Treatment, cost, price, fee.`,
    });
  }
  if (p.services.length) {
    entries.push({
      id: 'services-list',
      category: 'services',
      text: `Services and treatments offered: ${p.services.map((s) => s.name).join(', ')}. What do you offer, treatments, services.`,
    });
  }
  if (p.doctors.length) {
    entries.push({ id: 'doctor-profiles', category: 'staff', text: `Doctors and specialists: ${p.doctors.join(', ')}. Doctor, dentist, specialist, who.` });
  }
  p.faqs.forEach((fact, i) => entries.push({ id: `fact-${i + 1}`, category: 'faq', text: fact }));
  return entries;
}

// Short facts block for the prompt, so most questions are answered without a tool round trip.
export function profileFactsLine(p) {
  const services = p.services
    .slice(0, 8)
    .map((s) => (s.price ? `${s.name} (${s.price})` : s.name))
    .join(', ');
  return [
    services && `Services: ${services}.`,
    p.doctors.length && `Doctors: ${p.doctors.join(', ')}.`,
    p.hours && `Hours: ${p.hours}.`,
    (p.address || p.city) && `Address: ${p.address || p.city}.`,
    p.phone && `Phone: ${p.phone}.`,
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 900);
}

export { assertPublicHost };
