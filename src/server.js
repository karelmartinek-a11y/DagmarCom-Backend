require('dotenv').config();
const express = require('express');
const cors = require('cors');
const basicAuth = require('basic-auth');
const db = require('./db');
const logger = require('./logger');
const { enqueueMessage } = require('./queue');
const { getSettings, updateSettings } = require('./settingsService');
const { logPayload } = require('./whatsappService');

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
