// @ts-check
'use strict';
/**
 * System Log: technische Ereignisse als JSON-Zeilen auf stdout/stderr.
 * Getrennt vom Audit Log (Benutzeraktivitäten, liegt in der Datenbank).
 * Niemals Passwörter, Session-Token oder Akteninhalte loggen.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * @typedef {{ debug: (msg: string, data?: object) => void, info: (msg: string, data?: object) => void,
 *   warn: (msg: string, data?: object) => void, error: (msg: string, data?: object) => void }} Logger
 */

/**
 * @param {keyof typeof LEVELS} [level]
 * @returns {Logger}
 */
function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;
  /** @param {keyof typeof LEVELS} lvl */
  const emit = (lvl) => (/** @type {string} */ msg, /** @type {object} */ data = {}) => {
    if (LEVELS[lvl] < threshold) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...serialize(data) });
    (LEVELS[lvl] >= LEVELS.warn ? process.stderr : process.stdout).write(line + '\n');
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

/** Error-Objekte lesbar machen (JSON.stringify verliert message und stack). */
function serialize(data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v;
  }
  return out;
}

module.exports = { createLogger };
