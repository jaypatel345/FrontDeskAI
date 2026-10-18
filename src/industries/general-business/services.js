export const SERVICES = [
  { name: 'Discovery Call', match: /discovery|consultation|intro|introductory\s+call|discuss\s+project|new\s+business/i },
  { name: 'Product Demo', match: /demo|demonstration|software\s+demo|product\s+tour|preview/i },
  { name: 'Client Support', match: /support|account|existing\s+client|service\s+inquiry|help\s+desk/i },
  { name: 'Billing & Accounts', match: /bill|billing|invoice|payment|accounts\s+payable|accounting/i },
  { name: 'General Inquiry', match: /inquiry|message|speak\s+to\s+someone|general|front\s+desk/i },
  { name: 'Partnership & Press', match: /partner|partnership|press|media|vendor/i },
];

export function canonicalService(input) {
  if (!input) return null;
  return SERVICES.find((s) => s.match.test(input))?.name ?? null;
}
