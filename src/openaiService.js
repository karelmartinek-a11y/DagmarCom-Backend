const logger = require('./logger');
const { getSettings } = require('./settingsService');

async function callOpenAI({ messages, responseId }) {
  const settings = await getSettings();
  const apiKey = process.env.OPENAI_API_KEY || settings.openaiApiKey;
  if (!apiKey) {
    throw new Error('Chybi OPENAI_API_KEY');
  }

  const model = settings.openaiModel || 'gpt-4.1';
  const body = {
    model,
    messages,
    metadata: { source: 'DagmarCom' },
  };

  if (responseId) {
    body.response_id = responseId; // navazani na konverzaci dle zadani
  }

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    const redacted = text.replace(/sk-[A-Za-z0-9_\-]{10,}/g, '[redacted]');
    logger.error({ status: res.status, text: redacted }, 'OpenAI call failed');
    throw new Error(`OpenAI API error ${res.status}`);
  }

  const data = await res.json();
  const firstOutput = data.output?.[0]?.content?.[0]?.text || data.choices?.[0]?.message?.content || '';
  const responseIdResult = data.id || data.response_id || null;

  return { text: firstOutput, responseId: responseIdResult, raw: data };
}

module.exports = { callOpenAI };
