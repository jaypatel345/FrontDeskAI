export const SERVICES = [
  { name: 'Property Tour', match: /tour|showing|viewing|walkthrough|see\s+(the\s+)?property|visit/i },
  { name: 'Buyer Consultation', match: /buy|buyer|purchas|looking\s+for\s+(a\s+)?home|house\s+hunting/i },
  { name: 'Home Valuation', match: /sell|seller|listing|valuation|market\s+analysis|what\s+is\s+my\s+home\s+worth/i },
  { name: 'Rental Inquiry', match: /rent|rental|lease|tenant/i },
  { name: 'Agent Consultation', match: /agent|callback|speak\s+to\s+(an\s+)?agent|realtor|broker/i },
  { name: 'General Consultation', match: /consult|meeting|general/i },
];

export function canonicalService(input) {
  if (!input) return null;
  return SERVICES.find((s) => s.match.test(input))?.name ?? null;
}
