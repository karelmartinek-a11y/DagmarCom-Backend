const db = require('./db');
const logger = require('./logger');
const { getSettings } = require('./settingsService');
const { callOpenAI } = require('./openaiService');
const { sendWhatsAppMessage, logPayload } = require('./whatsappService');

const EIGHT_HOURS = 8 * 60 * 60 * 1000;
const DELETE_BASE_URL = process.env.DELETE_BASE_URL || 'https://api.hcasc.cz/delete';
const locks = new Map();

function runQuery(query, params = []) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function runStmt(query, params = []) {
  return new Promise((resolve, reject) => {
    db.run(query, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

async function ensureSession(phone) {
  const rows = await runQuery('SELECT * FROM sessions WHERE phone = ?', [phone]);
  if (rows.length === 0) {
    await runStmt('INSERT INTO sessions(phone, response_count, processing) VALUES(?,?,?)', [phone, 0, 0]);
    return { phone, last_response_id: null, last_response_at: null, response_count: 0, processing: 0 };
  }
  return rows[0];
}

async function enqueueMessage(phone, body) {
  await runStmt(
    'INSERT INTO message_queue(phone, body, received_at) VALUES(?,?,?)',
    [phone, body, Date.now()]
  );
  await processQueue(phone);
}

async function processQueue(phone) {
  if (locks.get(phone)) {
    logger.debug({ phone }, 'Fronta uz bezi, skip');
    return;
  }
  locks.set(phone, true);

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const pending = await runQuery(
        'SELECT * FROM message_queue WHERE phone = ? AND processed = 0 ORDER BY received_at ASC',
        [phone]
      );
      if (pending.length === 0) break;

      let session = await ensureSession(phone);
      const now = Date.now();

      if (session.last_response_at && now - session.last_response_at > EIGHT_HOURS && session.last_response_id) {
        await sendRetentionNotice(phone);
        await runStmt(
          'UPDATE sessions SET last_response_id = NULL, last_response_at = NULL, response_count = 0 WHERE phone = ?',
          [phone]
        );
        session = await ensureSession(phone);
      }

      const settings = await getSettings();
      if (!settings.autoEnabled) {
        logger.info({ phone }, 'Automaticke odpovedi vypnuty');
        break;
      }

      const instr = selectByCount(
        session.response_count,
        settings.instructionsFirst,
        settings.instructionsNext,
        settings.instructionsAlways
      );
      const role = selectByCount(session.response_count, settings.roleFirst, settings.roleNext, settings.roleAlways);
      const context = selectByCount(
        session.response_count,
        settings.contextFirst,
        settings.contextNext,
        settings.contextAlways
      );
      const inputSuffix = selectByCount(
        session.response_count,
        settings.inputSuffixFirst,
        settings.inputSuffixNext,
        settings.inputSuffixAlways
      );

      const combinedUserText = pending.map((p) => p.body).join('\n---\n');
      const instructions = instr.trim();
      const developerContent = [role].filter(Boolean).join('\n').trim();
      const userInput = [context, combinedUserText].filter(Boolean).join('\n\n').trim() + (inputSuffix || '');

      const responseId =
        session.last_response_id && session.last_response_at && now - session.last_response_at <= EIGHT_HOURS
          ? session.last_response_id
          : null;

      logPayload(phone, 'IN', { userInput, developerContent, responseId });

      try {
        const aiResponse = await callOpenAI({ instructions, developerContent, userInput, responseId });

        const outboundText = buildOutboundText(settings, session.response_count, aiResponse.text);
        await safeSendWhatsAppMessage(phone, outboundText);

        await runStmt('UPDATE message_queue SET processed = 1 WHERE phone = ? AND processed = 0', [phone]);
        await runStmt(
          'UPDATE sessions SET last_response_id = ?, last_response_at = ?, response_count = response_count + 1 WHERE phone = ?',
          [aiResponse.responseId || null, Date.now(), phone]
        );
      } catch (err) {
        logger.error({ err, phone }, 'Chyba pri generovani/odeslani odpovedi');
        await safeSendWhatsAppMessage(
          phone,
          'Omlouvame se, automaticka odpoved se ted nepodarila odeslat. Zkuste to prosim znovu nebo volejte recepci +420261090900.'
        );
        await runStmt('UPDATE message_queue SET processed = 1 WHERE phone = ? AND processed = 0', [phone]);
      }
    }
  } catch (err) {
    logger.error({ err, phone }, 'Chyba pri zpracovani fronty');
  } finally {
    locks.delete(phone);
  }
}

function buildOutboundText(settings, responseCount, aiText) {
  const parts = [];
  if (responseCount === 0 && settings.outputPrefixFirst) parts.push(settings.outputPrefixFirst);
  if (responseCount > 0 && settings.outputPrefixNext) parts.push(settings.outputPrefixNext);
  if (aiText) parts.push(aiText.trim());
  if (settings.outputPrefixAlways) parts.push(settings.outputPrefixAlways);
  return parts.join('');
}

function selectByCount(count, first, next, always) {
  const parts = [];
  if (count === 0 && first) parts.push(first);
  if (count > 0 && next) parts.push(next);
  if (always) parts.push(always);
  return parts.join('\n').trim();
}

async function sendRetentionNotice(phone) {
  const text =
    'Chat byl po 8 hodinach uzavren. Informace z konverzace uchovavame 30 dni pro audit a bezpecnost. Pokud chcete okamzite smazat vsechny ulozene udaje, kliknete na: ' +
    `${DELETE_BASE_URL}?phone=${encodeURIComponent(phone)}`;
  await safeSendWhatsAppMessage(phone, text);
  logPayload(phone, 'OUT', { retentionNotice: true, phone });
}

async function safeSendWhatsAppMessage(phone, text) {
  try {
    await sendWhatsAppMessage(phone, text);
  } catch (err) {
    logger.error({ err, phone }, 'Odeslani WhatsApp zpravy selhalo');
  }
}

module.exports = { enqueueMessage, processQueue, ensureSession, buildOutboundText, selectByCount };
