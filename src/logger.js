const pino = require('pino');
const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const transport = pino.transport({
  targets: [
    {
      level: 'info',
      target: 'pino/file',
      options: { destination: path.join(logDir, 'app.log') },
    },
    {
      level: 'debug',
      target: 'pino-pretty',
      options: { colorize: true },
    },
  ],
});

const logger = pino({ level: process.env.LOG_LEVEL || 'info' }, transport);

module.exports = logger;
