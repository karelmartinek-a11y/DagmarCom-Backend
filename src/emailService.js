const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');
const logger = require('./logger');
const { getSettings } = require('./settingsService');
const { callOpenAI } = require('./openaiService');

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

function isSpam(parsed) {
  const subject = (parsed.subject || '').toLowerCase();
  const from = (parsed.from?.text || '').toLowerCase();
  const body = (parsed.text || '').toLowerCase();
  const badWords = ['viagra', 'casino', 'loan', 'crypto', 'bitcoins', 'porn'];
  const badDomains = ['.ru', '.cn', '.su'];
  if (badWords.some((w) => subject.includes(w) || body.includes(w))) return true;
  if (badDomains.some((d) => from.endsWith(d))) return true;
  if ((parsed.headers.get('spam-score') || 0) > 5) return true;
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
  await imap.mailboxOpen(settings.imapInbox || 'INBOX');

  const lock = await imap.getMailboxLock(settings.imapInbox || 'INBOX');
  try {
    for await (const msg of imap.fetch({ seen: false }, { source: true, envelope: true, internalDate: true })) {
      const parsed = await simpleParser(msg.source);
      if (isSpam(parsed)) {
        await imap.messageMove(msg.uid, settings.imapSpam || 'SPAM');
        logger.warn({ subject: parsed.subject }, 'Email oznacen jako spam');
        continue;
      }
      const { replyText } = await buildAiReply(parsed, settings);
      if (settings.emailSendMode === 'send') {
        const transport = buildSmtpTransport(settings);
        await transport.sendMail({
          from: settings.smtpUser || settings.imapUser,
          to: parsed.from?.text,
          subject: 'Re: ' + (parsed.subject || ''),
          text: replyText,
          references: parsed.messageId ? [parsed.messageId] : undefined,
          inReplyTo: parsed.messageId || undefined,
        });
        await imap.messageMove(msg.uid, settings.imapSent || 'Sent');
      } else {
        // uloz do konceptu
        await imap.append(settings.imapDrafts || 'Drafts', replyText, { flags: ['\\Draft'] });
        await imap.messageMove(msg.uid, settings.imapInbox || 'INBOX');
      }
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
  const ai = await callOpenAI({ instructions: settings.instructionsNext || settings.instructionsFirst, developerContent: messages[0].content, userInput: messages[1].content, responseId: null });
  const replyText = `${settings.outputPrefixNext || settings.outputPrefixFirst || ''}${ai.text}${settings.outputPrefixAlways || ''}`;
  return { replyText };
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

module.exports = { processInbox, testEmailConnections };
