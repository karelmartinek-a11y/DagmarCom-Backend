require('dotenv').config();
const express = require('express');
const cors = require('cors');
const basicAuth = require('basic-auth');
const db = require('./db');
const logger = require('./logger');
const { enqueueMessage } = require('./queue');
const { getSettings, updateSettings } = require('./settingsService');
const { logPayload, sendWhatsAppMessage } = require('./whatsappService');
const { callOpenAI } = require('./openaiService');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const BASIC_USER = process.env.BASIC_USER || 'admin';
const BASIC_PASS = process.env.BASIC_PASS || '+Sin8glov8';

function auth(req, res, next) {
  const creds = basicAuth(req);
  if (!creds || creds.name !== BASIC_USER || creds.pass !== BASIC_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="DagmarCom"');
    return res.status(401).send('Auth required');
  }
  return next();
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.post('/webhook/whatsapp', async (req, res) => {
  try {
    const { phone, text } = extractWhatsAppMessage(req.body);
    if (!phone || !text) {
      logger.warn({ body: req.body }, 'Webhook bez telefonu nebo textu');
      return res.status(400).json({ error: 'Missing phone or text' });
    }

    logPayload(phone, 'IN', req.body);
    await enqueueMessage(phone, text);
    return res.status(200).json({ ok: true });
  } catch (err) {
    logger.error({ err, body: req.body }, 'Webhook error');
    return res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/api/settings', auth, async (req, res) => {
  const settings = await getSettings();
  res.json(settings);
});

app.post('/api/settings', auth, async (req, res) => {
  try {
    const settings = await updateSettings(req.body || {});
    res.json(settings);
  } catch (err) {
    logger.error({ err }, 'Update settings failed');
    res.status(400).json({ error: 'invalid_settings' });
  }
});

app.get('/api/logs', auth, async (req, res) => {
  try {
    const { phone, q, from, to, limit = 200 } = req.query;
    const clauses = [];
    const params = [];
    if (phone) {
      clauses.push('phone = ?');
      params.push(phone);
    }
    if (from) {
      clauses.push('created_at >= ?');
      params.push(Number(from));
    }
    if (to) {
      clauses.push('created_at <= ?');
      params.push(Number(to));
    }
    if (q) {
      clauses.push('payload LIKE ?');
      params.push(`%${q}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM logs ${where} ORDER BY created_at DESC LIMIT ?`,
        [...params, Number(limit)],
        (err, data) => {
          if (err) return reject(err);
          resolve(data);
        }
      );
    });
    res.json(rows);
  } catch (err) {
    logger.error({ err }, 'Log query failed');
    res.status(500).json({ error: 'log_query_failed' });
  }
});

app.get('/api/logs/chat', auth, async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const rows = await new Promise((resolve, reject) => {
    db.all(
      'SELECT * FROM logs WHERE phone = ? ORDER BY created_at ASC',
      [phone],
      (err, data) => {
        if (err) return reject(err);
        resolve(data);
      }
    );
  });

  const lines = rows.map((r) => {
    const ts = new Date(r.created_at).toISOString();
    return `${ts} ${r.direction}: ${r.payload}`;
  });
  const content = lines.join('\n');
  if (req.headers.accept && req.headers.accept.includes('text/plain')) {
    res.setHeader('Content-Type', 'text/plain');
    return res.send(content);
  }
  return res.json({ phone, lines });
});

app.get('/api/status', auth, async (req, res) => {
  const settings = await getSettings();
  const apiKeySet = Boolean(process.env.OPENAI_API_KEY || settings.openaiApiKey);
  const whatsappSet = Boolean(process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_PHONE_NUMBER_ID);

  const dbOk = await new Promise((resolve) => {
    db.get('SELECT 1', [], (err) => resolve(!err));
  });

  const lastIn = await new Promise((resolve) => {
    db.get('SELECT * FROM logs WHERE direction = ? ORDER BY created_at DESC LIMIT 1', ['IN'], (err, row) =>
      resolve(row || null)
    );
  });
  const lastOut = await new Promise((resolve) => {
    db.get('SELECT * FROM logs WHERE direction = ? ORDER BY created_at DESC LIMIT 1', ['OUT'], (err, row) =>
      resolve(row || null)
    );
  });
  const lastOpenReq = await new Promise((resolve) => {
    db.get('SELECT * FROM logs WHERE direction = ? ORDER BY created_at DESC LIMIT 1', ['OPENAI_REQ'], (err, row) =>
      resolve(row || null)
    );
  });
  const lastOpenRes = await new Promise((resolve) => {
    db.get('SELECT * FROM logs WHERE direction = ? ORDER BY created_at DESC LIMIT 1', ['OPENAI_RES'], (err, row) =>
      resolve(row || null)
    );
  });

  const recentErrors = await new Promise((resolve) => {
    db.all(
      "SELECT * FROM logs WHERE direction = 'ERROR' AND created_at >= ? ORDER BY created_at DESC LIMIT 10",
      [Date.now() - 3 * 60 * 60 * 1000],
      (err, rows) => resolve(rows || [])
    );
  });

  const uptimeSec = process.uptime();
  const load = require('os').loadavg();

  res.json({
    apiKeySet,
    whatsappSet,
    dbOk,
    uptimeSec,
    load,
    lastInbound: lastIn,
    lastOutbound: lastOut,
    lastOpenAIRequest: lastOpenReq,
    lastOpenAIResponse: lastOpenRes,
    recentErrors,
  });
});

app.post('/api/status/test/openai', auth, async (req, res) => {
  try {
    const testMsg = [{ role: 'user', content: 'ping' }];
    const result = await callOpenAI({ messages: testMsg });
    res.json({ ok: true, responseId: result.responseId, preview: result.text.slice(0, 200) });
  } catch (e) {
    logger.error({ err: e }, 'OpenAI test failed');
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/status/test/whatsapp', auth, async (req, res) => {
  try {
    // harmless info call
    const token = process.env.WHATSAPP_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token || !phoneNumberId) throw new Error('Chybi WhatsApp token/id');
    const resp = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}?fields=id`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json();
    res.json({ ok: resp.ok, status: resp.status, body: data });
  } catch (e) {
    logger.error({ err: e }, 'WhatsApp test failed');
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/status/test/whatsapp/send', auth, async (req, res) => {
  try {
    const { phone, text } = req.body || {};
    if (!phone || !text) return res.status(400).json({ ok: false, error: 'phone and text required' });
    const result = await sendWhatsAppMessage(phone, text);
    res.json({ ok: true, result });
  } catch (e) {
    logger.error({ err: e }, 'WhatsApp send test failed');
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/delete', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).send('phone required');
  await new Promise((resolve, reject) => {
    db.run('DELETE FROM message_queue WHERE phone = ?', [phone], (err) => (err ? reject(err) : resolve()));
  });
  await new Promise((resolve, reject) => {
    db.run('DELETE FROM logs WHERE phone = ?', [phone], (err) => (err ? reject(err) : resolve()));
  });
  await new Promise((resolve, reject) => {
    db.run('DELETE FROM sessions WHERE phone = ?', [phone], (err) => (err ? reject(err) : resolve()));
  });
  logger.info({ phone }, 'Data pro telefon smazana na zadost uzivatele');
  res.send('Data byla smazana.');
});

function extractWhatsAppMessage(body) {
  // Minimalisticka extrakce z Meta webhooku
  const entry = body?.entry?.[0];
  const change = entry?.changes?.[0];
  const msg = change?.value?.messages?.[0];
  const phone = msg?.from || body.phone || null;
  const text = msg?.text?.body || body.text || null;
  return { phone, text };
}

const port = process.env.PORT || 8080;
app.listen(port, () => {
  logger.info({ port }, 'DagmarCom backend naslouchá');
});

module.exports = app;
