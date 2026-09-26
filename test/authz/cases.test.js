'use strict';
/**
 * Autorisierungs-Testmatrix für Akten (PERMISSIONS.md Abschnitt 7).
 * Alle Prüfungen laufen über die HTTP-API – so, wie ein Angreifer sie auch aufrufen würde.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers');
const { createUser, login, adminClient, orgId } = require('../fixtures');
const { loadPrincipal } = require('../../src/core/authz/principal');
const { canViewCase } = require('../../src/core/cases/visibility');
const { createCaseService } = require('../../src/core/cases/service');

let t;
const U = {};   // Benutzer-IDs
const C = {};   // Clients
const K = {};   // Akten-IDs

const users = [
  ['daPro1', { orgs: [['DA', 'Prosecutor']], roles: [['PROSECUTOR', 'DA']] }],
  ['daPro2', { orgs: [['DA', 'Prosecutor']], roles: [['PROSECUTOR', 'DA']] }],
  ['daProb', { orgs: [['DA', 'Probationary Prosecutor']], roles: [['PROSECUTOR', 'DA']] }],
  ['daSup', { orgs: [['DA', 'Assistant District Attorney']], roles: [['PROSECUTION_SUPERVISOR', 'DA']] }],
  ['agPro', { orgs: [['AG', 'Assistant Attorney General']], roles: [['PROSECUTOR', 'AG']] }],
  ['prosChief', { orgs: [['PROSECUTION']], roles: [] }],
  ['dcJudge1', { orgs: [['DC', 'Judge']], roles: [['JUDGE', 'DC']] }],
  ['dcJudge2', { orgs: [['DC', 'Judge']], roles: [['JUDGE', 'DC']] }],
  ['dcAdmin', { orgs: [['DC']], roles: [['COURT_ADMINISTRATION', 'DC']] }],
  ['coaJustice', { orgs: [['COA', 'Appellate Justice']], roles: [['JUDGE', 'COA']] }],
  ['coaAdmin', { orgs: [['COA']], roles: [['COURT_ADMINISTRATION', 'COA']] }],
  ['scAdmin', { orgs: [['SC']], roles: [['COURT_ADMINISTRATION', 'SC']] }],
  ['dcliOfficer', { orgs: [['DCLI']], roles: [['DCLI_OFFICER', 'DCLI']] }],
  ['sidInv', { orgs: [['SID']], roles: [['SID_INVESTIGATOR', 'SID']], compartments: ['SID'] }],
  ['sidInv2', { orgs: [['SID']], roles: [['SID_INVESTIGATOR', 'SID']], compartments: ['SID', 'SID_RESTRICTED'] }],
  ['sidNoComp', { orgs: [['SID']], roles: [['SID_INVESTIGATOR', 'SID']] }],
  ['registrar', { orgs: [['REG']], roles: [['REGISTRAR', 'REG']], compartments: ['REGISTRY'] }],
  ['chief', { orgs: [['SC', 'Chief Justice']], roles: [['JUDGE', 'SC']], clearance: 'CLASSIFIED' }],
  ['sjaMember', { orgs: [['SC', 'Associate Justice'], ['USSJA']], roles: [['JUDGE', 'SC'], ['USSJA_MEMBER', 'USSJA']], compartments: ['USSJA'], clearance: 'CLASSIFIED' }],
  ['lowClearance', { orgs: [['DC', 'Probationary Judge']], roles: [['JUDGE', 'DC']], clearance: 'INTERNAL' }],
];

async function createCase(client, body) {
  const res = await client.post('/api/cases', body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}
const get = (who, caseId) => C[who].get(`/api/cases/${caseId}`);
const listIds = async (who) => (await C[who].get('/api/cases?limit=100')).body.items.map((x) => x.id);

test.before(async () => {
  t = await startApp();
  C.admin = await adminClient(t);
  for (const [name, o] of users) U[name] = createUser(t.db, { username: name, ...o });
  // Übergeordnete Aufsicht über die gesamte Staatsanwaltschaft (Direktgrant)
  t.db.prepare(`INSERT INTO user_permissions (user_id, permission_code, scope_org_id) VALUES
    (?, 'CASE_VIEW_ORG', ?), (?, 'CASE_VIEW', ?)`).run(U.prosChief, orgId(t.db, 'PROSECUTION'), U.prosChief, orgId(t.db, 'PROSECUTION'));
  for (const [name] of users) C[name] = await login(t, name);

  K.da = (await createCase(C.daPro1, { typeCode: 'CRIMINAL', orgId: orgId(t.db, 'DA'), title: 'State v. Doe (DEMO)' })).id;
  K.ag = (await createCase(C.agPro, { typeCode: 'CRIMINAL', orgId: orgId(t.db, 'AG'), title: 'AG matter (DEMO)' })).id;
  K.dc = (await createCase(C.dcAdmin, { typeCode: 'CRIMINAL', orgId: orgId(t.db, 'DC'), title: 'Court case (DEMO)' })).id;
  await C.dcAdmin.post(`/api/cases/${K.dc}/participants`, { userId: U.dcJudge1, role: 'JUDGE', isPresiding: true });
  K.dcSealed = (await createCase(C.dcAdmin, { typeCode: 'CRIMINAL', orgId: orgId(t.db, 'DC'), title: 'Sealed court case (DEMO)' })).id;
  await C.dcAdmin.post(`/api/cases/${K.dcSealed}/participants`, { userId: U.dcJudge1, role: 'JUDGE' });
  K.coa = (await createCase(C.coaAdmin, { typeCode: 'APPEAL', orgId: orgId(t.db, 'COA'), title: 'Appeal (DEMO)' })).id;
  K.sc = (await createCase(C.scAdmin, { typeCode: 'SUPREME_COURT', orgId: orgId(t.db, 'SC'), title: 'SC review (DEMO)' })).id;
  K.sid = (await createCase(C.sidInv, { typeCode: 'SID_INVESTIGATION', orgId: orgId(t.db, 'SID'), title: 'SID file (DEMO)' })).id;
  K.sidRestricted = (await createCase(C.sidInv2, { typeCode: 'SID_INVESTIGATION', orgId: orgId(t.db, 'SID'), title: 'Restricted SID file (DEMO)', securityProfile: 'SID_RESTRICTED' })).id;
  K.reg = (await createCase(C.registrar, { typeCode: 'REGISTRY', orgId: orgId(t.db, 'REG'), title: 'Registry matter (DEMO)' })).id;
  K.sja = (await createCase(C.sjaMember, { typeCode: 'US_SJA', orgId: orgId(t.db, 'USSJA'), title: 'Special matter (DEMO)' })).id;
  K.dcliCase = (await createCase(C.dcliOfficer, { typeCode: 'DCLI_INVESTIGATION', orgId: orgId(t.db, 'DCLI'), title: 'Inspection (DEMO)' })).id;
});
test.after(() => t.close());

// ------------------------------------------------------------------ Matrix

test('A1: probationary prosecutor cannot access a court case', async () => {
  assert.equal((await get('daProb', K.dc)).status, 404);
});

test('A2: assigned judge can access the court case', async () => {
  assert.equal((await get('dcJudge1', K.dc)).status, 200);
});

test('A3 / F9: office colleague sees the case but cannot edit it', async () => {
  assert.equal((await get('dcJudge2', K.dc)).status, 200);
  assert.equal((await C.dcJudge2.patch(`/api/cases/${K.dc}`, { title: 'changed' })).status, 403);
  assert.equal((await get('daPro2', K.da)).status, 200);
  assert.equal((await C.daPro2.patch(`/api/cases/${K.da}`, { title: 'changed' })).status, 403);
  assert.equal((await C.daPro1.patch(`/api/cases/${K.da}`, { summary: 'Lead edits' })).status, 200);
  assert.equal((await C.daSup.patch(`/api/cases/${K.da}`, { summary: 'Supervisor edits' })).status, 200);
});

test('A3b / A3c: no visibility across offices', async () => {
  assert.equal((await get('coaJustice', K.dc)).status, 404);
  assert.equal((await get('agPro', K.da)).status, 404);
  assert.equal((await get('daPro1', K.ag)).status, 404);
});

test('A4: DCLI officer cannot access unrelated prosecution case', async () => {
  assert.equal((await get('dcliOfficer', K.da)).status, 404);
});

test('A5: SID files require the SID compartment – detail, list and search', async () => {
  assert.equal((await get('sidInv', K.sid)).status, 200);
  for (const who of ['daPro1', 'sidNoComp', 'prosChief']) {
    assert.equal((await get(who, K.sid)).status, 404, who);
    assert.ok(!(await listIds(who)).includes(K.sid), who);
    const search = await C[who].get('/api/cases?q=SID');
    assert.ok(!search.body.items.some((x) => x.id === K.sid), who);
  }
});

test('explicit-access profile: compartment alone is not enough, participation is required', async () => {
  assert.equal((await get('sidInv', K.sidRestricted)).status, 404, 'no SID_RESTRICTED compartment');
  const other = createUser(t.db, { username: 'sidInv3', orgs: [['SID']], roles: [['SID_INVESTIGATOR', 'SID']], compartments: ['SID', 'SID_RESTRICTED'] });
  const c = await login(t, 'sidInv3');
  assert.equal((await c.get(`/api/cases/${K.sidRestricted}`)).status, 404, 'compartments but not a participant');
  assert.equal((await C.sidInv2.post(`/api/cases/${K.sidRestricted}/participants`, { userId: other, role: 'INVESTIGATOR' })).status, 201);
  assert.equal((await c.get(`/api/cases/${K.sidRestricted}`)).status, 200);
});

test('A6: court users cannot access registry records', async () => {
  assert.equal((await get('dcJudge1', K.reg)).status, 404);
  assert.equal((await get('registrar', K.reg)).status, 200);
});

test('A7 / A8: US-SJA visible to members with compartment only – not even to the Chief Justice', async () => {
  assert.equal((await get('sjaMember', K.sja)).status, 200);
  assert.equal((await get('chief', K.sja)).status, 404);
  assert.ok(!(await listIds('chief')).includes(K.sja));
  const counted = await C.chief.get('/api/cases?type=US_SJA');
  assert.equal(counted.body.total, 0, 'not even counted');

  // Verknüpfung von der US-SJA-Akte zur Supreme-Court-Akte bleibt für den Chief Justice unsichtbar
  assert.equal((await C.sjaMember.post(`/api/cases/${K.sja}/links`, { toCaseId: K.sc, linkType: 'RELATED' })).status, 201);
  const sc = await get('chief', K.sc);
  assert.deepEqual(sc.body.links, []);
  const timeline = await C.chief.get(`/api/cases/${K.sc}/timeline`);
  assert.ok(!JSON.stringify(timeline.body).includes('SJA-'), 'no trace in the target timeline');
  const insider = await get('sjaMember', K.sc);
  assert.equal(insider.body.links.length, 1);
});

test('A9: the system administrator sees no case content', async () => {
  for (const id of Object.values(K)) assert.equal((await C.admin.get(`/api/cases/${id}`)).status, 404);
  assert.equal((await C.admin.get('/api/cases')).body.total, 0);
});

test('A10: hidden actions are enforced by the API', async () => {
  assert.equal((await C.daPro2.post(`/api/cases/${K.da}/close`, { reason: 'not mine' })).status, 403);
  assert.equal((await C.dcJudge2.post(`/api/cases/${K.dc}/participants`, { userId: U.dcJudge2, role: 'JUDGE' })).status, 403);
  assert.equal((await C.daPro1.post(`/api/cases/${K.da}/seal`, { reason: 'try it' })).status, 403);
});

test('A12: sealing removes office and supervisor visibility; only named users keep access', async () => {
  // Übergeordnete Aufsicht über die Judiciary
  const supervisor = createUser(t.db, { username: 'judSup', orgs: [['JUDICIARY']] });
  t.db.prepare("INSERT INTO user_permissions (user_id, permission_code, scope_org_id) VALUES (?, 'CASE_VIEW_ORG', ?), (?, 'CASE_VIEW', ?)")
    .run(supervisor, orgId(t.db, 'JUDICIARY'), supervisor, orgId(t.db, 'JUDICIARY'));
  const sup = await login(t, 'judSup');
  assert.equal((await sup.get(`/api/cases/${K.dcSealed}`)).status, 200, 'supervisor sees it before sealing');

  const sealed = await C.dcJudge1.post(`/api/cases/${K.dcSealed}/seal`, { reason: 'Protection of a witness' });
  assert.equal(sealed.status, 200);
  assert.equal(sealed.body.isSealed, true);
  assert.equal((await get('dcJudge1', K.dcSealed)).status, 200, 'sealing judge keeps access');
  assert.equal((await get('dcJudge2', K.dcSealed)).status, 404, 'office access removed');
  assert.equal((await get('dcAdmin', K.dcSealed)).status, 404, 'even the creator loses access');
  assert.equal((await sup.get(`/api/cases/${K.dcSealed}`)).status, 404, 'supervisor access removed');
  assert.equal((await sup.get(`/api/cases/${K.dc}`)).status, 200, 'supervisor still sees unsealed cases');
});

test('prosecution-wide supervisor sees all offices but not SID without compartment', async () => {
  const ids = await listIds('prosChief');
  assert.ok(ids.includes(K.da) && ids.includes(K.ag) && ids.includes(K.dcliCase));
  assert.ok(!ids.includes(K.sid) && !ids.includes(K.dc));
});

test('sharing: users from other offices need CASE_SHARE; clearance is checked', async () => {
  assert.equal((await C.daPro1.post(`/api/cases/${K.da}/participants`, { userId: U.dcJudge1, role: 'OBSERVER' })).status, 403);
  const low = await C.dcAdmin.post(`/api/cases/${K.dc}/access`, { subjectType: 'USER', subjectId: U.lowClearance, reason: 'needs to read' });
  assert.equal(low.status, 201, 'INTERNAL clearance suffices for a STANDARD case');
  const confidential = (await createCase(C.dcAdmin, { typeCode: 'WARRANT', orgId: orgId(t.db, 'DC'), title: 'Warrant (DEMO)' })).id;
  const denied = await C.dcAdmin.post(`/api/cases/${confidential}/access`, { subjectType: 'USER', subjectId: U.lowClearance, reason: 'needs to read' });
  assert.equal(denied.status, 400);
  assert.equal((await get('lowClearance', confidential)).status, 404, 'office access does not bypass the level');
});

test('temporary access expires', async () => {
  const res = await C.daSup.post(`/api/cases/${K.da}/access`, { subjectType: 'USER', subjectId: U.agPro, reason: 'consultation',
    expiresAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(res.status, 201);
  assert.equal((await get('agPro', K.da)).status, 200);
  t.db.prepare("UPDATE case_access SET expires_at = '2000-01-01T00:00:00.000Z' WHERE case_id = ? AND subject_type = 'USER' AND subject_id = ?").run(K.da, U.agPro);
  assert.equal((await get('agPro', K.da)).status, 404);
});

test('case-bound delegation of CASE_VIEW works only while the delegator can see the case', async () => {
  const approver = createUser(t.db, { username: 'daSec', orgs: [['DA']], roles: [['SECURITY_ADMIN', 'DA']] });
  const req = await C.daPro1.post('/api/delegations', { toUserId: U.dcliOfficer, permission: 'CASE_VIEW', scopeOrgId: null, caseId: K.da,
    startsAt: new Date(Date.now() - 1000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString(), reason: 'expert opinion' });
  assert.equal(req.status, 201);
  const secC = await login(t, 'daSec');
  assert.equal((await secC.post(`/api/delegations/${req.body.id}/approve`, { reason: 'approved' })).status, 200);
  assert.equal((await get('dcliOfficer', K.da)).status, 200);
  // Delegation gilt nur für diese Akte
  assert.equal((await get('dcliOfficer', K.ag)).status, 404);
  // Delegierender verliert die Beteiligung und die Office-Sicht → Delegation wirkungslos
  t.db.prepare('UPDATE case_participants SET removed_at = ? WHERE case_id = ? AND user_id = ?').run(new Date().toISOString(), K.da, U.daPro1);
  t.db.prepare("DELETE FROM user_roles WHERE user_id = ?").run(U.daPro1);
  assert.equal((await get('dcliOfficer', K.da)).status, 404);
  t.db.prepare("INSERT INTO user_roles (user_id, role_id, scope_org_id) VALUES (?, (SELECT id FROM roles WHERE code='PROSECUTOR'), ?)").run(U.daPro1, orgId(t.db, 'DA'));
  t.db.prepare('UPDATE case_participants SET removed_at = NULL WHERE case_id = ? AND user_id = ?').run(K.da, U.daPro1);
  assert.ok(approver);
});

test('transfer moves office visibility; the lead keeps access', async () => {
  const k = (await createCase(C.daPro1, { typeCode: 'CRIMINAL', orgId: orgId(t.db, 'DA'), title: 'To be transferred (DEMO)' })).id;
  assert.equal((await get('agPro', k)).status, 404);
  const res = await C.daSup.post(`/api/cases/${k}/transfer`, { orgId: orgId(t.db, 'AG'), reason: 'Jurisdiction of the Attorney General' });
  assert.equal(res.status, 200);
  assert.equal((await get('agPro', k)).status, 200);
  assert.equal((await get('daPro2', k)).status, 404, 'old office loses visibility');
  assert.equal((await get('daPro1', k)).status, 200, 'lead participant keeps access');
});

test('case numbers follow the per-office prefixes', async () => {
  const n = (id) => t.db.prepare('SELECT case_number FROM cases WHERE id = ?').get(id).case_number;
  assert.match(n(K.da), /^DA-\d{4}-\d{4}$/);
  assert.match(n(K.dc), /^DC-CR-\d{4}-\d{4}$/);
  assert.match(n(K.sja), /^SJA-\d{4}-\d{4}$/);
  assert.match(n(K.sid), /^SID-\d{4}-\d{4}$/);
});

test('disabled case types cannot be created (constitutional review)', async () => {
  const cc = createUser(t.db, { username: 'ccJudge', orgs: [['CC']], roles: [['CONSTITUTIONAL_JUDGE', 'CC']] });
  t.db.prepare("INSERT INTO user_permissions (user_id, permission_code, scope_org_id) VALUES (?, 'CASE_CREATE', ?)").run(cc, orgId(t.db, 'CC'));
  const c = await login(t, 'ccJudge');
  const res = await c.post('/api/cases', { typeCode: 'CONSTITUTIONAL', orgId: orgId(t.db, 'CC'), title: 'Review' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'FEATURE_DISABLED');
});

test('creating a case with a weaker profile than the type requires is rejected', async () => {
  const res = await C.sidInv.post('/api/cases', { typeCode: 'SID_INVESTIGATION', orgId: orgId(t.db, 'SID'), title: 'Weak', securityProfile: 'STANDARD' });
  assert.equal(res.status, 400);
});

test('denied access to hidden cases is audited with the case\'s level and compartments', async () => {
  await get('chief', K.sja);
  const e = t.db.prepare("SELECT * FROM audit_log WHERE action = 'CASE_ACCESS' AND outcome = 'DENIED' AND actor_user_id = ? ORDER BY id DESC LIMIT 1").get(U.chief);
  assert.equal(e.resource_id, String(K.sja));
  assert.deepEqual(JSON.parse(e.resource_compartments), ['USSJA']);
});

test('case events are append-only', () => {
  assert.throws(() => t.db.prepare('DELETE FROM case_events').run(), /append-only/);
});

// ------------------------------------------------------------------ A18: Parität mit unabhängiger Referenz

/** Unabhängige, bewusst naive Implementierung der Regeln aus SECURITY_MODEL.md Abschnitt 4 (ohne Delegationen). */
function referenceCanView(db, userId, caseId) {
  const now = new Date().toISOString();
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
  const rank = (code) => db.prepare('SELECT rank FROM security_levels WHERE code = ?').get(code).rank;
  if (u.status !== 'ACTIVE' || rank(u.clearance_level) < rank(c.security_level)) return false;
  const held = new Set(db.prepare('SELECT compartment_code c FROM user_compartments WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)').all(userId, now).map((r) => r.c));
  if (db.prepare('SELECT compartment_code c FROM case_compartments WHERE case_id = ?').all(caseId).some((r) => !held.has(r.c))) return false;

  const parent = new Map(db.prepare('SELECT id, parent_id FROM organizations').all().map((o) => [o.id, o.parent_id]));
  const ancestors = (id) => { const out = []; for (let x = id; x != null; x = parent.get(x)) out.push(x); return out; };
  const grants = [
    ...db.prepare(`SELECT rp.permission_code code, ur.scope_org_id scope, ur.role_id role FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = ?`).all(userId),
    ...db.prepare('SELECT permission_code code, scope_org_id scope, NULL role FROM user_permissions WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)').all(userId, now),
  ];
  const has = (code, org) => grants.some((g) => g.code === code && (g.scope == null || ancestors(org).includes(g.scope)));
  const hasAny = (code) => grants.some((g) => g.code === code);
  const open = !c.is_sealed && !c.requires_explicit_access;
  const active = (a) => a.revoked_at == null && (a.expires_at == null || a.expires_at > now);

  if (hasAny('CASE_VIEW')) {
    const part = db.prepare('SELECT * FROM case_participants WHERE case_id = ? AND user_id = ? AND removed_at IS NULL AND grants_access = 1').all(caseId, userId);
    if (part.some((x) => !c.is_sealed || x.sealed_access)) return true;
    const acc = db.prepare('SELECT * FROM case_access WHERE case_id = ?').all(caseId).filter(active);
    if (acc.some((a) => a.subject_type === 'USER' && a.subject_id === userId && (!c.is_sealed || a.sealed_access))) return true;
    if (open) {
      const roleOk = acc.some((a) => a.subject_type === 'ROLE' && grants.some((g) => g.role === a.subject_id && g.code === 'CASE_VIEW'
        && (g.scope == null || ancestors(c.owning_org_id).includes(g.scope))));
      if (roleOk) return true;
      const memberships = db.prepare('SELECT org_id FROM memberships WHERE user_id = ?').all(userId).map((m) => m.org_id);
      const orgOk = acc.some((a) => a.subject_type === 'ORG' && memberships.some((m) => ancestors(m).includes(a.subject_id) && has('CASE_VIEW', m)));
      if (orgOk) return true;
    }
  }
  return open && has('CASE_VIEW_ORG', c.owning_org_id);
}

test('A18: list, single-case check and independent reference agree for every user × every case', () => {
  // Delegationen ausklammern (Referenz modelliert sie nicht)
  t.db.prepare("UPDATE delegations SET status = 'REVOKED'").run();
  const service = createCaseService(t.ctx);
  const allUsers = t.db.prepare("SELECT * FROM users WHERE status = 'ACTIVE'").all();
  const allCases = t.db.prepare('SELECT id FROM cases').all().map((r) => r.id);
  let checks = 0;
  for (const u of allUsers) {
    const p = loadPrincipal(t.db, u);
    const listed = new Set(service.list(p, { limit: 100 }).items.map((x) => x.id));
    for (const caseId of allCases) {
      const expected = referenceCanView(t.db, u.id, caseId);
      assert.equal(canViewCase(t.db, p, caseId), expected, `canView ${u.username} → case ${caseId}`);
      assert.equal(listed.has(caseId), expected, `list ${u.username} → case ${caseId}`);
      checks++;
    }
  }
  assert.ok(checks > 200, `checked ${checks} combinations`);
});

test('audit chain intact', () => assert.equal(t.ctx.audit.verify().ok, true));
