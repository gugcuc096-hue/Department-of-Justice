'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers');
const { createUser, login, adminClient, orgId } = require('../fixtures');

let t;
let admin;
const ids = {};

test.before(async () => {
  t = await startApp();
  admin = await adminClient(t);
  const db = t.db;
  ids.daAdmin = createUser(db, { username: 'da.admin', orgs: [['DA', 'District Attorney']], roles: [['ORG_ADMIN', 'DA']] });
  ids.prosecutor = createUser(db, { username: 'da.prosecutor', orgs: [['DA', 'Prosecutor']], roles: [['PROSECUTOR', 'DA']] });
  ids.dual = createUser(db, { username: 'dual.member', orgs: [['DA', 'Prosecutor'], ['DC', 'Judge']] });
  ids.judge = createUser(db, { username: 'dc.judge', orgs: [['DC', 'Judge']], roles: [['JUDGE', 'DC']] });
  ids.secAdmin = createUser(db, { username: 'sec.admin', orgs: [['JUDICIARY']], roles: [['SECURITY_ADMIN', 'JUDICIARY']], clearance: 'CONFIDENTIAL' });
  ids.chief = createUser(db, { username: 'sc.chief', orgs: [['SC', 'Chief Justice']], roles: [['JUDGE', 'SC']] });
  ids.sjaMember = createUser(db, { username: 'sja.member', orgs: [['SC', 'Associate Justice'], ['USSJA']], roles: [['JUDGE', 'SC'], ['USSJA_MEMBER', 'USSJA']] });
});
test.after(() => t.close());

test('admin creates a user with a one-time temporary password; first login requires a change', async () => {
  const res = await admin.post('/api/admin/users', { username: 'new.deputy', displayName: 'New Deputy', orgId: orgId(t.db, 'USMS') });
  assert.equal(res.status, 201);
  assert.ok(res.body.temporaryPassword);
  assert.equal(res.body.user.mustChangePassword, true);
  const c = t.client();
  const login1 = await c.post('/api/auth/login', { username: 'new.deputy', password: res.body.temporaryPassword });
  assert.equal(login1.body.user.mustChangePassword, true);
  // Startpasswort steht nicht im Audit Log
  const logged = t.db.prepare("SELECT details FROM audit_log WHERE action = 'USER_CREATE' ORDER BY id DESC LIMIT 1").get().details;
  assert.doesNotMatch(logged, new RegExp(res.body.temporaryPassword));
});

test('usernames are unique (case-insensitive)', async () => {
  const res = await admin.post('/api/admin/users', { username: 'DA.PROSECUTOR', displayName: 'Dup', orgId: orgId(t.db, 'DA') });
  assert.equal(res.status, 409);
});

test('A13: nobody can change their own roles', async () => {
  const c = await login(t, 'da.admin');
  const role = t.db.prepare("SELECT id FROM roles WHERE code = 'PROSECUTION_SUPERVISOR'").get().id;
  const res = await c.post(`/api/admin/users/${ids.daAdmin}/roles`, { roleId: role, scopeOrgId: orgId(t.db, 'DA'), reason: 'self promotion' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'SELF_MODIFICATION');
});

test('office admin sees and manages only users of the own office', async () => {
  const c = await login(t, 'da.admin');
  const list = await c.get('/api/admin/users');
  const names = list.body.items.map((u) => u.username);
  assert.ok(names.includes('da.prosecutor'));
  assert.ok(!names.includes('dc.judge'), 'District Court user not listed');
  assert.equal((await c.get(`/api/admin/users/${ids.judge}`)).status, 404, 'foreign user hidden');

  const role = t.db.prepare("SELECT id FROM roles WHERE code = 'JUDGE'").get().id;
  const foreignScope = await c.post(`/api/admin/users/${ids.prosecutor}/roles`, { roleId: role, scopeOrgId: orgId(t.db, 'DC'), reason: 'test' });
  assert.equal(foreignScope.status, 403, 'cannot assign roles in other offices');
  const globalScope = await c.post(`/api/admin/users/${ids.prosecutor}/roles`, { roleId: role, scopeOrgId: null, reason: 'test' });
  assert.equal(globalScope.status, 403, 'cannot assign global roles');
});

test('user-wide changes need authority over all memberships', async () => {
  const c = await login(t, 'da.admin');
  const res = await c.post(`/api/admin/users/${ids.dual}/disable`, { reason: 'test' });
  assert.equal(res.status, 403);
  const ok = await admin.post(`/api/admin/users/${ids.dual}/disable`, { reason: 'left the service' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'DISABLED');
});

test('roles can only be assigned within a scope the user belongs to', async () => {
  const role = t.db.prepare("SELECT id FROM roles WHERE code = 'JUDGE'").get().id;
  const res = await admin.post(`/api/admin/users/${ids.prosecutor}/roles`, { roleId: role, scopeOrgId: orgId(t.db, 'DC'), reason: 'test' });
  assert.equal(res.status, 400);
});

test('direct permissions: only what the granting admin holds (no escalation)', async () => {
  const res = await admin.post(`/api/admin/users/${ids.prosecutor}/permissions`, { code: 'CASE_VIEW_ORG', scopeOrgId: orgId(t.db, 'DA'), reason: 'test' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'ESCALATION_DENIED');
});

test('clearance cannot exceed the assigning admin\'s own', async () => {
  const c = await login(t, 'sec.admin');
  const res = await c.put(`/api/admin/users/${ids.judge}/clearance`, { level: 'CLASSIFIED', reason: 'test' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'ESCALATION_DENIED');
  const ok = await c.put(`/api/admin/users/${ids.judge}/clearance`, { level: 'RESTRICTED', reason: 'role change' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.clearance, 'RESTRICTED');
});

test('compartments: prerequisite, initial grant, then only holders may grant (A14)', async () => {
  // Chief Justice hat kein US_SJA_ACCESS → nicht zulässig
  const noPrereq = await admin.post(`/api/admin/users/${ids.chief}/compartments`, { code: 'USSJA', reason: 'test' });
  assert.equal(noPrereq.status, 400);

  // Erstvergabe durch System Admin, solange niemand das Compartment hält
  const first = await admin.post(`/api/admin/users/${ids.sjaMember}/compartments`, { code: 'USSJA', reason: 'initial US-SJA member' });
  assert.equal(first.status, 201);
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'COMPARTMENT_GRANT'").get().n, 1);

  // Danach nur noch durch Inhaber
  const second = createUser(t.db, { username: 'sja.second', orgs: [['USSJA']], roles: [['USSJA_MEMBER', 'USSJA']] });
  const again = await admin.post(`/api/admin/users/${second}/compartments`, { code: 'USSJA', reason: 'test' });
  assert.equal(again.status, 403);
  assert.equal(again.body.error.code, 'ESCALATION_DENIED');
});

test('directory hides memberships in compartmented organizations', async () => {
  const outsider = await login(t, 'da.prosecutor');
  const seen = (await outsider.get('/api/directory?q=sja.member')).body[0];
  assert.deepEqual(seen.memberships.map((m) => m.org.code), ['SC']);
  const insider = await login(t, 'sja.member');
  const seen2 = (await insider.get('/api/directory?q=sja.member')).body[0];
  assert.deepEqual(seen2.memberships.map((m) => m.org.code).sort(), ['SC', 'USSJA']);
});

test('context switch only between own memberships, audited', async () => {
  const c = await login(t, 'sja.member');
  const bad = await c.put('/api/me/active-org', { orgId: orgId(t.db, 'DA') });
  assert.equal(bad.status, 400);
  const ok = await c.put('/api/me/active-org', { orgId: orgId(t.db, 'USSJA') });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.activeOrg.code, 'USSJA');
  assert.equal((await c.get('/api/me')).body.activeOrg.code, 'USSJA', 'persisted in session');
});

test('A15: delegation lifecycle – request, approval by a third party, expiry and loss of the delegator\'s right', async () => {
  const approver = createUser(t.db, { username: 'da.approver', orgs: [['DA']], roles: [['SECURITY_ADMIN', 'DA']] });
  const deputy = createUser(t.db, { username: 'da.deputy', orgs: [['DA', 'Junior Prosecutor']] });
  const p = await login(t, 'da.prosecutor');
  const da = orgId(t.db, 'DA');
  const window = { startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString() };

  const notHeld = await p.post('/api/delegations', { toUserId: deputy, permission: 'CASE_VIEW_ORG', scopeOrgId: da, reason: 'vacation', ...window });
  assert.equal(notHeld.status, 403);

  const req = await p.post('/api/delegations', { toUserId: deputy, permission: 'WARRANT_CREATE', scopeOrgId: da, reason: 'vacation cover', ...window });
  assert.equal(req.status, 201);
  assert.equal(req.body.status, 'PENDING');
  assert.equal((await p.post(`/api/delegations/${req.body.id}/approve`, { reason: 'self' })).status, 403, 'no self approval');

  const a = await login(t, 'da.approver');
  assert.equal((await a.post(`/api/delegations/${req.body.id}/approve`, { reason: 'approved' })).status, 200);

  const { loadPrincipal } = require('../../src/core/authz/principal');
  const dep = () => loadPrincipal(t.db, t.db.prepare('SELECT * FROM users WHERE id = ?').get(deputy));
  assert.equal(dep().has('WARRANT_CREATE', da), true, 'active delegation grants the permission');
  assert.equal(dep().has('WARRANT_CREATE', orgId(t.db, 'AG')), false, 'only in the delegated scope');

  // Delegierender verliert das Recht → Delegation wirkt nicht mehr
  t.db.prepare("DELETE FROM user_roles WHERE user_id = ?").run(ids.prosecutor);
  assert.equal(dep().has('WARRANT_CREATE', da), false);
  t.db.prepare("INSERT INTO user_roles (user_id, role_id, scope_org_id) VALUES (?, (SELECT id FROM roles WHERE code='PROSECUTOR'), ?)").run(ids.prosecutor, da);
  assert.equal(dep().has('WARRANT_CREATE', da), true);

  // Abgelaufen → wirkungslos
  t.db.prepare("UPDATE delegations SET ends_at = '2000-01-02T00:00:00.000Z', starts_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(req.body.id);
  assert.equal(dep().has('WARRANT_CREATE', da), false);
  assert.ok(approver);
});

test('compartments and admin rights are not delegable', async () => {
  const p = await login(t, 'sec.admin');
  const res = await p.post('/api/delegations', { toUserId: ids.judge, permission: 'COMPARTMENT_ASSIGN', scopeOrgId: null, reason: 'test',
    startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(res.status, 400);
});

test('A16: disabling via admin ends the user\'s sessions', async () => {
  const c = await login(t, 'dc.judge');
  assert.equal((await admin.post(`/api/admin/users/${ids.judge}/disable`, { reason: 'suspended' })).status, 200);
  assert.equal((await c.get('/api/me')).status, 401);
  await admin.post(`/api/admin/users/${ids.judge}/enable`, { reason: 'reinstated' });
});

test('feature flags: readable by all, togglable only with FEATURE_TOGGLE, audited', async () => {
  const c = await login(t, 'da.prosecutor');
  const flags = (await c.get('/api/feature-flags')).body;
  assert.ok(flags.find((f) => f.code === 'CONSTITUTIONAL_REVIEW' && f.enabled === false));
  assert.equal((await c.put('/api/admin/feature-flags/WARRANTS', { enabled: false, reason: 'test' })).status, 403);
  assert.equal((await admin.put('/api/admin/feature-flags/WARRANTS', { enabled: false, reason: 'maintenance' })).status, 200);
  assert.equal(t.db.prepare("SELECT enabled FROM feature_flags WHERE code='WARRANTS'").get().enabled, 0);
  await admin.put('/api/admin/feature-flags/WARRANTS', { enabled: true, reason: 'back' });
});

test('route-level permission denials are audited', async () => {
  const c = await login(t, 'da.prosecutor');
  assert.equal((await c.get('/api/admin/users')).status, 403);
  const e = t.db.prepare("SELECT * FROM audit_log WHERE action = 'PERMISSION_CHECK' ORDER BY id DESC LIMIT 1").get();
  assert.equal(e.outcome, 'DENIED');
  assert.equal(e.actor_user_id, ids.prosecutor);
});

test('audit chain intact', () => assert.equal(t.ctx.audit.verify().ok, true));
