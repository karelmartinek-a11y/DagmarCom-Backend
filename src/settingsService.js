const db = require('./db');
const logger = require('./logger');

const DEFAULTS = {
  autoEnabled: true,
  instructions:
    'Odpovidej strucne, jasne a v cestine. Poskytuj pouze verejne dostupne informace o hotelu Chodov ASC v Praze a okoli.',
  role: 'Hotel concierge AI',
  context:
    'Jednas jmenem hotelu Chodov ASC (Aqua Sport Club s.r.o., Medrova 169/22, 142 00 Praha 4, ICO 27125529). Reaguj profesionalne a zdvorile.',
  inputSuffix:
    '\n\n---\nDolozka: dopln a strukturovane odpovez na dotaz hosta. Pokud chybi informace, navrhni jak ji zjistit.',
  outputPrefixFirst:
    'Dekujeme za zpravu. Jsem digitalni concierge hotelu Chodov ASC. ',
  outputPrefixNext:
    'Znovu dekuji za zpravu. ',
  outputPrefixAlways:
    '\n\nPro pripadne rezervace volejte +420261090900 nebo piste na recepce@hotelchodov.cz.',
  openaiApiKey: '',
  openaiModel: 'gpt-4.1',
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
  return Object.fromEntries(entries);
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

module.exports = { getSettings, updateSettings, DEFAULTS };
