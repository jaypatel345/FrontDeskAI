import { Router } from 'express';
import { dashboardStats, recentCalls, callsByDay } from '../db.js';
import { schedulingMode } from '../services/scheduling.js';
import { crmMode } from '../services/crm.js';
import { smsMode } from '../services/sms.js';
import { ragMode } from '../services/rag.js';

export const dashboardRouter = Router();

dashboardRouter.get('/stats', (req, res) => {
  res.json({
    ...dashboardStats(),
    dailyCalls: callsByDay(7),
    integrations: { scheduling: schedulingMode, crm: crmMode, sms: smsMode, rag: ragMode },
  });
});

dashboardRouter.get('/calls', (req, res) => {
  res.json(recentCalls(50));
});
