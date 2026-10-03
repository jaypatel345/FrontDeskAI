import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { functionsRouter } from './routes/functions.js';
import { retellWebhookRouter } from './routes/retellWebhook.js';
import { blandWebhookRouter } from './routes/blandWebhook.js';
import { dashboardRouter } from './routes/dashboard.js';
import { schedulingMode } from './services/scheduling.js';
import { crmMode } from './services/crm.js';
import { smsMode } from './services/sms.js';
import { ragMode } from './services/rag.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/functions', functionsRouter);
app.use('/webhooks/retell', retellWebhookRouter);
app.use('/webhooks/bland', blandWebhookRouter);
app.use('/api/dashboard', dashboardRouter);
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.use('/dashboard', express.static(path.join(__dirname, 'public')));

app.listen(config.port, () => {
  console.log(`AI receptionist backend listening on :${config.port}`);
  console.log(`  scheduling: ${schedulingMode}`);
  console.log(`  crm:        ${crmMode}`);
  console.log(`  sms:        ${smsMode}`);
  console.log(`  rag:        ${ragMode}`);
  console.log(`  dashboard:  http://localhost:${config.port}/dashboard`);
});
