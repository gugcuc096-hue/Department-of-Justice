'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, ADMIN } = require('../helpers');

let t;
test.before(async () => { t = await startApp(); });
test.after(() => t.close());

const NEW_PASSWORD = 'Changed-Password-42';
const lastAudit = (action) => t.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1').get(action);

test('protected API requires a session', async () => {
  const res = await t.client().get('/api/anything');
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'UNAUTHORIZED');
});

test('wrong password and unknown user get the same generic answer and are audited', async () => {
  const c = t.client();
  const bad = await c.post('/api/auth/login', { username: ADMIN.username, password: 'wrong-password-1' });
  const unknown = await c.post('/api/auth/login', { username: 'nobody', password: 'wrong-password-1' });
  assert.equal(bad.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(bad.body.error.message, unknown.body.error.message);

  const entry = lastAudit('AUTH_LOGIN_FAILED');
  assert.equal(entry.outcome, 'DENIED');
  assert.equal(entry.resource_id, null, 'unknown user is not referenced');
  assert.doesNotMatch(entry.details, /wrong-password/);
  t.db.prepare('UPDATE users SET failed_logins = 0 WHERE username = ?').run(ADMIN.username);
});

test('login sets a hardened session cookie and returns a CSRF token', async () => {
  const c = t.client();
  const res = await c.post('/api/auth/login', ADMIN);
  assert.equal(res.status, 200);
  assert.equal(res.body.user.mustChangePassword, true);
  assert.ok(res.body.csrfToken);
  const cookie = res.headers.getSetCookie().find((x) => x.startsWith('sjcs_sid='));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  // Token wird nur gehasht gespeichert
  const token = cookie.split(';')[0].split('=')[1];
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM sessions WHERE token_hash = ?').get(token).n, 0);
  assert.equal(lastAudit('AUTH_LOGIN').outcome, 'SUCCESS');
});

test('a pending password change blocks everything except auth endpoints', async () => {
  const c = t.client();
  await c.post('/api/auth/login', ADMIN);
  assert.equal((await c.get('/api/auth/session')).status, 200);
  const blocked = await c.get('/api/anything');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'PASSWORD_CHANGE_REQUIRED');
});

test('state-changing requests need the CSRF header and JSON', async () => {
  const c = t.client();
  await c.post('/api/auth/login', ADMIN);
  const noToken = await c.post('/api/auth/password', { currentPassword: ADMIN.password, newPassword: NEW_PASSWORD }, { 'x-csrf-token': '' });
  assert.equal(noToken.status, 403);
  assert.equal(noToken.body.error.code, 'CSRF_FAILED');
  const form = await c.post('/api/auth/logout', 'a=b', { 'content-type': 'application/x-www-form-urlencoded' });
  assert.equal(form.status, 415);
});

test('password change validates, clears the flag and ends other sessions', async () => {
  const a = t.client();
  const b = t.client();
  await a.post('/api/auth/login', ADMIN);
  await b.post('/api/auth/login', ADMIN);

  const weak = await a.post('/api/auth/password', { currentPassword: ADMIN.password, newPassword: 'short' });
  assert.equal(weak.status, 400);
  const wrong = await a.post('/api/auth/password', { currentPassword: 'not-it-12345', newPassword: NEW_PASSWORD });
  assert.equal(wrong.status, 400);

  const ok = await a.post('/api/auth/password', { currentPassword: ADMIN.password, newPassword: NEW_PASSWORD });
  assert.equal(ok.status, 200);
  assert.equal((await a.get('/api/anything')).status, 404, 'no longer blocked, reaches the API 404');
  assert.equal((await b.get('/api/auth/session')).status, 401, 'other session ended');
  ADMIN.password = NEW_PASSWORD;
});

test('login rotates the session (no fixation) and logout ends it', async () => {
  const c = t.client();
  await c.post('/api/auth/login', ADMIN);
  const first = c.jar.get('sjcs_sid');
  await c.post('/api/auth/login', ADMIN);
  const second = c.jar.get('sjcs_sid');
  assert.notEqual(first, second);

  const stale = t.client();
  stale.jar.set('sjcs_sid', first);
  assert.equal((await stale.get('/api/auth/session')).status, 401, 'old session was destroyed');

  assert.equal((await c.post('/api/auth/logout')).status, 200);
  assert.equal((await c.get('/api/auth/session')).status, 401);
});

test('five failed attempts lock the account; the lock expires', async () => {
  const c = t.client();
  for (let i = 0; i < 5; i++) await c.post('/api/auth/login', { username: ADMIN.username, password: 'wrong-password-1' });
  assert.equal((await c.post('/api/auth/login', ADMIN)).status, 401, 'locked even with correct password');
  t.db.prepare("UPDATE users SET locked_until = '2000-01-01T00:00:00.000Z' WHERE username = ?").run(ADMIN.username);
  assert.equal((await c.post('/api/auth/login', ADMIN)).status, 200);
});

test('idle sessions expire', async () => {
  const c = t.client();
  await c.post('/api/auth/login', ADMIN);
  t.db.prepare("UPDATE sessions SET last_seen_at = '2000-01-01T00:00:00.000Z'").run();
  assert.equal((await c.get('/api/auth/session')).status, 401);
});

test('disabling a user ends active sessions immediately', async () => {
  const c = t.client();
  await c.post('/api/auth/login', ADMIN);
  t.db.prepare("UPDATE users SET status = 'DISABLED' WHERE username = ?").run(ADMIN.username);
  assert.equal((await c.get('/api/auth/session')).status, 401);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
  t.db.prepare("UPDATE users SET status = 'ACTIVE' WHERE username = ?").run(ADMIN.username);
});

test('audit chain is intact after auth activity', () => {
  assert.equal(t.ctx.audit.verify().ok, true);
});
