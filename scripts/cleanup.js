const db = require('../src/db');
const logger = require('../src/logger');

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
const cutoff = Date.now() - THIRTY_DAYS;

function run(query, params = []) {
  return new Promise((resolve, reject) => {
    db.run(query, params, function (err) {
      if (err) return reject(err);
      resolve(this.changes);
    });
  });
}

(async () => {
  try {
    const deletedLogs = await run('DELETE FROM logs WHERE created_at < ?', [cutoff]);
    const deletedQueue = await run('DELETE FROM message_queue WHERE received_at < ?', [cutoff]);
    const deletedSessions = await run(
      'DELETE FROM sessions WHERE last_response_at IS NOT NULL AND last_response_at < ?',
      [cutoff]
    );
    logger.info({ deletedLogs, deletedQueue, deletedSessions, cutoff }, 'Cleanup done');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Cleanup failed');
    process.exit(1);
  }
})();
