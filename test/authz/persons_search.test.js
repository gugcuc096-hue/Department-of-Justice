'use strict';
/**
 * Personenakte, Unternehmen, globale Suche (Schritt 3.15) – insbesondere Such-Leak-Tests (A5, A8).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers');
const { createUser, login, orgId } = require('../fixtures');
const { ftsQuery } = require('../../src/core/search/service');

let t;
const U = {};
const C = {};
const K = {};

const users = [
  ['pro', { orgs: [['DA', 'Prosecutor']], roles: [['PROSECUTOR', 'DA']] }],
  ['pro2', { orgs: [['DA', 'Prosecutor']], roles: [['PROSECUTOR', 'DA']] }],
  ['ag', { orgs: [['AG', 'Attorney General']], roles: [['PROSECUTOR', 'AG']] }],
  ['sid', { orgs: [['SID']], roles: [['SID_INVESTIGATOR', 'SID']], compartments: ['SID'] }],
  ['judge', { orgs: [['DC', 'Judge']], roles: [['JUDGE', 'DC']] }],
  ['chief', { orgs: [['SC', 'Chief Justice']], roles: [['JUDGE', 'SC']], clearance: 'CLASSIFIED' }],
  ['sja', { orgs: [['USSJA']], roles: [['USSJA_MEMBER', 'USSJA']], compartments: ['USSJA'], clearance: 'CLASSIFIED' }],
  ['registrar', { orgs: [['REG']], roles: [['REGISTRAR', 'REG']], compartments: ['REGISTRY'] }],
  ['dcli', { orgs: [['DCLI']], roles: [['DCLI_OFFICER', 'DCLI']] }],
  ['nobody', { orgs: [['USMS']], roles: [] }],
];

const search = async (who, q, type) => (await C[who].get(`/api/search?q=${encodeURIComponent(q)}${type ? `&type=${type}` : ''}`)).body;
const hits = (res, type) => res.groups.find((g) => g.type === type)?.items ?? [];

test.before(async () => {
  t = await startApp();
  for (const [name, o] of users) U[name] = createUser(t.db, { username: name, ...o });
  for (const [name] of users) C[name] = await login(t, name);
  K.daCase = (await C.pro.post('/api/cases', { typeCode: 'CRIMINAL', orgId: orgId(t.db, 'DA'), title: 'Zanzibar smuggling ring (DEMO)', summary: 'Quartermaine harbor' })).body.id;
  K.sidCase = (await C.sid.post('/api/cases', { typeCode: 'SID_INVESTIGATION', orgId: orgId(t.db, 'SID'), title: 'Zanzibar internal inquiry (DEMO)' })).body.id;
  K.sjaCase = (await C.sja.post('/api/cases', { typeCode: 'US_SJA', orgId: orgId(t.db, 'USSJA'), title: 'Zanzibar special proceedings (DEMO)', securityProfile: 'USSJA_CLASSIFIED' })).body.id;
  K.sealed = (await C.pro.post('/api/cases', { typeCode: 'CRIMINAL', orgId: orgId(t.db, 'DA'), title: 'Zanzibar witness protection (DEMO)' })).body.id;
  assert.ok(K.daCase && K.sidCase && K.sjaCase && K.sealed);
});
test.after(() => t.close());

// ------------------------------------------------------------------ Personenakte

test('persons can be created and are visible to everyone with PERSON_VIEW', async () => {
  const res = await C.pro.post('/api/persons', { fullName: 'Victor Zanzibar (DEMO)', aliases: 'VZ', dateOfBirth: '1990-04-01' });
  assert.equal(res.status, 201);
  assert.match(res.body.personNo, /^PER-\d{4}-\d{4}$/);
  K.victor = res.body.id;
  assert.equal((await C.judge.get(`/api/persons/${K.victor}`)).status, 200);
  assert.equal((await C.ag.get(`/api/persons/${K.victor}`)).status, 200);
  assert.equal((await C.nobody.get(`/api/persons/${K.victor}`)).status, 404, 'without PERSON_VIEW');
  assert.equal((await C.judge.post('/api/persons', { fullName: 'X Y' })).status, 403, 'judges cannot create person records');
  assert.equal((await C.pro.post('/api/persons', { fullName: 'X', dateOfBirth: '01.04.1990' })).status, 400);
});

test('each relationship of a person is checked individually against the subject', async () => {
  const add = await C.pro.post(`/api/cases/${K.daCase}/participants`, { personId: K.victor, role: 'DEFENDANT' });
  assert.equal(add.status, 201);
  assert.ok(add.body.participants.some((x) => x.personId === K.victor && x.partyName === 'Victor Zanzibar (DEMO)'));
  const own = (await C.pro.get(`/api/persons/${K.victor}`)).body;
  assert.ok(own.links.some((l) => l.subjectType === 'case' && l.subjectId === K.daCase && l.relation === 'DEFENDANT'));
  const office = (await C.pro2.get(`/api/persons/${K.victor}`)).body;
  assert.ok(office.links.some((l) => l.subjectId === K.daCase), 'office colleague sees the case link (F9)');
  const other = (await C.ag.get(`/api/persons/${K.victor}`)).body;
  assert.equal(other.links.length, 0, 'AG office does not learn about the DA case');
  assert.ok(!JSON.stringify(other).includes('smuggling'));

  // Link to a case in the SID compartment is invisible to prosecutors
  await C.sid.post(`/api/cases/${K.sidCase}/participants`, { personId: K.victor, role: 'WITNESS' });
  assert.ok(!(await C.pro.get(`/api/persons/${K.victor}`)).body.links.some((l) => l.subjectId === K.sidCase));
  assert.ok((await C.sid.get(`/api/persons/${K.victor}`)).body.links.some((l) => l.subjectId === K.sidCase));
});

test('removing a participant removes the relationship', async () => {
  const c = (await C.pro.get(`/api/cases/${K.daCase}`)).body;
  const part = c.participants.find((x) => x.personId === K.victor);
  await C.pro.post(`/api/cases/${K.daCase}/participants/${part.id}/remove`, { reason: 'Entered in error' });
  assert.ok(!(await C.pro.get(`/api/persons/${K.victor}`)).body.links.some((l) => l.subjectId === K.daCase));
  await C.pro.post(`/api/cases/${K.daCase}/participants`, { personId: K.victor, role: 'DEFENDANT' });
});

test('person records in a compartment are invisible without it (detail, list, search)', async () => {
  const res = await C.registrar.post('/api/persons', { fullName: 'Baby Zanzibar (DEMO)', compartments: ['REGISTRY'] });
  assert.equal(res.status, 201);
  K.baby = res.body.id;
  assert.equal((await C.pro.get(`/api/persons/${K.baby}`)).status, 404);
  assert.ok(!(await C.pro.get('/api/persons?q=Baby')).body.items.length);
  assert.equal((await C.pro.get('/api/persons?q=Baby')).body.total, 0);
  assert.equal(hits(await search('pro', 'Baby Zanzibar'), 'person').length, 0);
  assert.equal(hits(await search('registrar', 'Baby Zanzibar'), 'person').length, 1);
  assert.equal((await C.pro.post('/api/persons', { fullName: 'Hidden', compartments: ['REGISTRY'] })).status, 403, 'only held compartments');
});

test('a person the applicant cannot see cannot be named as subject of an application', async () => {
  const bad = await C.pro.post('/api/applications', { sourceCaseId: K.daCase, kind: 'ARREST_WARRANT', title: 'Festnahme (DEMO)', subjectPersonId: K.baby,
    content: { offense: 'x', requestedMeasure: 'y', grounds: 'z' } });
  assert.equal(bad.status, 400);
  const ok = await C.pro.post('/api/applications', { sourceCaseId: K.daCase, kind: 'ARREST_WARRANT', title: 'Festnahme Zanzibar (DEMO)', subjectPersonId: K.victor,
    content: { offense: 'des Schmuggels', requestedMeasure: 'Festnahme', grounds: 'Zeugen (DEMO)' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.content.subjectName, 'Victor Zanzibar (DEMO)', 'name taken from the person record');
  assert.equal(ok.body.subjectPerson.id, K.victor);
  assert.ok((await C.pro.get(`/api/persons/${K.victor}`)).body.links.some((l) => l.subjectType === 'application'));
  assert.ok(!(await C.judge.get(`/api/persons/${K.victor}`)).body.links.some((l) => l.subjectType === 'application'), 'draft is not visible to the court');
});

// ------------------------------------------------------------------ Unternehmen

test('companies: DCLI creates, others view, only COMPANY_EDIT changes', async () => {
  const res = await C.dcli.post('/api/companies', { name: 'Zanzibar Imports LLC (DEMO)', registrationNo: 'GR-77', address: 'Harbor Rd 1' });
  assert.equal(res.status, 201);
  K.company = res.body.id;
  assert.equal((await C.pro.get(`/api/companies/${K.company}`)).status, 200);
  assert.equal((await C.pro.patch(`/api/companies/${K.company}`, { name: 'Changed' })).status, 403);
  assert.equal((await C.pro.post('/api/companies', { name: 'New Co' })).status, 403);
  const withOwner = await C.dcli.post(`/api/companies/${K.company}/people`, { personId: K.victor, role: 'OWNER' });
  assert.equal(withOwner.status, 201);
  assert.equal(withOwner.body.people[0].person.id, K.victor);
  assert.equal((await C.dcli.post(`/api/companies/${K.company}/people`, { personId: K.victor, role: 'OWNER' })).status, 409);
  const person = (await C.pro.get(`/api/persons/${K.victor}`)).body;
  assert.equal(person.companies[0].role, 'OWNER');
  // Registry-only person cannot be attached by someone who cannot see it
  assert.equal((await C.dcli.post(`/api/companies/${K.company}/people`, { personId: K.baby, role: 'EMPLOYEE' })).status, 400);
});

// ------------------------------------------------------------------ Suche

test('search finds visible cases by number, title and summary', async () => {
  const c = (await C.pro.get(`/api/cases/${K.daCase}`)).body;
  assert.equal(hits(await search('pro', c.caseNumber), 'case')[0].id, K.daCase);
  assert.ok(hits(await search('pro', 'Quartermaine'), 'case').some((x) => x.id === K.daCase), 'summary is indexed');
  assert.ok(hits(await search('pro2', 'smuggling'), 'case').some((x) => x.id === K.daCase), 'office visibility (F9)');
  assert.ok(hits(await search('pro', 'Zanz'), 'case').length >= 1, 'prefix search');
});

test('A5: prosecutors without the SID compartment never find SID cases', async () => {
  const r = await search('pro', 'Zanzibar internal inquiry');
  assert.ok(!hits(r, 'case').some((x) => x.id === K.sidCase));
  assert.ok(hits(await search('sid', 'Zanzibar internal inquiry'), 'case').some((x) => x.id === K.sidCase));
});

test('A8: a Chief Justice without the USSJA compartment cannot discover US-SJA cases – not even by count', async () => {
  const r = await search('chief', 'Zanzibar special proceedings');
  assert.equal(r.total, 0);
  assert.deepEqual(r.groups, []);
  const own = await search('sja', 'Zanzibar special proceedings');
  assert.ok(hits(own, 'case').some((x) => x.id === K.sjaCase));
  const num = (await C.sja.get(`/api/cases/${K.sjaCase}`)).body.caseNumber;
  assert.equal((await search('chief', num)).total, 0, 'number search does not reveal it either');
});

test('sealed cases disappear from search and counts for everyone without sealed access', async () => {
  assert.ok(hits(await search('pro2', 'witness protection'), 'case').some((x) => x.id === K.sealed));
  // Versiegeln dürfen Gerichte (CASE_SEAL); daher eine Gerichtsakte.
  const court = (await C.judge.post('/api/cases', { typeCode: 'CIVIL', orgId: orgId(t.db, 'DC'), title: 'Zanzibar custody dispute (DEMO)' }));
  assert.equal(court.status, 403, 'judges cannot create cases (court administration does)');
  createUser(t.db, { username: 'judge2', orgs: [['DC', 'Judge']], roles: [['JUDGE', 'DC'], ['COURT_ADMINISTRATION', 'DC']] });
  C.judge2 = await login(t, 'judge2');
  const cc = (await C.judge2.post('/api/cases', { typeCode: 'CIVIL', orgId: orgId(t.db, 'DC'), title: 'Zanzibar custody dispute (DEMO)' })).body;
  assert.ok(hits(await search('judge', 'custody dispute'), 'case').some((x) => x.id === cc.id));
  assert.equal((await C.judge2.post(`/api/cases/${cc.id}/seal`, { reason: 'Protection of a minor' })).status, 200);
  const after = await search('judge', 'custody dispute');
  assert.ok(!hits(after, 'case').some((x) => x.id === cc.id));
  assert.equal(after.total, 0);
  assert.ok(hits(await search('judge2', 'custody dispute'), 'case').some((x) => x.id === cc.id), 'the sealing judge keeps access');
});

test('documents are found by their content, only where the document is visible', async () => {
  const d = await C.pro.post('/api/documents', { typeCode: 'MEMO', caseId: K.daCase, title: 'Vermerk (DEMO)', content: { text: 'Lagerhalle Xylophonweg sieben' } });
  assert.equal(d.status, 201);
  assert.ok(hits(await search('pro', 'Xylophonweg'), 'document').some((x) => x.id === d.body.id));
  assert.equal((await search('ag', 'Xylophonweg')).total, 0);
  // Neue Version wird neu indexiert
  await C.pro.patch(`/api/documents/${d.body.id}`, { content: { text: 'Lagerhalle Quokkastraße' } });
  assert.ok(hits(await search('pro', 'Quokkastraße'), 'document').some((x) => x.id === d.body.id));
  assert.equal(hits(await search('pro', 'Xylophonweg'), 'document').length, 0, 'old version no longer matches');
});

test('messages are searchable only by conversation members', async () => {
  const conv = await C.pro.post('/api/conversations', { kind: 'DIRECT', userIds: [U.pro2], subject: 'Coordination (DEMO)', body: 'Meet at Pelikanplatz tomorrow' });
  assert.equal(conv.status, 201);
  assert.ok(hits(await search('pro2', 'Pelikanplatz'), 'message').length === 1);
  assert.equal((await search('ag', 'Pelikanplatz')).total, 0);
});

test('search input is never passed to FTS unescaped and is audited', async () => {
  assert.equal(ftsQuery('a" OR b*'), '"a"* "OR"* "b"*');
  for (const q of ['"unbalanced', 'NEAR(a b)', 'x OR y AND NOT z', '*', '^start', 'col:val']) {
    const res = await C.pro.get(`/api/search?q=${encodeURIComponent(q)}`);
    assert.ok([200, 400].includes(res.status), `${q} → ${res.status}`);
  }
  assert.equal((await C.pro.get('/api/search?q=a')).status, 400, 'at least two characters');
  const entry = t.db.prepare("SELECT * FROM audit_log WHERE action = 'SEARCH' AND actor_user_id = ? ORDER BY id DESC LIMIT 1").get(U.pro);
  assert.ok(entry);
  assert.equal(t.ctx.audit.verify().ok, true);
});

test('search types reflect what the user may see', async () => {
  const types = (await C.nobody.get('/api/search/types')).body.map((x) => x.type);
  assert.ok(!types.includes('case') && !types.includes('person'));
  const proTypes = (await C.pro.get('/api/search/types')).body.map((x) => x.type);
  assert.ok(proTypes.includes('case') && proTypes.includes('person'));
});
