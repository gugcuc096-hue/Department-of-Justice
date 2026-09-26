// @ts-check
'use strict';
/**
 * /api/auth – Login, Logout, Session, Passwortwechsel.
 */
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const { asyncHandler } = require('../../http/async');
const { HttpError, unauthorized, badRequest } = require('../../http/errors');
const { requestContext } = require('../audit/audit');
const { transaction, now } = require('../../db');
const { verifyPassword, hashPassword, validatePassword } = require('./passwords');
const { COOKIE_NAME, cookieOptions } = require('./sessions');

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
// Einheitliche Meldung: verrät weder, ob der Benutzer existiert, noch ob er gesperrt ist.
const LOGIN_FAILED = 'Sign-in failed. Check your username and password or try again later.';

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
});
const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

/** @param {any} user */
const summary = (user) => ({
  id: user.id,
  username: user.username,
  displayName: user.display_name,
  mustChangePassword: Boolean(user.must_change_password),
});

/**
 * @param {import('../../app').AppContext & { sessions: ReturnType<typeof import('./sessions').createSessionStore> }} ctx
 */
function authRoutes(ctx) {
  const { db, audit, sessions, config } = ctx;
  const router = express.Router();

  const byUsername = db.prepare('SELECT * FROM users WHERE username = ?');
  const primaryOrg = db.prepare('SELECT org_id FROM memberships WHERE user_id = ? ORDER BY is_primary DESC, id LIMIT 1');
  const recordFailure = db.prepare(`UPDATE users SET
      failed_logins = CASE WHEN failed_logins + 1 >= ? THEN 0 ELSE failed_logins + 1 END,
      locked_until  = CASE WHEN failed_logins + 1 >= ? THEN ? ELSE locked_until END,
      updated_at = ?
    WHERE id = ?`);
  const recordSuccess = db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?');

  const loginLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: config.loginRateLimit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new HttpError(429, 'TOO_MANY_REQUESTS', 'Too many sign-in attempts. Please wait and try again.')),
  });

  router.post('/login', loginLimiter, asyncHandler(async (req, res) => {
    const { username, password } = loginSchema.parse(req.body);
    const user = /** @type {any} */ (byUsername.get(username));
    const passwordOk = await verifyPassword(password, user?.password_hash);
    const locked = user?.locked_until && Date.parse(user.locked_until) > Date.now();
    const base = { ...requestContext(req), actorUserId: null };

    if (!user || !passwordOk || locked || user.status !== 'ACTIVE') {
      transaction(db, () => {
        if (user && !locked) {
          const until = new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString();
          recordFailure.run(MAX_FAILED, MAX_FAILED, until, now(), user.id);
        }
        audit.write({
          ...base, action: 'AUTH_LOGIN_FAILED', outcome: 'DENIED',
          // Benutzer nur referenzieren, wenn er existiert (SECURITY_MODEL.md, Abschnitt 10)
          resourceType: user ? 'user' : null, resourceId: user?.id ?? null,
          details: { reason: !user ? 'unknown_user' : locked ? 'locked' : user.status !== 'ACTIVE' ? 'inactive' : 'bad_password' },
        });
      });
      throw new HttpError(401, 'LOGIN_FAILED', LOGIN_FAILED);
    }

    // Session-Fixation verhindern: vorhandene Session immer verwerfen, neue ausstellen
    const previous = /** @type {any} */ (req).auth?.session;
    const created = transaction(db, () => {
      if (previous) sessions.destroy(previous.token_hash);
      recordSuccess.run(now(), user.id);
      const s = sessions.create({
        userId: user.id,
        activeOrgId: /** @type {any} */ (primaryOrg.get(user.id))?.org_id ?? null,
        ip: req.ip ?? '',
        userAgent: req.get('user-agent') ?? '',
      });
      audit.write({ ...base, actorUserId: user.id, sessionHash: s.tokenHash.slice(0, 16), action: 'AUTH_LOGIN', resourceType: 'user', resourceId: user.id });
      return s;
    });

    res.cookie(COOKIE_NAME, created.token, cookieOptions(config));
    res.json({ user: summary(user), csrfToken: created.csrfToken });
  }));

  router.post('/logout', (req, res) => {
    const auth = /** @type {any} */ (req).auth;
    if (auth) {
      transaction(db, () => {
        sessions.destroy(auth.session.token_hash);
        audit.write({ ...requestContext(req), action: 'AUTH_LOGOUT', resourceType: 'user', resourceId: auth.user.id });
      });
    }
    res.clearCookie(COOKIE_NAME, { ...cookieOptions(config), maxAge: undefined });
    res.json({ ok: true });
  });

  router.get('/session', (req, res, next) => {
    const auth = /** @type {any} */ (req).auth;
    if (!auth) return next(unauthorized());
    res.json({ user: summary(auth.user), csrfToken: auth.session.csrf_token });
  });

  router.post('/password', asyncHandler(async (req, res) => {
    const auth = /** @type {any} */ (req).auth;
    if (!auth) throw unauthorized();
    const { currentPassword, newPassword } = passwordSchema.parse(req.body);
    if (!(await verifyPassword(currentPassword, auth.user.password_hash))) {
      audit.write({ ...requestContext(req), action: 'AUTH_PASSWORD_CHANGE', outcome: 'DENIED', resourceType: 'user', resourceId: auth.user.id });
      throw badRequest('The current password is incorrect.', [{ field: 'currentPassword', message: 'Incorrect password.' }]);
    }
    const problem = validatePassword(newPassword);
    if (problem) throw badRequest(problem, [{ field: 'newPassword', message: problem }]);
    if (newPassword === currentPassword) {
      throw badRequest('The new password must differ from the current one.', [{ field: 'newPassword', message: 'Must differ from the current password.' }]);
    }
    const hash = await hashPassword(newPassword, config.bcryptCost);
    transaction(db, () => {
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?').run(hash, now(), auth.user.id);
      sessions.destroyAllForUser(auth.user.id, auth.session.token_hash);
      audit.write({ ...requestContext(req), action: 'AUTH_PASSWORD_CHANGE', resourceType: 'user', resourceId: auth.user.id });
    });
    res.json({ ok: true });
  }));

  return router;
}

module.exports = { authRoutes };
