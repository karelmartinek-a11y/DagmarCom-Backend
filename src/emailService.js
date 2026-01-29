const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');
const logger = require('./logger');
const { getSettings } = require('./settingsService');
const { callOpenAI } = require('./openaiService');
const db = require('./db');

function buildImapClient(settings) {
  return new ImapFlow({
    host: settings.imapHost,
    port: Number(settings.imapPort) || 993,
    secure: Number(settings.imapPort) === 993,
    auth: {
      user: settings.imapUser,
      pass: settings.imapPass,
    },
  });
}

function buildSmtpTransport(settings) {
  return nodemailer.createTransport({
    host: settings.smtpHost,
    port: Number(settings.smtpPort) || 587,
    secure: Number(settings.smtpPort) === 465,
    auth: {
      user: settings.smtpUser,
      pass: settings.smtpPass,
    },
  });
}

async function logEmail(direction, payload, email) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO logs (phone, direction, payload, created_at) VALUES (?, ?, ?, ?)',
      [email || null, direction, typeof payload === 'string' ? payload : JSON.stringify(payload), Date.now()],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function isSpam(parsed) {
  const subject = (parsed.subject || '').toLowerCase();
  const from = (parsed.from?.text || '').toLowerCase();
  const body = (parsed.text || '').toLowerCase();
  const badWords = ['viagra', 'casino', 'loan', 'crypto', 'bitcoins', 'porn'];
  const badDomains = ['.ru', '.cn', '.su'];
  if (badWords.some((w) => subject.includes(w) || body.includes(w))) return true;
  if (badDomains.some((d) => from.endsWith(d))) return true;
  const spamScore = Number(parsed.headers.get('spam-score') || parsed.headers.get('x-spam-score') || 0);
  if (!Number.isNaN(spamScore) && spamScore > 5) return true;
  return false;
}

async function processInbox() {
  const settings = await getSettings();
  if (!settings.emailAutoEnabled) {
    logger.info('Email auto odpovedi jsou vypnute');
    return;
  }
  const imap = buildImapClient(settings);
  await imap.connect();
  const inbox = settings.imapInbox || 'INBOX';
  await imap.mailboxOpen(inbox);

  const lock = await imap.getMailboxLock(inbox);
  try {
    const unseen = await imap.search({ seen: false });
    const sorted = (unseen || []).sort((a, b) => a - b);
    for (const seq of sorted) {
      let msg;
      try {
        msg = await imap.fetchOne(`${seq}`, { source: true, envelope: true, internalDate: true });
      } catch (e) {
        await logEmail('EMAIL_ERROR', { error: e.message, seq }, null);
        logger.error({ err: e, seq }, 'Email fetch failed');
        continue;
      }
      if (!msg?.source) continue;
      try {
        const parsed = await simpleParser(msg.source);
        const fromAddr = parsed.from?.text || '';
        const payloadPreview = { subject: parsed.subject, from: fromAddr, date: parsed.date };
        if (isSpam(parsed)) {
          const spamFolder = settings.imapSpam || 'Spam';
          await safeMove(imap, seq, spamFolder);
          await imap.messageFlagsAdd(seq, ['\\Seen']);
          await logEmail('EMAIL_SPAM', { ...payloadPreview, movedTo: spamFolder }, fromAddr);
          logger.warn({ subject: parsed.subject }, 'Email oznacen jako spam');
        } else {
          const { replyText, subject, inReplyTo, references } = await buildAiReply(parsed, settings);
          if (settings.emailSendMode === 'send') {
            const transport = buildSmtpTransport(settings);
            await transport.sendMail({
              from: settings.smtpUser || settings.imapUser,
              to: fromAddr,
              subject,
              text: replyText,
              references: parsed.messageId ? [parsed.messageId] : undefined,
              inReplyTo: parsed.messageId || undefined,
            });
            await safeMove(imap, seq, settings.imapSent || 'Sent');
            const sentFolder = settings.imapSent || 'Sent';
            await logEmail(
              'EMAIL_SENT',
              { to: fromAddr, subject, preview: replyText.slice(0, 400), movedTo: sentFolder },
              fromAddr
            );
          } else {
            const rawDraft = buildDraftMime({
              from: settings.smtpUser || settings.imapUser,
              to: fromAddr,
              subject,
              inReplyTo: parsed.messageId,
              references: parsed.messageId ? [parsed.messageId] : [],
              text: replyText,
            });
            const draftFolder = settings.imapDrafts || 'Drafts';
            await safeAppend(imap, draftFolder, rawDraft);
            await imap.messageFlagsAdd(seq, ['\\Seen']);
            await logEmail(
              'EMAIL_DRAFT',
              { to: fromAddr, subject, preview: replyText.slice(0, 400), savedTo: draftFolder },
              fromAddr
            );
          }
        }
      } catch (inner) {
        await logEmail('EMAIL_ERROR', { error: inner.message, seq }, null);
        logger.error({ err: inner, seq }, 'Email processing failed');
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    lock.release();
    await imap.logout();
  }
}

async function buildAiReply(parsed, settings) {
  const combinedText = `Od: ${parsed.from?.text || ''}\nPredmet: ${parsed.subject || ''}\n\n${parsed.text || ''}`;
  const messages = [
    {
      role: 'developer',
      content: `${settings.roleNext || settings.roleFirst || ''}\n${settings.contextNext || settings.contextFirst || ''}`,
    },
    {
      role: 'user',
      content: combinedText,
    },
  ];
  const ai = await callOpenAI({
    instructions: settings.instructionsNext || settings.instructionsFirst,
    developerContent: messages[0].content,
    userInput: messages[1].content,
    responseId: null,
  });
  const history = buildHistorySection(parsed);
  const replyText = `${settings.outputPrefixNext || settings.outputPrefixFirst || ''}${ai.text}${settings.outputPrefixAlways || ''}\n\n${history}`;
  const subject = 'Re: ' + (parsed.subject || '');
  const inReplyTo = parsed.messageId || null;
  const references = parsed.messageId ? [parsed.messageId] : [];
  return { replyText, subject, inReplyTo, references };
}

function buildHistorySection(parsed) {
  const header = '### HISTORIE PŘIJATÉHO EMAILU';
  const from = parsed.from?.text || '';
  const to = parsed.to?.text || parsed.to?.value?.map((v) => v.address).join(', ') || '';
  const date = parsed.date ? parsed.date.toISOString?.() || parsed.date : '';
  const subj = parsed.subject || '';
  const body = parsed.text || '';
  return [header, `Od: ${from}`, `Komu: ${to}`, `Datum: ${date}`, `Předmět: ${subj}`, '', body].join('\n');
}

async function testEmailConnections() {
  const settings = await getSettings();
  const imap = buildImapClient(settings);
  await imap.connect();
  await imap.logout();
  const smtp = buildSmtpTransport(settings);
  await smtp.verify();
  return true;
}

async function sendResetEmail(to, token, originHint) {
  const settings = await getSettings();
  if (!settings.smtpHost || !settings.smtpUser || !settings.smtpPass) {
    const err = new Error('Chybí SMTP konfigurace v nastavení');
    err.code = 'SMTP_CONFIG_MISSING';
    throw err;
  }
  const transport = buildSmtpTransport(settings);
  const base = originHint || 'https://api.hcasc.cz';
  const settingsLink = `${base}/settings?token=${token}`;
  const statusLink = `${base}/status?token=${token}`;
  const body = [
    'Dobrý den,',
    '',
    'požádali jste o reset hesla pro panel DagmarCom.',
    'Použijte níže uvedený token nebo přímo otevřete jeden z odkazů:',
    '',
    `Token: ${token}`,
    `Nastavení: ${settingsLink}`,
    `Status: ${statusLink}`,
    '',
    'Token platí 60 minut. Pokud jste změnu nevyžádali, ignorujte tento e-mail.',
  ].join('\n');
  await transport.sendMail({
    from: settings.smtpUser || settings.imapUser,
    to,
    subject: 'DagmarCom – reset hesla',
    text: body,
  });
  await logEmail('EMAIL_RESET', { to, settingsLink, statusLink }, to);
  return true;
}

async function listMailboxes() {
  const settings = await getSettings();
  if (!settings.imapHost || !settings.imapUser || !settings.imapPass) {
    const err = new Error('Chybí IMAP host/user/heslo v nastavení');
    err.code = 'IMAP_CONFIG_MISSING';
    throw err;
  }
  const imap = buildImapClient(settings);
  await imap.connect();
  const boxes = [];
  const listing = imap.list();
  if (listing && typeof listing[Symbol.asyncIterator] === 'function') {
    for await (const mailbox of listing) {
      boxes.push(mailbox.path);
    }
  } else {
    const arr = await listing;
    (arr || []).forEach((mailbox) => boxes.push(mailbox.path || mailbox.name || mailbox));
  }
  await imap.logout();
  return boxes;
}

function buildDraftMime({ from, to, subject, text, inReplyTo, references = [] }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references.length) headers.push(`References: ${references.join(' ')}`);
  return `${headers.join('\r\n')}\r\n\r\n${text}`;
}

async function safeMove(imap, uid, target) {
  try {
    await imap.messageMove(uid, target);
  } catch (e) {
    logger.warn({ target, err: e }, 'Nepodarilo se presunout zpravu, ponechavam v INBOX');
  }
}

async function safeAppend(imap, mailbox, raw) {
  return imap.append(mailbox, raw);
}

module.exports = { processInbox, testEmailConnections, listMailboxes, sendResetEmail };
