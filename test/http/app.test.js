'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers');

let t;
test.before(async () => { t = await startApp(); });
test.after(() => t.close());

test('health endpoint responds without auth and is not cached', async () => {
  const res = await t.client().get('/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok' });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.ok(res.headers.get('x-request-id'));
});

test('security headers are set', async () => {
  const res = await t.client().get('/api/health');
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('unknown API endpoints do not reveal anything before sign-in (JSON 401 with requestId)', async () => {
  const res = await t.client().get('/api/does-not-exist');
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'UNAUTHORIZED');
  assert.ok(res.body.requestId);
});

test('malformed JSON returns 400 without internals', async () => {
  const res = await t.client().post('/api/health', '{not json', { 'content-type': 'application/json' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'BAD_REQUEST');
  assert.doesNotMatch(res.text, /SyntaxError|at JSON/);
});

test('root redirects to the app and SPA routes fall back to the shell', async () => {
  const c = t.client();
  const root = await c.get('/');
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/app/');
  const deep = await c.get('/app/cases/123');
  assert.equal(deep.status, 200);
  assert.match(deep.text, /<div id="root"/);
});

test('branding package is served and self-hosts its fonts', async () => {
  const c = t.client();
  assert.equal((await c.get('/branding/brand.config.js')).status, 200);
  assert.equal((await c.get('/branding/fonts/public-sans-latin-400-normal.woff2')).status, 200);
  const css = await c.get('/branding/branding.css');
  assert.doesNotMatch(css.text, /googleapis/);
});

test('files outside public are not reachable', async () => {
  const c = t.client();
  for (const p of ['/server.js', '/src/config.js', '/.env', '/data/sjcs.db', '/public/../server.js']) {
    const res = await c.get(p);
    assert.equal(res.status, 404, p);
  }
});
