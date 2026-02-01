require('dotenv').config();
const express = require('express');
const cors = require('cors');
const basicAuth = require('basic-auth');
const crypto = require('crypto');
const db = require('./db');
const logger = require('./logger');
const { enqueueMessage } = require('./queue');
const { getSettings, updateSettings, saveAdminCredentials } = require('./settingsService');
const { logPayload, sendWhatsAppMessage } = require('./whatsappService');
const { callOpenAI } = require('./openaiService');
const { processInbox, testEmailConnections, listMailboxes, sendResetEmail } = require('./emailService');

process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'Unhandled rejection');
});
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception');
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const BASIC_USER = process.env.BASIC_USER || 'admin';
const BASIC_PASS = process.env.BASIC_PASS || '+Sin8glov8';

function hashPassword(pass) {
  return crypto.createHash('sha256').update(pass).digest('hex');
}

async function getAuthConfig() {
  const settings = await getSettings();
  const user = settings.adminUsername || BASIC_USER;
  const passHash = settings.adminPasswordHash || hashPassword(BASIC_PASS);
  return { user, passHash };
}

async function auth(req, res, next) {
  try {
    const creds = basicAuth(req);
    const { user, passHash } = await getAuthConfig();
    if (!creds || creds.name !== user || hashPassword(creds.pass) !== passHash) {
      res.set('WWW-Authenticate', 'Basic realm="DagmarCom"');
      return res.status(401).send('Auth required');
    }
    return next();
  } catch (err) {
    logger.error({ err }, 'Auth failed');
    return res.status(503).json({ error: 'auth_failed' });
  }
}

function persistResetToken(email, token) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO reset_tokens(token, email, created_at) VALUES(?, ?, ?)',
      [token, email, Date.now()],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function consumeResetToken(token, maxAgeMinutes = 60) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM reset_tokens WHERE token = ?', [token], (err, row) => {
      if (err) return reject(err);
      if (!row) return resolve(null);
      if (row.created_at < Date.now() - maxAgeMinutes * 60 * 1000) {
        db.run('DELETE FROM reset_tokens WHERE token = ?', [token], () => resolve(null));
        return;
      }
      db.run('DELETE FROM reset_tokens WHERE token = ?', [token], () => resolve(row));
    });
  });
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/api/version', (req, res) => {
  res.json({
    backend_deploy_tag: process.env.DAGMARCOM_DEPLOY_TAG || 'unknown',
    environment: process.env.DAGMARCOM_ENV || process.env.NODE_ENV || 'production',
  });
});

app.post('/webhook/whatsapp', async (req, res) => {
  try {
    const { phone, text } = extractWhatsAppMessage(req.body);
    // Logujeme vždy, i statusy bez telefonu/textu
    logPayload(phone || null, 'IN', req.body);

    if (!phone || !text) {
      logger.warn({ body: req.body }, 'Webhook bez telefonu nebo textu (pravděpodobně status)');
      return res.status(200).json({ ok: true, ignored: true });
    }

    await enqueueMessage(phone, text);
    return res.status(200).json({ ok: true, queued: true });
  } catch (err) {
    logger.error({ err, body: req.body }, 'Webhook error');
    return res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/api/settings', auth, async (req, res) => {
  try {
    const settings = await getSettings();
    delete settings.adminPasswordHash;
    res.json(settings);
  } catch (err) {
    logger.error({ err }, 'Load settings failed');
    res.status(500).json({ error: 'settings_load_failed' });
  }
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

app.post('/api/status/reset-link', async (req, res) => {
  try {
    const { user } = req.body || {};
    const email = (user || '').trim();
    if (!email) return res.status(400).json({ error: 'email_required' });
    const token = crypto.randomBytes(24).toString('hex');
    await persistResetToken(email, token);
    const origin = req.headers.origin || `https://${req.headers.host || 'api.hcasc.cz'}`;
    await sendResetEmail(email, token, origin);
    res.json({ ok: true, message: 'Reset link odeslán na e-mail.' });
  } catch (err) {
    logger.error({ err }, 'Reset link failed');
    if (err.code === 'SMTP_CONFIG_MISSING') return res.status(400).json({ error: 'smtp_missing' });
    res.status(500).json({ error: 'reset_failed' });
  }
});

app.post('/api/status/reset-password', async (req, res) => {
  try {
    const { token, password, user } = req.body || {};
    if (!token || typeof token !== 'string' || token.length < 16) {
      return res.status(400).json({ error: 'token_invalid' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'password_too_short' });
    }
    const row = await consumeResetToken(token);
    if (!row) return res.status(400).json({ error: 'token_expired_or_invalid' });
    const username = (user || row.email || BASIC_USER).trim() || BASIC_USER;
    const hash = hashPassword(password);
    await saveAdminCredentials(username, hash);
    logger.info({ username }, 'Admin heslo bylo resetováno pomocí tokenu');
    res.json({ ok: true, message: 'Heslo nastaveno. Přihlašte se novým heslem.' });
  } catch (err) {
    logger.error({ err }, 'Reset password failed');
    res.status(500).json({ error: 'reset_failed' });
  }
});

app.post('/api/status/alert/whatsapp', async (req, res) => {
  try {
    const dest = process.env.ALERT_WA || '+420704602569';
    const { error, note } = req.body || {};
    const text = `DagmarCom STATUS chyba: ${error || 'neznámá'}${note ? ` | ${note}` : ''}`;
    const result = await sendWhatsAppMessage(dest, text);
    res.json({ ok: true, result });
  } catch (err) {
    logger.error({ err }, 'WA alert failed');
    res.status(500).json({ error: 'wa_alert_failed', detail: err.message });
  }
});

app.get('/api/status', auth, async (req, res) => {
  const normalizeLog = (row) => {
    if (!row) return null;
    const out = { ...row };
    const ts = Number(out.created_at);
    if (Number.isFinite(ts)) {
      out.created_at = ts;
      out.created_at_iso = new Date(ts).toISOString();
    } else {
      out.created_at = null;
      out.created_at_iso = null;
    }
    return out;
  };

  const settings = await getSettings();
  const apiKeySet = Boolean(process.env.OPENAI_API_KEY || settings.openaiApiKey);
  const whatsappSet = Boolean(process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_PHONE_NUMBER_ID);
  const emailSet = Boolean(
    settings.imapHost &&
      settings.smtpHost &&
      settings.imapUser &&
      settings.imapPass &&
      settings.smtpUser &&
      settings.smtpPass
  );
  const resetEmailReady = Boolean(settings.smtpHost && settings.smtpUser && settings.smtpPass);

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
  const lastEmail = await new Promise((resolve) => {
    db.get(
      "SELECT * FROM logs WHERE direction LIKE 'EMAIL_%' ORDER BY created_at DESC LIMIT 1",
      [],
      (err, row) => resolve(row || null)
    );
  });
  const lastEmailError = await new Promise((resolve) => {
    db.get(
      "SELECT * FROM logs WHERE direction = 'EMAIL_ERROR' ORDER BY created_at DESC LIMIT 1",
      [],
      (err, row) => resolve(row || null)
    );
  });
  const lastEmailErrorRecent =
    lastEmailError && lastEmailError.created_at < Date.now() - 30 * 60 * 1000 ? null : lastEmailError;
  const emailActivity24h = await new Promise((resolve) => {
    db.get(
      "SELECT count(*) as c FROM logs WHERE direction LIKE 'EMAIL_%' AND created_at >= ?",
      [Date.now() - 24 * 3600 * 1000],
      (err, row) => resolve(row ? row.c : 0)
    );
  });
  const emailDraftCount = await new Promise((resolve) => {
    db.get(
      "SELECT count(*) as c FROM logs WHERE direction = 'EMAIL_DRAFT' AND created_at >= ?",
      [Date.now() - 6 * 3600 * 1000],
      (err, row) => resolve(row ? row.c : 0)
    );
  });
  const emailHealthy =
    emailSet &&
    (!lastEmailErrorRecent || (lastEmail && lastEmail.created_at && lastEmail.created_at > lastEmailErrorRecent.created_at));

  const recentErrors = await new Promise((resolve) => {
    db.all(
      "SELECT * FROM logs WHERE direction = 'ERROR' AND created_at >= ? ORDER BY created_at DESC LIMIT 10",
      [Date.now() - 3 * 60 * 60 * 1000],
      (err, rows) => resolve(rows || [])
    );
  });

  const recentActivity = await new Promise((resolve) => {
    db.all(
      'SELECT direction, phone, payload, created_at FROM logs ORDER BY created_at DESC LIMIT 15',
      [],
      (err, rows) => resolve(rows || [])
    );
  });

  const uptimeSec = process.uptime();
  const load = require('os').loadavg();

  // extra metrics from status.json (generated healthprobe) if present
  let metrics = {};
  try {
    const fs = require('fs');
    const path = require('path');
    const p = path.join(__dirname, '..', 'data', 'status-cache.json');
    if (fs.existsSync(p)) {
      metrics = JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  } catch (e) {
    metrics = {};
  }

  res.json({
    apiKeySet,
    whatsappSet,
    emailSet,
    resetEmailReady,
    dbOk,
    uptimeSec,
    load,
    lastInbound: normalizeLog(lastIn),
    lastOutbound: normalizeLog(lastOut),
    lastOpenAIRequest: normalizeLog(lastOpenReq),
    lastOpenAIResponse: normalizeLog(lastOpenRes),
    lastEmail: normalizeLog(lastEmail),
    lastEmailError: normalizeLog(lastEmailErrorRecent),
    emailActivity24h,
    emailDraftCount,
    emailHealthy,
    recentErrors: recentErrors.map(normalizeLog),
    recentActivity: recentActivity.map(normalizeLog),
    metrics,
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

app.post('/api/email/test', auth, async (req, res) => {
  try {
    await testEmailConnections();
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'Email test failed');
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/email/process', auth, async (req, res) => {
  try {
    processInbox();
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'Email processing failed');
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/email/folders', auth, async (req, res) => {
  try {
    const boxes = await listMailboxes();
    res.json({ ok: true, boxes });
  } catch (e) {
    if (e.code === 'IMAP_CONFIG_MISSING') {
      return res.status(400).json({ ok: false, error: e.message });
    }
    logger.error({ err: e }, 'Email folders failed');
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/email/test-reset', auth, async (req, res) => {
  try {
    const { user } = req.body || {};
    const settings = await getSettings();
    const target = (user || settings.smtpUser || settings.imapUser || '').trim();
    if (!target) return res.status(400).json({ error: 'email_required' });
    const token = crypto.randomBytes(8).toString('hex');
    const origin = req.headers.origin || `https://${req.headers.host || 'api.hcasc.cz'}`;
    await sendResetEmail(target, token, origin);
    res.json({ ok: true, message: 'Testovací reset e-mail odeslán.' });
  } catch (e) {
    logger.error({ err: e }, 'Test reset email failed');
    res.status(500).json({ error: 'test_reset_failed', detail: e.message });
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
