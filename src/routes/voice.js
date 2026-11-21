import express from 'express';
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

const SARVAM_STREAM_URL = 'https://api.sarvam.ai/text-to-speech/stream';
// The rates Sarvam's streaming endpoint accepts.
const SAMPLE_RATES = new Set([8000, 16000, 22050, 24000]);
const MAX_TEXT = 3500;

// Optional per-assistant overrides in the URL: /voice/sarvam?speaker=ritu_hi_customer&lang=hi-IN
const SPEAKER_RE = /^[a-z0-9_]{2,60}$/;
const LANG_RE = /^[a-z]{2}-IN$/;

voiceRouter.post('/sarvam', async (req, res) => {
  if (!config.sarvam.apiKey) return res.status(503).json({ error: 'SARVAM_API_KEY is not set' });

  const message = req.body?.message;
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  const sampleRate = Number(message?.sampleRate);
  if (message?.type !== 'voice-request' || !text) return res.status(400).json({ error: 'Expected a voice-request with text' });
  if (!SAMPLE_RATES.has(sampleRate)) return res.status(400).json({ error: `Unsupported sampleRate ${message?.sampleRate}` });

  const speaker = SPEAKER_RE.test(req.query.speaker || '') ? req.query.speaker : config.sarvam.speaker;
  const languageCode = LANG_RE.test(req.query.lang || '') ? req.query.lang : config.sarvam.language;

  // The caller interrupting (or Vapi giving up) closes this request: stop paying Sarvam for audio
  // nobody will hear.
  const abort = new AbortController();
  res.on('close', () => abort.abort());

  let upstream;
  try {
    upstream = await fetch(SARVAM_STREAM_URL, {
      method: 'POST',
      headers: { 'api-subscription-key': config.sarvam.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text.slice(0, MAX_TEXT),
        language_code: languageCode,
        model: config.sarvam.model,
        speaker,
        output_audio_codec: 'linear16',
        speech_sample_rate: sampleRate,
      }),
      signal: abort.signal,
    });
  } catch (err) {
    if (abort.signal.aborted) return;
    console.error('[sarvam] request failed:', err.message);
    return res.status(502).json({ error: 'Voice provider unreachable' });
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    console.error(`[sarvam] ${upstream.status}: ${detail.slice(0, 300)}`);
    return res.status(502).json({ error: 'Voice provider error' });
  }

  res.status(200).set('Content-Type', 'application/octet-stream');
  try {
    for await (const chunk of upstream.body) {
      if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
    }
    res.end();
  } catch (err) {
    if (!abort.signal.aborted) console.error('[sarvam] stream broke:', err.message);
    res.destroy();
  }
});
