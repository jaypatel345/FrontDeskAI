import { config } from '../config.js';

const isLive = Boolean(config.twilio.accountSid && config.twilio.authToken && config.twilio.fromNumber);

let client = null;
if (isLive) {
  const { default: Twilio } = await import('twilio');
  client = Twilio(config.twilio.accountSid, config.twilio.authToken);
}

export async function sendConfirmationSms({ to, body }) {
  if (!isLive) {
    console.log('[sms:mock] would send to', to, '\n', body);
    return { sid: null, mode: 'mock' };
  }
  const msg = await client.messages.create({ to, from: config.twilio.fromNumber, body });
  return { sid: msg.sid, mode: 'live' };
}

export const smsMode = isLive ? 'twilio (live)' : 'mock (no Twilio credentials set)';
