'use strict';
/**
 * Test-Helfer: startet die App mit In-Memory-Datenbank auf zufälligem Port und
 * liefert einen HTTP-Client mit Cookie-Jar und CSRF-Header.
 */
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/http/logger');
const { openDatabase } = require('../src/db');
const { migrate } = require('../src/db/migrate');
const { seed } = require('../src/db/seeds');
const { createApp } = require('../src/app');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ADMIN = { username: 'admin', password: 'Bootstrap-Password-1' };

/** @param {Record<string,string>} [env] */
function testConfig(env = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    DB_PATH: ':memory:',
    BCRYPT_COST: '4',
    LOGIN_RATE_LIMIT: '1000',
    // Uploads der Tests in ein eigenes Temp-Verzeichnis, nie in data/
    UPLOAD_DIR: path.join(os.tmpdir(), `sjcs-test-${crypto.randomBytes(6).toString('hex')}`),
    BOOTSTRAP_ADMIN_USER: ADMIN.username,
    BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
    ...env,
  });
}

/** Datenbank mit Schema und Seed, ohne HTTP. */
function setupDb(env) {
  const config = testConfig(env);
  const logger = createLogger(config.logLevel);
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db, { config, logger });
  return { db, config, logger };
}

/** App starten. */
async function startApp(env) {
  const { db, config, logger } = setupDb(env);
  const { app, ctx } = createApp({ db, config, logger });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    db, ctx, config, baseUrl,
    client: () => createClient(baseUrl),
    close: () => new Promise((resolve) => server.close(() => { db.close(); resolve(); })),
  };
}

/** Einfacher HTTP-Client, der Session-Cookie und CSRF-Token mitführt. */
function createClient(baseUrl) {
  const jar = new Map();
  let csrf = null;
  async function request(method, path, body, headers = {}) {
    const h = { ...headers };
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) h['content-type'] = h['content-type'] ?? 'application/json';
    if (csrf && !('x-csrf-token' in h)) h['x-csrf-token'] = csrf;
    const res = await fetch(baseUrl + path, {
      method, headers: h, redirect: 'manual',
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, ...v] = pair.split('=');
      const value = v.join('=');
      if (/expires=Thu, 01 Jan 1970/i.test(c) || value === '') jar.delete(k.trim());
      else jar.set(k.trim(), value);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* kein JSON */ }
    if (json && json.csrfToken) csrf = json.csrfToken;
    return { status: res.status, headers: res.headers, body: json, text };
  }
  return {
    get: (p, h) => request('GET', p, undefined, h),
    post: (p, b = {}, h) => request('POST', p, b, h),
    put: (p, b = {}, h) => request('PUT', p, b, h),
    patch: (p, b = {}, h) => request('PATCH', p, b, h),
    delete: (p, h) => request('DELETE', p, undefined, h),
    setCsrf: (t) => { csrf = t; },
    get csrf() { return csrf; },
    jar,
  };
}

module.exports = { ADMIN, testConfig, setupDb, startApp, createClient };
