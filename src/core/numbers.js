// @ts-check
'use strict';
/**
 * Nummernkreise je Präfix und Jahr (DATA_MODEL.md Abschnitt 4).
 * Muss innerhalb einer Transaktion aufgerufen werden, damit zwei gleichzeitige Vorgänge nie dieselbe Nummer erhalten.
 */

/**
 * @param {import('../db').Database} db
 * @param {string} prefix  z. B. "DC-CR"
 * @param {number} [year]
 * @returns {string}       z. B. "DC-CR-2026-0001"
 */
function nextNumber(db, prefix, year = new Date().getUTCFullYear()) {
  db.prepare(`INSERT INTO number_sequences (prefix, year, last_value) VALUES (?, ?, 1)
    ON CONFLICT (prefix, year) DO UPDATE SET last_value = last_value + 1`).run(prefix, year);
  const { last_value: n } = /** @type {any} */ (db.prepare('SELECT last_value FROM number_sequences WHERE prefix = ? AND year = ?').get(prefix, year));
  return `${prefix}-${year}-${String(n).padStart(4, '0')}`;
}

module.exports = { nextNumber };
