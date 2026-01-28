const logger = require('./logger');
const { getSettings } = require('./settingsService');

const db = require('./db');
const { logPayload } = require('./whatsappService');

function logOpenAI(direction, payload) {
  db.run(
    'INSERT INTO logs(phone, direction, payload, created_at) VALUES(?,?,?,?)',
    [null, direction, JSON.stringify(payload), Date.now()],
    (err) => {
      if (err) logger.error({ err }, 'Log OpenAI insert failed');
    }
  );
}

async function callOpenAI({ messages, responseId }) {
  const settings = await getSettings();
  const apiKey = process.env.OPENAI_API_KEY || settings.openaiApiKey;
  if (!apiKey) {
    throw new Error('Chybi OPENAI_API_KEY');
  }

  const model = settings.openaiModel || 'gpt-4.1';
  const body = {
    model,
    input: messages, // Responses API 2025 pouziva 'input' namisto 'messages'
    metadata: { source: 'DagmarCom' },
  };

  if (responseId) {
    body.previous_response_id = responseId; // Responses API (2025) navazuje konverzaci
  }

  logOpenAI('OPENAI_REQ', {
    model,
    previous_response_id: responseId || null,
    inputPreview: JSON.stringify(body).slice(0, 500),
  });

  const data = await doRequest(apiKey, body);
  const firstOutput = data.output?.[0]?.content?.[0]?.text || data.choices?.[0]?.message?.content || '';
  const responseIdResult = data.id || data.response_id || null;

  logOpenAI('OPENAI_RES', { responseId: responseIdResult, preview: firstOutput.slice(0, 500) });

  return { text: firstOutput, responseId: responseIdResult, raw: data };
}

async function doRequest(apiKey, body) {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const redacted = text.replace(/sk-[A-Za-z0-9_\\-]{10,}/g, '[redacted]');
  if (!res.ok) {
    logger.error({ status: res.status, text: redacted, attempt: 'primary' }, 'OpenAI call failed');
    throw new Error(`OpenAI API error ${res.status}`);
  }
  return JSON.parse(text);
}

module.exports = { callOpenAI };
