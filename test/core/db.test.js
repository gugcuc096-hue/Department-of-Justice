'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase, transaction } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { seed } = require('../../src/db/seeds');
const { createAudit } = require('../../src/core/audit/audit');
const { setupDb, testConfig } = require('../helpers');
const { createLogger } = require('../../src/http/logger');

test('migrations run once and are recorded with checksum', () => {
  const db = openDatabase(':memory:');
  const first = migrate(db);
  assert.ok(first.includes('001'));
  assert.deepEqual(migrate(db), [], 'second run applies nothing');
  const row = db.prepare("SELECT checksum FROM schema_migrations WHERE version = '001'").get();
  assert.match(String(row.checksum), /^[0-9a-f]{64}$/);
});

test('transaction rolls back on error, nested savepoints roll back only the inner part', () => {
  const db = openDatabase(':memory:');
  db.exec('CREATE TABLE t (x INTEGER)');
  assert.throws(() => transaction(db, () => { db.exec('INSERT INTO t VALUES (1)'); throw new Error('boom'); }));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM t').get().n, 0);

  transaction(db, () => {
    db.exec('INSERT INTO t VALUES (1)');
    try {
      transaction(db, () => { db.exec('INSERT INTO t VALUES (2)'); throw new Error('inner'); });
    } catch { /* erwartet */ }
  });
  assert.deepEqual(db.prepare('SELECT x FROM t').all().map((r) => r.x), [1]);
});

test('seed is idempotent and does not overwrite admin changes', () => {
  const { db, config } = setupDb();
  const counts = () => ['organizations', 'ranks', 'permissions', 'roles', 'role_permissions', 'security_levels',
    'compartments', 'security_profiles', 'feature_flags', 'users']
    .map((t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n);
  const before = counts();

  // Admin ändert eine Rolle – ein erneuter Seed darf das nicht zurückdrehen
  db.prepare("DELETE FROM role_permissions WHERE role_id = (SELECT id FROM roles WHERE code='JUDGE') AND permission_code='CASE_SEAL'").run();
  db.prepare("UPDATE feature_flags SET enabled = 0 WHERE code = 'WARRANTS'").run();
  seed(db, { config, logger: createLogger('silent') });

  const after = counts();
  after[4] += 1; // die bewusst entfernte role_permission
  assert.deepEqual(after, before);
  assert.equal(db.prepare("SELECT enabled FROM feature_flags WHERE code='WARRANTS'").get().enabled, 0);
});

test('rank order follows the specification (Senior State Attorney above State Attorney)', () => {
  const { db } = setupDb();
  const ranks = (org) => db.prepare(`SELECT r.name FROM ranks r JOIN organizations o ON o.id = r.org_id
    WHERE o.code = ? ORDER BY r.level DESC`).all(org).map((r) => r.name);
  assert.deepEqual(ranks('SA'), ['Senior State Attorney', 'State Attorney']);
  assert.deepEqual(ranks('DA')[0], 'District Attorney');
  assert.deepEqual(ranks('DA').at(-1), 'Probationary Prosecutor');
  assert.deepEqual(ranks('DC'), ['Principal Judge', 'Senior Judge', 'Judge', 'Probationary Judge']);
  assert.deepEqual(ranks('SC'), ['Chief Justice', 'Deputy Chief Justice', 'Associate Justice']);
  // Nicht vorgegebene Ränge werden nicht erfunden
  for (const org of ['USMS', 'SID', 'DCLI', 'REG', 'USSJA', 'CC']) assert.deepEqual(ranks(org), [], org);
});

test('court names use the agreed designation', () => {
  const { db } = setupDb();
  const dc = db.prepare("SELECT name, subtitle FROM organizations WHERE code = 'DC'").get();
  assert.equal(dc.name, 'District Court of the United States of America');
  assert.equal(dc.subtitle, 'for the District of San Andreas');
});

test('constitutional review and SID coercive measures are disabled by default', () => {
  const { db } = setupDb();
  const flags = Object.fromEntries(db.prepare('SELECT code, enabled FROM feature_flags').all().map((r) => [r.code, r.enabled]));
  assert.equal(flags.CONSTITUTIONAL_REVIEW, 0);
  assert.equal(flags.SID_COERCIVE_MEASURES, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM feature_flags WHERE legal_status <> 'NOT_VERIFIED'").get().n, 0);
});

test('bootstrap admin is created once, must change password, holds SYSTEM_ADMIN globally but no compartments', () => {
  const { db } = setupDb();
  const u = db.prepare("SELECT * FROM users WHERE username = 'admin'").get();
  assert.equal(u.must_change_password, 1);
  assert.notEqual(u.password_hash, 'Bootstrap-Password-1');
  const role = db.prepare(`SELECT r.code, ur.scope_org_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`).get(u.id);
  assert.equal(role.code, 'SYSTEM_ADMIN');
  assert.equal(role.scope_org_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM user_compartments WHERE user_id = ?').get(u.id).n, 0);
});

test('bootstrap rejects a weak admin password', () => {
  const config = testConfig({ BOOTSTRAP_ADMIN_PASSWORD: 'short' });
  const db = openDatabase(':memory:');
  migrate(db);
  assert.throws(() => seed(db, { config, logger: createLogger('silent') }), /BOOTSTRAP_ADMIN_PASSWORD/);
});

test('audit log is append-only and hash-chained', () => {
  const { db } = setupDb();
  const audit = createAudit(db);
  audit.write({ action: 'TEST_A', details: { n: 1 } });
  audit.write({ action: 'TEST_B', resourceType: 'case', resourceId: 7, resourceCompartments: ['USSJA'] });
  assert.deepEqual(audit.verify().ok, true);

  assert.throws(() => db.prepare("UPDATE audit_log SET action = 'X'").run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM audit_log').run(), /append-only/);

  // Manipulation direkt in der Datei (Trigger entfernt) wird von verify() erkannt
  db.exec('DROP TRIGGER audit_log_no_update');
  db.prepare("UPDATE audit_log SET details = '{\"n\":2}' WHERE action = 'TEST_A'").run();
  const result = audit.verify();
  assert.equal(result.ok, false);
  assert.ok(result.brokenAtId);
});
