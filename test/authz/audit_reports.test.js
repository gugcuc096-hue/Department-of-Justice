'use strict';
/**
 * Audit-Ansicht, Reports, Exporte, Dashboard, Entwürfe (Schritt 3.16) – u. a. Testfall A17.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers');
const { createUser, login, orgId } = require('../fixtures');

let t;
const U = {};
const C = {};
const K = {};

const users = [
  ['pro', { orgs: [['DA', 'Prosecutor']], roles: [['PROSECUTOR', 'DA']] }],
  ['daSup', { orgs: [['DA', 'District Attorney']], roles: [['PROSECUTION_SUPERVISOR', 'DA']] }],
  ['ag', { orgs: [['AG', 'Attorney General']], roles: [['PROSECUTOR', 'AG']] }],
  ['sja', { orgs: [['USSJA']], roles: [['USSJA_MEMBER', 'USSJA']], compartments: ['USSJA'], clearance: 'CLASSIFIED' }],
  ['auditGlobal', { orgs: [['SJCS']], roles: [['AUDIT_ADMIN', null]], clearance: 'CLASSIFIED' }],
  ['auditSja', { orgs: [['SJCS']], roles: [['AUDIT_ADMIN', null]], clearance: 'CLASSIFIED', compartments: ['USSJA'] }],
  ['auditDa', { orgs: [['DA']], roles: [['AUDIT_ADMIN', 'DA']], clearance: 'CLASSIFIED' }],
  ['auditLow', { orgs: [['SJCS']], roles: [['AUDIT_ADMIN', null]], clearance: 'INTERNAL' }],
  ['judge', { orgs: [['DC', 'Judge']], roles: [['JUDGE', 'DC']] }],
];

test.before(async () => {
  t = await startApp();
  for (const [name, o] of users) U[name] = createUser(t.db, { username: name, ...o });
  for (const [name] of users) C[name] = await login(t, name);
  K.daCase = (await C.pro.post('/api/cases', { typeCode: 'CRIMINAL', orgId: orgId(t.db, 'DA'), title: 'Audit test case (DEMO)' })).body.id;
  K.agCase = (await C.ag.post('/api/cases', { typeCode: 'CRIMINAL', orgId: orgId(t.db, 'AG'), title: 'AG case (DEMO)' })).body.id;
  K.sjaCase = (await C.sja.post('/api/cases', { typeCode: 'US_SJA', orgId: orgId(t.db, 'USSJA'), title: 'Secret proceedings (DEMO)' })).body.id;
  await C.sja.get(`/api/cases/${K.sjaCase}`);
  // Zugriffsversuch eines Unberechtigten auf die US-SJA-Akte erzeugt einen DENIED-Eintrag mit Compartment
  assert.equal((await C.judge.get(`/api/cases/${K.sjaCase}`)).status, 404);
});
test.after(() => t.close());

const auditRows = async (who, q = '') => (await C[who].get(`/api/audit?limit=200${q}`)).body;

// ------------------------------------------------------------------ Audit-Ansicht

test('A17: an auditor without the USSJA compartment sees no US-SJA entries – not even denied attempts', async () => {
  const global = await auditRows('auditGlobal', `&caseId=${K.sjaCase}`);
  assert.equal(global.total, 0);
  const withSja = await auditRows('auditSja', `&caseId=${K.sjaCase}`);
  assert.ok(withSja.total >= 3, 'create, view and denied access are visible with the compartment');
  assert.ok(withSja.items.some((e) => e.outcome === 'DENIED' && e.actor?.id === U.judge));
  // auch nicht über Aktionsfilter oder Zählungen
  const all = await auditRows('auditGlobal', '&action=CASE_CREATE');
  assert.ok(!all.items.some((e) => e.resource?.id === String(K.sjaCase)));
});

test('auditors only see entries of organizations in their scope', async () => {
  const da = await auditRows('auditDa', '&resourceType=case');
  assert.ok(da.items.some((e) => e.resource.id === String(K.daCase)));
  assert.ok(!da.items.some((e) => e.resource.id === String(K.agCase)), 'AG entries are outside the DA scope');
  assert.ok(!da.items.some((e) => e.action === 'AUTH_LOGIN' && e.actor?.id === U.judge), 'entries without organization need global audit rights');
});

test('clearance limits audit visibility', async () => {
  const low = await auditRows('auditLow', `&caseId=${K.daCase}`);
  assert.ok(low.total > 0, 'INTERNAL case entries are visible');
  const conf = await C.daSup.post('/api/cases', { typeCode: 'CRIMINAL', orgId: orgId(t.db, 'DA'), title: 'Confidential (DEMO)', securityProfile: 'CONFIDENTIAL' });
  assert.equal(conf.status, 201);
  assert.equal((await auditRows('auditLow', `&caseId=${conf.body.id}`)).total, 0);
  assert.ok((await auditRows('auditGlobal', `&caseId=${conf.body.id}`)).total > 0);
});

test('audit access requires AUDIT_VIEW and is itself audited', async () => {
  assert.equal((await C.pro.get('/api/audit')).status, 403);
  assert.equal((await C.pro.get('/api/audit/verify')).status, 403);
  await auditRows('auditDa');
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'AUDIT_VIEW' AND actor_user_id = ?").get(U.auditDa));
  const v = (await C.auditDa.get('/api/audit/verify')).body;
  assert.deepEqual(v, { ok: true });
});

test('audit export: CSV, formula injection neutralized, requires AUDIT_EXPORT', async () => {
  // Eingabe mit Formelzeichen landet in den Details eines Audit-Eintrags
  await C.pro.get(`/api/search?q=${encodeURIComponent('=HYPERLINK("x")')}`);
  const res = await C.auditGlobal.get('/api/audit/export?action=SEARCH');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment/);
  assert.ok(res.text.startsWith('id,timestamp,action'));
  assert.ok(!/\n=/.test(res.text) && !/,=/.test(res.text), 'no cell starts with =');
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'AUDIT_EXPORT' AND actor_user_id = ?").get(U.auditGlobal));
  assert.equal((await C.judge.get('/api/audit/export')).status, 403);
  const sjaCsv = (await C.auditGlobal.get(`/api/audit/export?caseId=${K.sjaCase}`)).text;
  assert.equal(sjaCsv.trim().split('\n').length, 1, 'only the header – A17 holds for exports too');
});

// ------------------------------------------------------------------ Reports

test('reports count only visible records and require REPORT_VIEW', async () => {
  assert.equal((await C.pro.get('/api/reports')).body.length, 0, 'prosecutors have no report permission');
  assert.equal((await C.pro.get('/api/reports/cases')).status, 403);
  const list = (await C.daSup.get('/api/reports')).body.map((r) => r.kind);
  assert.ok(list.includes('cases') && !list.includes('personnel') && !list.includes('audit'));
  const r = (await C.daSup.get('/api/reports/cases')).body;
  assert.ok(r.rows.every((x) => x.office === 'DA'), 'only DA cases are counted for a DA supervisor');
  assert.ok(r.total >= 2);
  assert.equal((await C.daSup.get('/api/reports/personnel')).status, 403);
  assert.equal((await C.daSup.get('/api/reports/unknown')).status, 404);
});

test('report export requires REPORT_EXPORT and is audited', async () => {
  t.db.prepare("INSERT INTO role_permissions (role_id, permission_code) SELECT id, 'REPORT_EXPORT' FROM roles WHERE code = 'PROSECUTION_SUPERVISOR'").run();
  const res = await C.daSup.get('/api/reports/cases/export');
  assert.equal(res.status, 200);
  assert.ok(res.text.startsWith('Office,Type,Status,Cases'));
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'REPORT_EXPORT' AND actor_user_id = ?").get(U.daSup));
  assert.equal((await C.pro.get('/api/reports/cases/export')).status, 403);
});

test('case export requires CASE_EXPORT in the case scope and respects visibility', async () => {
  assert.equal((await C.pro.get(`/api/cases/${K.daCase}/export`)).status, 403, 'prosecutors lack CASE_EXPORT');
  const res = await C.daSup.get(`/api/cases/${K.daCase}/export`);
  assert.equal(res.status, 200);
  const bundle = JSON.parse(res.text);
  assert.equal(bundle.case.id, K.daCase);
  assert.ok(Array.isArray(bundle.timeline) && Array.isArray(bundle.documents));
  assert.equal((await C.daSup.get(`/api/cases/${K.agCase}/export`)).status, 404, 'invisible cases stay invisible');
  assert.ok(t.db.prepare("SELECT 1 FROM audit_log WHERE action = 'CASE_EXPORT' AND outcome = 'SUCCESS' AND actor_user_id = ?").get(U.daSup));
});

// ------------------------------------------------------------------ Dashboard

test('the dashboard follows the active organization and counts only visible data', async () => {
  const d = (await C.pro.get('/api/dashboard')).body;
  assert.equal(d.kind, 'PROSECUTION');
  const open = d.widgets.find((w) => w.id === 'cases-open');
  assert.equal(open.value, 2, 'both open DA cases (office visibility, cleared for CONFIDENTIAL) – not the AG case');
  const sja = (await C.sja.get('/api/dashboard')).body;
  assert.equal(sja.kind, 'USSJA');
  assert.equal(sja.widgets.find((w) => w.id === 'cases-open').value, 1);
  assert.ok(!sja.widgets.some((w) => ['requests-inbox', 'documents-review', 'evidence-pending'].includes(w.id)), 'no information from other areas');
  const judge = (await C.judge.get('/api/dashboard')).body;
  assert.equal(judge.kind, 'JUDICIARY');
  assert.equal(judge.widgets.find((w) => w.id === 'cases-open').value, 0, 'the US-SJA case does not count for a district judge');
});

// ------------------------------------------------------------------ Entwürfe

test('drafts are stored per user and never shared', async () => {
  const key = 'case-new';
  assert.equal((await C.pro.put(`/api/drafts/${key}`, { payload: { title: 'Half-written (DEMO)' } })).status, 200);
  assert.equal((await C.pro.get(`/api/drafts/${key}`)).body.payload.title, 'Half-written (DEMO)');
  assert.equal((await C.ag.get(`/api/drafts/${key}`)).body, null, 'other users do not see it');
  assert.equal((await C.pro.put('/api/drafts/INVALID KEY', { payload: {} })).status, 400);
  assert.equal((await C.pro.put(`/api/drafts/${key}`, { payload: { big: 'x'.repeat(120_000) } })).status, 400);
  await C.pro.delete(`/api/drafts/${key}`);
  assert.equal((await C.pro.get(`/api/drafts/${key}`)).body, null);
});
