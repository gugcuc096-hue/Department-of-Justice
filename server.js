// @ts-check
'use strict';
require('dotenv').config({ quiet: true });

const { loadConfig } = require('./src/config');
const { createLogger } = require('./src/http/logger');
const { openDatabase } = require('./src/db');
const { migrate } = require('./src/db/migrate');
const { seed } = require('./src/db/seeds');
const { createApp } = require('./src/app');

function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const db = openDatabase(config.dbPath);
  migrate(db, logger);
  seed(db, { config, logger });

  const { app, ctx } = createApp({ db, config, logger });
  // Abgelaufene Sessions regelmäßig entfernen
  const purge = setInterval(() => ctx.sessions.purgeExpired(), 15 * 60_000);
  purge.unref();
  // Erinnerungen an Fristen und Termine (idempotent)
  const remind = () => { try { ctx.reminders.runReminders(); } catch (err) { logger.error('reminder job failed', { err }); } };
  remind();
  const reminders = setInterval(remind, 10 * 60_000);
  reminders.unref();
  const server = app.listen(config.port, () => {
    logger.info('San Andreas Justice Command System started', { port: config.port, env: config.env });
  });
  server.on('error', (err) => {
    const code = /** @type {any} */ (err).code;
    logger.error(code === 'EADDRINUSE' ? `port ${config.port} is already in use – is another instance running? (set PORT in .env)` : 'server error', { err });
    db.close();
    process.exit(1);
  });

  const shutdown = (signal) => {
    logger.info('shutting down', { signal });
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

try {
  main();
} catch (err) {
  process.stderr.write(`Startup failed: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
}
