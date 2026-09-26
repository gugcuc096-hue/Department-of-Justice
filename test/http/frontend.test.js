'use strict';
/**
 * Statische Prüfungen des Frontends (ohne Browser):
 *  - alle ES-Modul-Importe zeigen auf existierende, ausgelieferte Dateien
 *  - kein Inline-Script/-Style (würde von der CSP blockiert und wäre eine XSS-Angriffsfläche)
 *  - jede Route der Navigation hat eine Seite (keine toten Links)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startApp } = require('../helpers');
const { adminClient } = require('../fixtures');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

let t;
test.before(async () => { t = await startApp(); });
test.after(() => t.close());

test('every ES module import resolves to a served file', async () => {
  const files = walk(path.join(PUBLIC, 'app')).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 10);
  const c = t.client();
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), m[1]);
      assert.ok(fs.existsSync(target), `${path.relative(PUBLIC, file)} imports missing ${m[1]}`);
      const url = '/' + path.relative(PUBLIC, target).split(path.sep).join('/');
      const res = await c.get(url);
      assert.equal(res.status, 200, url);
      assert.match(res.headers.get('content-type'), /javascript/, url);
    }
  }
});

test('no inline scripts, inline styles or event-handler attributes (CSP)', () => {
  const files = walk(PUBLIC).filter((f) => /\.(html|js)$/.test(f));
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(PUBLIC, file);
    assert.doesNotMatch(src, /<script>(?!\s*<\/script>)/, `${rel}: inline <script>`);
    assert.doesNotMatch(src, /\sstyle="/, `${rel}: inline style attribute`);
    assert.doesNotMatch(src, /<style[\s>]/, `${rel}: <style> block`);
    assert.doesNotMatch(src, /\son(click|load|error|submit|change|input)=/i, `${rel}: inline event handler`);
  }
});

test('every navigation entry has a matching page route', async () => {
  const admin = await adminClient(t);
  const nav = (await admin.get('/api/me/navigation')).body;
  const routes = fs.readFileSync(path.join(PUBLIC, 'app', 'js', 'routes.js'), 'utf8');
  const paths = [...routes.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]);
  const toRe = (p) => new RegExp('^' + p.replace(/:\w+/g, '[^/]+') + '/?$');
  for (const item of nav.sections.flatMap((s) => s.items)) {
    const clean = item.path.replace(/\/$/, '') || '/app';
    assert.ok(paths.some((p) => toRe(p).test(clean)), `navigation ${item.path} has no page`);
  }
});
