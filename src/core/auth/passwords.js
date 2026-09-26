// @ts-check
'use strict';
/**
 * Passwort-Hashing (bcrypt) und Passwort-Richtlinie (SECURITY_MODEL.md, Abschnitt 10).
 */
const bcrypt = require('bcryptjs');

const MIN_LENGTH = 12;
// bcrypt verarbeitet nur die ersten 72 Byte; längere Passwörter würden still abgeschnitten.
const MAX_BYTES = 72;

/**
 * @param {string} password
 * @returns {string | null} Fehlermeldung oder null, wenn gültig
 */
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_LENGTH) {
    return `Password must be at least ${MIN_LENGTH} characters long.`;
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_BYTES) {
    return `Password must not exceed ${MAX_BYTES} bytes.`;
  }
  if (!/[A-Za-z]/.test(password) || !/[^A-Za-z]/.test(password)) {
    return 'Password must contain letters and at least one number or symbol.';
  }
  return null;
}

/** @param {string} password @param {number} cost */
const hashPassword = (password, cost) => bcrypt.hash(password, cost);
/** @param {string} password @param {number} cost */
const hashPasswordSync = (password, cost) => bcrypt.hashSync(password, cost);

// Vergleich gegen einen Dummy-Hash, wenn der Benutzer nicht existiert – gleiche Laufzeit,
// damit sich existierende Benutzernamen nicht über die Antwortzeit erkennen lassen.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

/** @param {string} password @param {string | null | undefined} hash */
async function verifyPassword(password, hash) {
  const ok = await bcrypt.compare(String(password ?? ''), hash || DUMMY_HASH);
  return Boolean(hash) && ok;
}

module.exports = { validatePassword, hashPassword, hashPasswordSync, verifyPassword, MIN_LENGTH };
