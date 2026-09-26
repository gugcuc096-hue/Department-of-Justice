// @ts-check
'use strict';
/**
 * Auth-Middleware: Session laden, Anmeldung erzwingen, CSRF prüfen, Passwortwechsel erzwingen.
 */
const { unauthorized, forbidden, HttpError } = require('../../http/errors');
const { COOKIE_NAME, safeEqual } = require('./sessions');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Lädt Session und Benutzer. Deaktivierte Benutzer verlieren sofort alle Sessions.
 * @param {import('../../app').AppContext & { sessions: ReturnType<typeof import('./sessions').createSessionStore> }} ctx
 * @returns {import('express').RequestHandler}
 */
function loadSession(ctx) {
  const userById = ctx.db.prepare('SELECT * FROM users WHERE id = ?');
  return (req, res, next) => {
    const session = ctx.sessions.lookup(req.cookies?.[COOKIE_NAME]);
    if (!session) return next();
    const user = /** @type {any} */ (userById.get(session.user_id));
    if (!user || user.status !== 'ACTIVE') {
      ctx.sessions.destroyAllForUser(session.user_id);
      ctx.sessions.destroy(session.token_hash);
      return next();
    }
    /** @type {any} */ (req).auth = { user, session };
    next();
  };
}

/** @type {import('express').RequestHandler} */
function requireAuth(req, _res, next) {
  if (!(/** @type {any} */ (req).auth)) return next(unauthorized());
  next();
}

/**
 * Zustandsändernde API-Requests:
 * 1. müssen JSON (oder multipart für Uploads) sein – einfache Cross-Site-Formulare scheitern damit am Preflight;
 * 2. brauchen bei bestehender Session den Header X-CSRF-Token (zusätzlich zu SameSite=Strict).
 * @type {import('express').RequestHandler}
 */
function csrfProtection(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const hasBody = Number(req.get('content-length') ?? 0) > 0 || req.get('transfer-encoding');
  // Ausnahme: Datei-Upload als Rohdaten (nur erlaubte Dateitypen; CSRF-Header gilt trotzdem)
  const isUpload = req.method === 'POST' && req.path === '/files' && req.is(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
  if (hasBody && !isUpload && !req.is('application/json') && !req.is('multipart/form-data')) {
    return next(new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Requests must be sent as JSON.'));
  }
  const auth = /** @type {any} */ (req).auth;
  if (auth && !safeEqual(req.get('x-csrf-token'), auth.session.csrf_token)) {
    return next(forbidden('Your session token is invalid. Please reload the page.', 'CSRF_FAILED'));
  }
  next();
}

/**
 * Solange ein Passwortwechsel aussteht, sind nur Session-, Passwort- und Logout-Endpunkte erreichbar.
 * @type {import('express').RequestHandler}
 */
function requirePasswordCurrent(req, _res, next) {
  const auth = /** @type {any} */ (req).auth;
  if (auth?.user?.must_change_password && !req.path.startsWith('/auth/')) {
    return next(forbidden('You must change your password before continuing.', 'PASSWORD_CHANGE_REQUIRED'));
  }
  next();
}

module.exports = { loadSession, requireAuth, csrfProtection, requirePasswordCurrent };
