// @ts-check
'use strict';
/**
 * Serverseitige Sessions (SECURITY_MODEL.md, Abschnitt 10).
 * Das Cookie enthält ein 32-Byte-Zufallstoken; in der Datenbank liegt nur dessen SHA-256.
 */
const crypto = require('crypto');
const { now } = require('../../db');

const COOKIE_NAME = 'sjcs_sid';
const TOUCH_INTERVAL_MS = 60_000;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');

/**
 * @typedef {{ token_hash: string, user_id: number, csrf_token: string, active_org_id: number|null,
 *   created_at: string, last_seen_at: string, expires_at: string }} SessionRow
 */

/**
 * @param {import('../../db').Database} db
 * @param {import('../../config').Config} config
 */
function createSessionStore(db, config) {
  const insert = db.prepare(`INSERT INTO sessions
    (token_hash, user_id, csrf_token, active_org_id, created_at, last_seen_at, expires_at, ip, user_agent)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const byHash = db.prepare('SELECT * FROM sessions WHERE token_hash = ?');
  const del = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const delUser = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?');
  const touch = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?');
  const setOrg = db.prepare('UPDATE sessions SET active_org_id = ? WHERE token_hash = ?');
  const purge = db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?');

  return {
    /** @param {{ userId: number, activeOrgId: number|null, ip: string, userAgent: string }} o */
    create({ userId, activeOrgId, ip, userAgent }) {
      const token = randomToken();
      const csrfToken = randomToken();
      const ts = now();
      const expires = new Date(Date.now() + config.sessionMaxMs).toISOString();
      insert.run(sha256(token), userId, csrfToken, activeOrgId, ts, ts, expires, ip ?? '', (userAgent ?? '').slice(0, 300));
      return { token, csrfToken, tokenHash: sha256(token) };
    },

    /**
     * Liefert die Session, wenn sie weder absolut noch durch Inaktivität abgelaufen ist.
     * @param {string | undefined} token
     * @returns {SessionRow | null}
     */
    lookup(token) {
      if (!token || typeof token !== 'string' || token.length > 100) return null;
      const hash = sha256(token);
      const row = /** @type {SessionRow | undefined} */ (/** @type {unknown} */ (byHash.get(hash)));
      if (!row) return null;
      const t = Date.now();
      if (Date.parse(row.expires_at) <= t || Date.parse(row.last_seen_at) + config.sessionIdleMs <= t) {
        del.run(hash);
        return null;
      }
      if (t - Date.parse(row.last_seen_at) > TOUCH_INTERVAL_MS) touch.run(new Date(t).toISOString(), hash);
      return row;
    },

    /** @param {string} tokenHash */
    destroy(tokenHash) { del.run(tokenHash); },

    /** Alle Sessions eines Benutzers beenden, optional außer der aktuellen. */
    destroyAllForUser(userId, exceptTokenHash = '') { delUser.run(userId, exceptTokenHash); },

    /** @param {string} tokenHash @param {number|null} orgId */
    setActiveOrg(tokenHash, orgId) { setOrg.run(orgId, tokenHash); },

    purgeExpired() {
      const t = Date.now();
      purge.run(new Date(t).toISOString(), new Date(t - config.sessionIdleMs).toISOString());
    },
  };
}

/** @param {import('../../config').Config} config */
function cookieOptions(config) {
  return {
    httpOnly: true,
    sameSite: /** @type {const} */ ('strict'),
    secure: config.isProduction,
    path: '/',
    maxAge: config.sessionMaxMs,
  };
}

/** Konstantzeit-Vergleich für Token. */
function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

module.exports = { createSessionStore, cookieOptions, safeEqual, COOKIE_NAME, sha256 };
