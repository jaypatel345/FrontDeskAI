export const SERVICES = [
  { name: 'Botox', match: /botox|\btox\b|dysport|wrinkle relax/i },
  { name: 'Filler', match: /filler|\blips?\b|cheek|jawline/i },
  { name: 'Laser Hair Removal', match: /hair removal|laser hair/i },
  { name: 'Laser Skin Resurfacing', match: /resurfac/i },
  { name: 'Laser Pigmentation Treatment', match: /pigment|redness|\bipl\b/i },
  { name: 'HydraFacial', match: /hydra\s*facial|\bfacial\b/i },
  { name: 'Chemical Peel', match: /peel/i },
  { name: 'Microneedling', match: /micro\s*-?\s*needl/i },
  { name: 'Consultation', match: /consult/i },
];

export function canonicalService(input) {
  if (!input) return null;
  return SERVICES.find((s) => s.match.test(input))?.name ?? null;
}
