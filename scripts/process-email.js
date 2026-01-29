#!/usr/bin/env node
require('dotenv').config();
const logger = require('../src/logger');
const { processInbox } = require('../src/emailService');

(async () => {
  try {
    await processInbox();
    process.exit(0);
  } catch (e) {
    logger.error({ err: e }, 'Cron email processing failed');
    process.exit(1);
  }
})();
