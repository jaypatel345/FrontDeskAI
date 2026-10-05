import crypto from 'node:crypto';
import { config } from '../config.js';

function safeEqual(a, b) {
  // Hash first so both sides are the same length and the comparison time leaks nothing.
  const hash = (s) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
}

// HTTP Basic auth: the browser shows its own login prompt and then resends the credentials
// on the dashboard's fetch() calls automatically, so the page itself needs no login code.
export function requireDashboardAuth(req, res, next) {
  const { user, password } = config.dashboard;
  if (!password) {
    if (config.isProduction) return res.status(401).send('Dashboard is disabled: DASHBOARD_PASSWORD is not set.');
    return next();
  }

  const [scheme, encoded] = (req.get('authorization') || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    const sep = decoded.indexOf(':');
    const givenUser = decoded.slice(0, sep);
    const givenPassword = decoded.slice(sep + 1);
    // Evaluate both so a wrong username takes as long as a wrong password.
    const userOk = safeEqual(givenUser, user);
    const passwordOk = safeEqual(givenPassword, password);
    if (sep !== -1 && userOk && passwordOk) return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Clinic dashboard", charset="UTF-8"');
  res.status(401).send('Authentication required.');
}
