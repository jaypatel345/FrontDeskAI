import crypto from 'node:crypto';
import { config } from '../config.js';

export const FUNCTIONS_SECRET_HEADER = 'x-functions-secret';

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// /functions/* can book and cancel real appointments, so only Retell/Bland (which send this
// header on every tool call, see retell/tools.js and bland/tools.js) may call it. Without a
// secret configured we only allow requests outside production, so local dev still works.
export function requireFunctionsSecret(req, res, next) {
  if (!config.functionsSecret) {
    if (config.isProduction) return res.status(401).json({ error: 'Unauthorized' });
    return next();
  }
  const provided = req.get(FUNCTIONS_SECRET_HEADER) || '';
  if (!safeEqual(provided, config.functionsSecret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
