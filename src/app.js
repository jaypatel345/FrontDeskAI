import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { functionsRouter } from './routes/functions.js';
import { requireFunctionsSecret } from './middleware/requireFunctionsSecret.js';
import { requireDashboardAuth } from './middleware/requireDashboardAuth.js';
import { retellWebhookRouter } from './routes/retellWebhook.js';
import { vapiWebhookRouter } from './routes/vapiWebhook.js';
import { blandWebhookRouter } from './routes/blandWebhook.js';
import { dashboardRouter } from './routes/dashboard.js';
import { demoRouter } from './routes/demo.js';
import { voiceRouter } from './routes/voice.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Built separately from server.js so tests can drive the app with supertest without opening a port.
export const app = express();

// Render (and most hosts) sit behind one proxy - without this every request looks like it
// comes from the proxy's IP and the rate limiter would throttle all callers together.
app.set('trust proxy', 1);

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Retell's tool calls all come from a handful of its servers, so the per-IP limit has to leave
// room for several concurrent calls - it's here to stop someone hammering book/cancel, not to
// meter normal traffic. Applied before the secret check so guessing the secret is throttled too.
const functionsLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: config.functionsRateLimitPerMinute,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' },
});

// Tight limit on the dashboard so its password can't be brute-forced.
const dashboardLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

// Building a profile fetches a prospect's website - cheap when cached, but not something a
// stranger should be able to loop on.
const demoLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: config.demo.rateLimitPerMinute,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' },
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/demo', demoLimiter, demoRouter);

app.use('/functions', functionsLimiter, requireFunctionsSecret, functionsRouter);
app.use('/webhooks/retell', retellWebhookRouter);
// Vapi sends tool calls here too, so it gets the same rate limit and secret as /functions/*.
app.use('/webhooks/vapi', functionsLimiter, requireFunctionsSecret, vapiWebhookRouter);
app.use('/webhooks/bland', blandWebhookRouter);
// Vapi custom-voice requests (one per spoken sentence) - same secret as the webhooks, which the
// assistant sends from its own server-side settings. No rate limit: a busy call sends many.
app.use('/voice', requireFunctionsSecret, voiceRouter);
app.use('/api/dashboard', dashboardLimiter, requireDashboardAuth, dashboardRouter);
app.get('/dashboard', dashboardLimiter, requireDashboardAuth, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'))
);
app.use('/dashboard', dashboardLimiter, requireDashboardAuth, express.static(path.join(__dirname, 'public')));
