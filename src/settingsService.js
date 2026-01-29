const db = require('./db');
const logger = require('./logger');

const DEFAULTS = {
  autoEnabled: true,
  instructionsFirst:
    'Odpovidej strucne, jasne a v cestine. Poskytuj pouze verejne dostupne informace o hotelu Chodov ASC v Praze a okoli.',
  instructionsNext:
    'Pokud jde o navazujici dotaz, drz se predchoziho kontextu a udrzuj odpoved kratkou.',
  instructionsAlways:
    'Vyhybej se citlivym udajum hostu, neposkytuj osobni data ani rezervacni udaje.',
  roleFirst: 'Hotel concierge AI',
  roleNext: 'Hotel concierge AI',
  roleAlways: '',
  contextFirst:
    'Jednas jmenem hotelu Chodov ASC (Aqua Sport Club s.r.o., Medrova 169/22, 142 00 Praha 4, ICO 27125529). Reaguj profesionalne a zdvorile.',
  contextNext: 'Pokracuj v tonaci a referencich na hotel Chodov ASC.',
  contextAlways: '',
  inputSuffixFirst:
    '\n\n---\nDolozka: dopln a strukturovane odpovez na dotaz hosta. Pokud chybi informace, navrhni jak ji zjistit.',
  inputSuffixNext: '\n\n---\nNavazuj na predchozi odpoved a vyhni se opakovani.',
  inputSuffixAlways: '',
  outputPrefixFirst:
    'Dekujeme za zpravu. Jsem digitalni concierge hotelu Chodov ASC. ',
  outputPrefixNext:
    'Znovu dekuji za zpravu. ',
  outputPrefixAlways:
    '\n\nPro pripadne rezervace volejte +420261090900 nebo piste na recepce@hotelchodov.cz.',
  openaiApiKey: '',
  openaiModel: 'gpt-4.1',
  emailAutoEnabled: false,
  emailSendMode: 'draft', // draft | send
  imapHost: '',
  imapPort: 993,
  imapUser: '',
  imapPass: '',
  imapInbox: 'INBOX',
  imapSpam: 'SPAM',
  imapDrafts: 'Drafts',
  imapSent: 'Sent',
  pop3Host: '',
  pop3Port: 110,
  pop3User: '',
  pop3Pass: '',
  pop3UseSsl: false,
  smtpHost: '',
  smtpPort: 587,
  smtpUser: '',
  smtpPass: '',
  adminUsername: '',
  adminPasswordHash: '',
};

function getSetting(key) {
  return new Promise((resolve, reject) => {
    db.get('SELECT value FROM settings WHERE key = ?', [key], (err, row) => {
      if (err) return reject(err);
      if (!row) return resolve(DEFAULTS[key]);
      try {
        resolve(JSON.parse(row.value));
      } catch (e) {
        resolve(row.value);
      }
    });
  });
}

async function getSettings() {
  const entries = await Promise.all(
    Object.keys(DEFAULTS).map(async (key) => [key, await getSetting(key)])
  );
  const result = Object.fromEntries(entries);
  if (!result.openaiApiKey && process.env.OPENAI_API_KEY) {
    result.openaiApiKey = process.env.OPENAI_API_KEY;
  }
  if (!result.adminUsername && process.env.BASIC_USER) {
    result.adminUsername = process.env.BASIC_USER;
  }
  return result;
}

function setSetting(key, value) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, JSON.stringify(value)],
      (err) => {
        if (err) return reject(err);
        logger.info({ key }, 'Nastaveni ulozeno');
        resolve();
      }
    );
  });
}

async function updateSettings(body) {
  const allowedKeys = Object.keys(DEFAULTS);
  for (const key of allowedKeys) {
    if (body[key] !== undefined) {
      await setSetting(key, body[key]);
    }
  }
  return getSettings();
}

async function saveAdminCredentials(username, passwordHash) {
  if (username !== undefined) {
    await setSetting('adminUsername', username);
  }
  if (passwordHash !== undefined) {
    await setSetting('adminPasswordHash', passwordHash);
  }
  return getSettings();
}

module.exports = { getSettings, updateSettings, DEFAULTS, saveAdminCredentials };
