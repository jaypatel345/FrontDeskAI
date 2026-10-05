import { Router } from 'express';
import { dashboardStats, recentCalls, callsByDay } from '../db.js';
import { schedulingMode } from '../services/scheduling.js';
import { crmMode } from '../services/crm.js';
import { smsMode } from '../services/sms.js';
import { ragMode } from '../services/rag.js';

export const dashboardRouter = Router();

// Keeps the last 4 digits so staff can still tell callers apart: "+1 ••• ••• 4821".
export function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 4) return null;
  const country = digits.length > 10 ? `+${digits.slice(0, digits.length - 10)} ` : '';
  return `${country}••• ••• ${digits.slice(-4)}`;
}

dashboardRouter.get('/stats', (req, res) => {
  res.json({
    ...dashboardStats(),
    dailyCalls: callsByDay(7),
    integrations: { scheduling: schedulingMode, crm: crmMode, sms: smsMode, rag: ragMode },
  });
});

// Only the fields the table shows - transcripts and recording URLs stay server-side.
dashboardRouter.get('/calls', (req, res) => {
  res.json(
    recentCalls(50).map((c) => ({
      call_id: c.call_id,
      from_number: maskPhone(c.from_number),
      status: c.status,
      started_at: c.started_at,
      escalated: c.escalated,
    }))
  );
});
