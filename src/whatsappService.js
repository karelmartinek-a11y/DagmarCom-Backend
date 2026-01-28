const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const logger = require('./logger');
const db = require('./db');

async function sendWhatsAppMessage(phone, text) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  // fallback: log only when credentials absent
  if (!token || !phoneNumberId) {
    logger.warn({ phone, text }, 'WHATSAPP_TOKEN/PHONE_NUMBER_ID chybi - jen loguji');
    logPayload(phone, 'OUT', { text, dryRun: true });
    return { dryRun: true };
  }

  const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'text',
    text: { preview_url: false, body: text },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  logPayload(phone, 'OUT', { payload, response: data, status: res.status });

  if (!res.ok) {
    throw new Error(`WhatsApp API error ${res.status}`);
  }
  return data;
}

function logPayload(phone, direction, payload) {
  db.run(
    'INSERT INTO logs(phone, direction, payload, created_at) VALUES(?,?,?,?)',
    [phone || null, direction, JSON.stringify(payload), Date.now()],
    (err) => {
      if (err) logger.error({ err }, 'Log insert failed');
    }
  );
}

module.exports = { sendWhatsAppMessage, logPayload };
