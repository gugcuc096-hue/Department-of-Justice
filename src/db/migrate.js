// @ts-check
'use strict';
/**
 * Nummerierte SQL-Migrationen (src/db/migrations/NNN_name.sql).
 * Jede Migration läuft genau einmal, in einer Transaktion. Die Checksumme wird gespeichert;
 * wurde eine bereits angewendete Datei nachträglich verändert, bricht der Start ab (MIGRATION_NOTES.md).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { transaction, now } = require('./index');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/** @param {string} sql Zeilenenden normalisieren, damit CRLF/LF-Checkouts dieselbe Checksumme ergeben. */
const checksum = (sql) => crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');

/**
 * @param {import('./index').Database} db
 * @param {{ info: Function }} [logger]
 * @returns {string[]} neu angewendete Versionen
 */
function migrate(db, logger) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Map(
    db.prepare('SELECT version, checksum FROM schema_migrations').all().map((r) => [String(r.version), String(r.checksum)]),
  );
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();
  const done = [];

  for (const file of files) {
    const version = file.slice(0, 3);
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const sum = checksum(sql);
    if (applied.has(version)) {
      if (applied.get(version) !== sum) {
        throw new Error(`Migration ${file} wurde nach dem Anwenden verändert (Checksumme weicht ab). Neue Änderungen gehören in eine neue Migration.`);
      }
      continue;
    }
    transaction(db, () => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)').run(version, sum, now());
    });
    logger?.info('migration applied', { file });
    done.push(version);
  }
  return done;
}

module.exports = { migrate };
