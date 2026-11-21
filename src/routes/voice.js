import express from 'express';
import https from 'node:https';
import { config } from '../config.js';

/**
 * Vapi "custom-voice" endpoint backed by Sarvam's Bulbul TTS (natural Indian Hindi / Hinglish).
 *
 * Vapi POSTs { message: { type: 'voice-request', text, sampleRate } } once per sentence and plays
 * whatever we send back as 1-channel 16-bit raw PCM at that sample rate. Sarvam's HTTP stream
 * endpoint returns exactly that ("linear16"), so its body is piped straight through: the caller
 * hears audio as soon as Sarvam's first bytes arrive, not after the whole sentence is made.
 *
 * Any error is returned before audio starts, so Vapi switches to the assistant's fallback voice.
 */
export const voiceRouter = express.Router();

const SARVAM_HOST = 'api.sarvam.ai';
const SARVAM_STREAM_PATH = '/text-to-speech/stream';
// The rates Sarvam's streaming endpoint accepts.
const SAMPLE_RATES = new Set([8000, 16000, 22050, 24000]);
const MAX_TEXT = 3500;

// Optional per-assistant overrides in the URL: /voice/sarvam?speaker=ritu_hi_customer&lang=hi-IN
const SPEAKER_RE = /^[a-z0-9_]{2,60}$/;
const LANG_RE = /^[a-z]{2}-IN$/;

// This server (Oregon) is far from Sarvam (India): a fresh TLS connection costs ~3 round trips,
// ~0.7s, before any audio. Built-in fetch drops idle connections after 4s - shorter than the
// gap between two replies - so every sentence paid that. Keep sockets open between turns instead.
const sarvamAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 32 });

// Test hook: swap the HTTP request function (defaults to https.request with the keep-alive agent).
let requestImpl = (options, onResponse) => https.request({ ...options, agent: sarvamAgent }, onResponse);
export function setSarvamRequest(fn) {
  requestImpl = fn || ((options, onResponse) => https.request({ ...options, agent: sarvamAgent }, onResponse));
}

/**
 * Opens (or keeps) a connection to Sarvam so the first sentence of a call doesn't pay for the
 * TLS handshake. Called when a Hindi demo call starts; costs nothing (an unauthenticated GET).
 */
export function warmSarvam() {
  if (!config.sarvam.apiKey) return;
  try {
    const req = requestImpl({ host: SARVAM_HOST, path: '/', method: 'GET' }, (res) => res.resume());
    req.on('error', () => {});
    req.setTimeout(5000, () => req.destroy());
    req.end();
  } catch {
    // best effort
  }
}

voiceRouter.post('/sarvam', (req, res) => {
  if (!config.sarvam.apiKey) return res.status(503).json({ error: 'SARVAM_API_KEY is not set' });

  const message = req.body?.message;
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  const sampleRate = Number(message?.sampleRate);
  if (message?.type !== 'voice-request' || !text) return res.status(400).json({ error: 'Expected a voice-request with text' });
  if (!SAMPLE_RATES.has(sampleRate)) return res.status(400).json({ error: `Unsupported sampleRate ${message?.sampleRate}` });

  const speaker = SPEAKER_RE.test(req.query.speaker || '') ? req.query.speaker : config.sarvam.speaker;
  const languageCode = LANG_RE.test(req.query.lang || '') ? req.query.lang : config.sarvam.language;
  const body = JSON.stringify({
    text: text.slice(0, MAX_TEXT),
    language_code: languageCode,
    model: config.sarvam.model,
    speaker,
    pace: config.sarvam.pace,
    output_audio_codec: 'linear16',
    speech_sample_rate: sampleRate,
  });

  let finished = false;
  const upstream = requestImpl(
    {
      host: SARVAM_HOST,
      path: SARVAM_STREAM_PATH,
      method: 'POST',
      headers: {
        'api-subscription-key': config.sarvam.apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    (up) => {
      if (up.statusCode !== 200) {
        let detail = '';
        up.setEncoding('utf8');
        up.on('data', (d) => (detail += d));
        up.on('end', () => {
          console.error(`[sarvam] ${up.statusCode}: ${detail.slice(0, 300)}`);
          if (!res.headersSent) res.status(502).json({ error: 'Voice provider error' });
        });
        return;
      }
      res.status(200).set('Content-Type', 'application/octet-stream');
      up.pipe(res);
      up.on('end', () => (finished = true));
      up.on('error', (err) => {
        console.error('[sarvam] stream broke:', err.message);
        res.destroy();
      });
    }
  );

  upstream.on('error', (err) => {
    if (finished || res.writableEnded) return;
    console.error('[sarvam] request failed:', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Voice provider unreachable' });
    else res.destroy();
  });
  // The caller interrupting (or Vapi giving up) closes this request: stop paying Sarvam for audio
  // nobody will hear.
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });

  upstream.end(body);
});
