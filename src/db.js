import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS calls (
    call_id TEXT PRIMARY KEY,
    agent_id TEXT,
    from_number TEXT,
    to_number TEXT,
    status TEXT,
    started_at INTEGER,
    ended_at INTEGER,
    disconnection_reason TEXT,
    transcript TEXT,
    recording_url TEXT,
    intent TEXT,
    escalated INTEGER DEFAULT 0,
    avg_response_latency_ms INTEGER
  );

  CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    call_id TEXT,
    name TEXT,
    phone TEXT,
    email TEXT,
    treatment_interest TEXT,
    budget TEXT,
    urgency TEXT,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    call_id TEXT,
    external_booking_id TEXT,
    service TEXT,
    name TEXT,
    phone TEXT,
    phone_norm TEXT,
    email TEXT,
    start_time TEXT,
    end_time TEXT,
    status TEXT,
    created_at INTEGER
  );
`);

// Columns added after these tables already existed in earlier testing - safe to run repeatedly.
try {
  db.exec(`ALTER TABLE bookings ADD COLUMN phone_norm TEXT`);
} catch {
  // already exists
}
try {
  db.exec(`ALTER TABLE calls ADD COLUMN avg_response_latency_ms INTEGER`);
} catch {
  // already exists
}
try {
  db.exec(`ALTER TABLE bookings ADD COLUMN email TEXT`);
} catch {
  // already exists
}

// Phone numbers arrive in wildly inconsistent formats depending on whether the LLM included
// a country code, dashes, spaces, etc - a booking stored as "+15551234567" was invisible to a
// lookup for "5551234567", identical number, different string. Matching on the last 10 digits
// (US-centric, matches this clinic) makes lookup/cancel/reschedule format-agnostic.
export function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.slice(-10);
}

// Events for one call arrive from several places (tool calls, status updates, the end-of-call
// report) in no guaranteed order, so a missing value never overwrites one already stored.
const upsertCallStmt = db.prepare(`
  INSERT INTO calls (call_id, agent_id, from_number, to_number, status, started_at, ended_at, disconnection_reason, transcript, recording_url, intent, escalated, avg_response_latency_ms)
  VALUES (:call_id, :agent_id, :from_number, :to_number, :status, :started_at, :ended_at, :disconnection_reason, :transcript, :recording_url, :intent, :escalated, :avg_response_latency_ms)
  ON CONFLICT(call_id) DO UPDATE SET
    agent_id=COALESCE(excluded.agent_id, calls.agent_id),
    from_number=COALESCE(excluded.from_number, calls.from_number),
    to_number=COALESCE(excluded.to_number, calls.to_number),
    status=excluded.status,
    started_at=COALESCE(calls.started_at, excluded.started_at),
    ended_at=COALESCE(excluded.ended_at, calls.ended_at),
    disconnection_reason=COALESCE(excluded.disconnection_reason, calls.disconnection_reason),
    transcript=COALESCE(excluded.transcript, calls.transcript),
    recording_url=COALESCE(excluded.recording_url, calls.recording_url),
    intent=COALESCE(excluded.intent, calls.intent),
    escalated=MAX(calls.escalated, excluded.escalated),
    avg_response_latency_ms=COALESCE(excluded.avg_response_latency_ms, calls.avg_response_latency_ms)
`);

export function upsertCall(call) {
  upsertCallStmt.run({ avg_response_latency_ms: null, ...call });
}

const insertLeadStmt = db.prepare(`
  INSERT INTO leads (id, call_id, name, phone, email, treatment_interest, budget, urgency, created_at)
  VALUES (:id, :call_id, :name, :phone, :email, :treatment_interest, :budget, :urgency, :created_at)
`);

export function insertLead(lead) {
  insertLeadStmt.run(lead);
}

const insertBookingStmt = db.prepare(`
  INSERT INTO bookings (id, call_id, external_booking_id, service, name, phone, phone_norm, email, start_time, end_time, status, created_at)
  VALUES (:id, :call_id, :external_booking_id, :service, :name, :phone, :phone_norm, :email, :start_time, :end_time, :status, :created_at)
`);

export function insertBooking(booking) {
  insertBookingStmt.run({ email: null, ...booking, phone_norm: normalizePhone(booking.phone) });
}

const findLatestBookingByPhoneStmt = db.prepare(`
  SELECT * FROM bookings WHERE phone_norm = :phone_norm AND status = 'confirmed' ORDER BY created_at DESC LIMIT 1
`);

export function findLatestBookingByPhone(phone) {
  return findLatestBookingByPhoneStmt.get({ phone_norm: normalizePhone(phone) });
}

const updateBookingStatusStmt = db.prepare(`UPDATE bookings SET status = :status WHERE id = :id`);

export function updateBookingStatus(id, status) {
  updateBookingStatusStmt.run({ id, status });
}

export function dashboardStats() {
  const totalCalls = db.prepare(`SELECT COUNT(*) AS n FROM calls`).get().n;
  const totalBookings = db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE status = 'confirmed'`).get().n;
  const escalated = db.prepare(`SELECT COUNT(*) AS n FROM calls WHERE escalated = 1`).get().n;
  const missed = db.prepare(`SELECT COUNT(*) AS n FROM calls WHERE disconnection_reason IN ('dial_no_answer', 'dial_failed', 'voicemail_reached')`).get().n;

  // Drop-off: caller hung up without a booking or a captured lead ever coming out of that
  // call - i.e. we answered, but got nothing usable before they left.
  const droppedOff = db
    .prepare(
      `SELECT COUNT(*) AS n FROM calls c
       WHERE c.disconnection_reason = 'user_hangup'
         AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.call_id = c.call_id)
         AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.call_id = c.call_id)`
    )
    .get().n;

  const avgLatency = db.prepare(`SELECT AVG(avg_response_latency_ms) AS v FROM calls WHERE avg_response_latency_ms IS NOT NULL`).get().v;

  const pct = (n) => (totalCalls ? Math.round((n / totalCalls) * 1000) / 10 : 0);

  return {
    totalCalls,
    totalBookings,
    escalated,
    missed,
    conversionRate: pct(totalBookings),
    escalationRate: pct(escalated),
    callAnswerRate: pct(totalCalls - missed),
    dropOffRate: pct(droppedOff),
    avgResponseLatencyMs: avgLatency ? Math.round(avgLatency) : null,
  };
}

export function callsByDay(days = 7) {
  const rows = db
    .prepare(`SELECT date(started_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM calls WHERE started_at IS NOT NULL GROUP BY day`)
    .all();
  const byDay = new Map(rows.map((r) => [r.day, r.n]));

  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    result.push({ date: key, count: byDay.get(key) || 0 });
  }
  return result;
}

export function recentCalls(limit = 25) {
  return db.prepare(`SELECT * FROM calls ORDER BY started_at DESC LIMIT ?`).all(limit);
}
