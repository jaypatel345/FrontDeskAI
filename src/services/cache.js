import Redis from 'ioredis';
import { config } from '../config.js';

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 1,
  retryStrategy: () => 1000,
  lazyConnect: false,
  connectTimeout: 500,
  // The local Docker Redis has been flapping (connect → ECONNRESET → reconnect, on a ~1s
  // cycle) rather than staying stably up or cleanly down. With offline queueing on, a command
  // issued mid-flap sits waiting instead of failing immediately - that queueing, not Cal.com,
  // was the extra latency on top of the real external call. Fail fast instead and let the
  // in-memory fallback below carry availability caching until Redis is actually stable.
  enableOfflineQueue: false,
});

let redisUp = true;
redis.on('error', (err) => {
  if (redisUp) console.error('[redis] connection error (falling back to in-memory cache):', err.message);
  redisUp = false;
});
redis.on('connect', () => {
  if (!redisUp) console.log('[redis] reconnected');
  redisUp = true;
});

const AVAILABILITY_TTL_SECONDS = 60;

// In-process fallback so availability caching still works even when Redis/Docker isn't
// running locally — this matters for real latency, not just resilience: without it, every
// check_availability call round-trips to Cal.com fresh, which is the difference between a
// cache hit and a call that can blow past the tool's timeout budget.
const memCache = new Map();

function memGet(key) {
  const entry = memCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    memCache.delete(key);
    return null;
  }
  return entry.value;
}

function memSet(key, value, ttlSeconds) {
  memCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

export async function getCachedAvailability(key) {
  if (redisUp) {
    try {
      const raw = await redis.get(`avail:${key}`);
      if (raw) return JSON.parse(raw);
    } catch {
      // fall through to in-memory
    }
  }
  return memGet(key);
}

export async function setCachedAvailability(key, slots) {
  memSet(key, slots, AVAILABILITY_TTL_SECONDS);
  if (redisUp) {
    try {
      await redis.set(`avail:${key}`, JSON.stringify(slots), 'EX', AVAILABILITY_TTL_SECONDS);
    } catch {
      // best-effort only
    }
  }
}
