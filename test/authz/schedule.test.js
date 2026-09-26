'use strict';
/**
 * Anhörungen und Fristen (Schritt 3.13) – über die HTTP-API.
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
  ['courtAdmin', { orgs: [['DC']], roles: [['COURT_ADMINISTRATION', 'DC']] }],
  ['clerk', { orgs: [['DC']], roles: [['COURT_CLERK', 'DC']] }],
  ['judge1', { orgs: [['DC', 'Judge']], roles: [['JUDGE', 'DC']] }],
  ['judge2', { orgs: [['DC', 'Senior Judge']], roles: [['JUDGE', 'DC']] }],
  ['pro', { orgs: [['DA', 'Prosecutor']], roles: [['PROSECUTOR', 'DA']] }],
  ['ag', { orgs: [['AG', 'Attorney General']], roles: [['PROSECUTOR', 'AG']] }],
  ['dep', { orgs: [['USMS']], roles: [['USMS_DEPUTY', 'USMS']] }],
];
const at = (hoursFromNow) => new Date(Date.now() + hoursFromNow * 3_600_000).toISOString();

test.before(async () => {
  t = await startApp();
  for (const [name, o] of users) U[name] = createUser(t.db, { username: name, ...o });
  for (const [name] of users) C[name] = await login(t, name);
  const mk = async (title) => {
    const id = (await C.courtAdmin.post('/api/cases', { typeCode: 'CRIMINAL', orgId: orgId(t.db, 'DC'), title })).body.id;
    await C.courtAdmin.post(`/api/cases/${id}/participants`, { userId: U.judge1, role: 'JUDGE', isPresiding: true });
    await C.courtAdmin.post(`/api/cases/${id}/participants`, { userId: U.clerk, role: 'CLERK' });
    return id;
  };
  K.case = await mk('United States v. Carter (DEMO)');
  K.case2 = await mk('United States v. Lee (DEMO)');
  K.sealed = await mk('Sealed matter (DEMO)');
});
test.after(() => t.close());

const hearing = (extra = {}) => ({
  caseId: K.case, title: 'Hauptverhandlung (DEMO)', kind: 'TRIAL_SESSION', room: 'Saal 1', startsAt: at(48), endsAt: at(50),
  participants: [{ userId: U.judge1, role: 'JUDGE', isPresiding: true }, { userId: U.pro, role: 'PROSECUTOR' }, { partyName: 'J. Carter (DEMO)', role: 'DEFENDANT' }],
  ...extra,
});

test('court administration schedules a hearing with judge, prosecutor and parties', async () => {
  const res = await C.courtAdmin.post('/api/hearings', hearing({ notes: 'Interne Notiz des Gerichts' }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  K.h = res.body.id;
  assert.match(res.body.hearingNo, /^DC-T-\d{4}-0001$/);
  assert.equal(res.body.participants.length, 3);
  assert.equal(res.body.securityLevel, 'INTERNAL');
});

test('invited prosecutor sees the hearing but not the court case or internal notes; others see nothing', async () => {
  const seen = await C.pro.get(`/api/hearings/${K.h}`);
  assert.equal(seen.status, 200);
  assert.equal(seen.body.case, null);
  assert.equal(seen.body.notes, '');
  assert.equal((await C.pro.get(`/api/cases/${K.case}`)).status, 404);
  assert.ok((await C.pro.get('/api/hearings?mine=1')).body.items.some((x) => x.id === K.h));
  assert.ok((await C.judge1.get('/api/hearings?mine=1')).body.items.some((x) => x.id === K.h), 'judge assigned to the case sees its hearings as hers');
  assert.ok(!(await C.judge2.get('/api/hearings?mine=1')).body.items.some((x) => x.id === K.h), 'office colleague: not in "mine"');
  assert.equal((await C.judge2.get(`/api/hearings/${K.h}`)).body.notes, 'Interne Notiz des Gerichts', 'court colleague sees it via the case');
  assert.equal((await C.ag.get(`/api/hearings/${K.h}`)).status, 404);
  assert.equal((await C.pro.post(`/api/hearings/${K.h}/reschedule`, { startsAt: at(72), endsAt: at(73), reason: 'try it' })).status, 403);
});

test('room and person conflicts are detected', async () => {
  const room = await C.courtAdmin.post('/api/hearings', hearing({ caseId: K.case2, title: 'Room clash', participants: [], startsAt: at(49), endsAt: at(51) }));
  assert.equal(room.status, 409);
  assert.equal(room.body.error.code, 'SCHEDULE_CONFLICT');
  assert.match(room.body.error.details[0].message, /DC-T-\d{4}-0001/, 'visible conflicts are named');
  const person = await C.courtAdmin.post('/api/hearings', hearing({ caseId: K.case2, title: 'Judge clash', room: 'Saal 2', startsAt: at(49), endsAt: at(51),
    participants: [{ userId: U.judge1, role: 'JUDGE' }] }));
  assert.equal(person.status, 409);
  assert.equal(person.body.error.details[0].field, 'participants');
  const ok = await C.courtAdmin.post('/api/hearings', hearing({ caseId: K.case2, title: 'Afterwards', startsAt: at(50), endsAt: at(51), participants: [] }));
  assert.equal(ok.status, 201, 'back-to-back is fine');
  // Richterin ist der Akte zugewiesen, aber nicht eingeladen → trotzdem „mein Termin“
  assert.ok(!ok.body.participants.some((x) => x.user?.id === U.judge1));
  assert.ok((await C.judge1.get('/api/hearings?mine=1')).body.items.some((x) => x.id === ok.body.id));
});

test('conflicts with hearings the planner cannot see are reported without details', async () => {
  const secret = await C.judge1.post('/api/hearings', { caseId: K.sealed, title: 'Geheime Anhörung (DEMO)', room: 'Saal 3', startsAt: at(96), endsAt: at(97) });
  assert.equal(secret.status, 201);
  await C.judge1.post(`/api/cases/${K.sealed}/seal`, { reason: 'Witness protection' });
  assert.equal((await C.courtAdmin.get(`/api/hearings/${secret.body.id}`)).status, 404);
  const clash = await C.courtAdmin.post('/api/hearings', hearing({ caseId: K.case2, title: 'Clash', room: 'Saal 3', startsAt: at(96), endsAt: at(98), participants: [] }));
  assert.equal(clash.status, 409);
  assert.doesNotMatch(JSON.stringify(clash.body), /DC-T-|Geheime|Saal 3.*booked/);
  assert.match(clash.body.error.details[0].message, /not available/);
});

test('scheduling rules: no past dates, end after start, only in court cases', async () => {
  assert.equal((await C.courtAdmin.post('/api/hearings', hearing({ startsAt: at(-5), endsAt: at(-4), participants: [] }))).status, 400);
  assert.equal((await C.courtAdmin.post('/api/hearings', hearing({ startsAt: at(10), endsAt: at(9), participants: [] }))).status, 400);
  const usmsCase = (await C.dep.post('/api/cases', { typeCode: 'USMS_INVESTIGATION', orgId: orgId(t.db, 'USMS'), title: 'x (DEMO)' })).body.id;
  assert.equal((await C.dep.post('/api/hearings', { caseId: usmsCase, title: 'Not a court', room: 'x', startsAt: at(5), endsAt: at(6) })).status, 400);
});

test('reschedule, postpone and cancel need reasons and are recorded in the case timeline', async () => {
  const r = await C.courtAdmin.post(`/api/hearings/${K.h}/reschedule`, { startsAt: at(120), endsAt: at(122), room: 'Saal 4', reason: 'Verteidiger verhindert' });
  assert.equal(r.status, 200);
  assert.equal(r.body.room, 'Saal 4');
  assert.equal((await C.courtAdmin.post(`/api/hearings/${K.h}/postpone`, {})).status, 400);
  assert.equal((await C.courtAdmin.post(`/api/hearings/${K.h}/postpone`, { reason: 'Zeuge erkrankt' })).body.status, 'POSTPONED');
  const types = (await C.judge1.get(`/api/cases/${K.case}/timeline`)).body.map((e) => e.type);
  assert.ok(types.includes('HEARING_SCHEDULED') && types.includes('HEARING_RESCHEDULED') && types.includes('HEARING_POSTPONED'));
  const c = await C.courtAdmin.post('/api/hearings', hearing({ title: 'To cancel', room: 'Saal 9', startsAt: at(200), endsAt: at(201), participants: [] }));
  assert.equal((await C.courtAdmin.post(`/api/hearings/${c.body.id}/cancel`, { reason: 'Verfahren eingestellt' })).body.status, 'CANCELLED');
  assert.equal((await C.courtAdmin.post(`/api/hearings/${c.body.id}/reschedule`, { startsAt: at(300), endsAt: at(301), reason: 'again' })).status, 409);
});

test('protocol: written by the clerk from the court template, marks the hearing as held', async () => {
  const h = (await C.courtAdmin.post('/api/hearings', hearing({ title: 'Anhörung heute (DEMO)', room: 'Saal 5', startsAt: at(-0.5), endsAt: at(0.5),
    participants: [{ userId: U.clerk, role: 'CLERK' }] }))).body;
  assert.equal((await C.pro.post(`/api/hearings/${h.id}/protocol`, { fields: { anwesende: 'x', verlauf: 'x' } })).status, 404, 'prosecutor not invited');
  const res = await C.clerk.post(`/api/hearings/${h.id}/protocol`, { fields: { anwesende: 'Richterin, Staatsanwältin, Angeklagter (DEMO)', verlauf: 'Die Sitzung wurde um 10:00 Uhr eröffnet. (DEMO)' } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.hearing.status, 'HELD');
  const doc = (await C.clerk.get(`/api/documents/${res.body.documentId}`)).body;
  assert.equal(doc.type.code, 'HEARING_PROTOCOL');
  assert.match(doc.currentVersion.renderedHtml, /SITZUNGSPROTOKOLL/);
  assert.equal((await C.clerk.post(`/api/hearings/${h.id}/protocol`, { fields: { anwesende: 'x', verlauf: 'x' } })).status, 403, 'only one protocol');
});

test('deadlines: responsible person must see the case; overdue is computed; extensions are logged', async () => {
  assert.equal((await C.courtAdmin.post('/api/deadlines', { caseId: K.case, title: 'Stellungnahme', dueAt: at(24), responsibleUserId: U.pro })).status, 400);
  const d = await C.courtAdmin.post('/api/deadlines', { caseId: K.case, title: 'Urteilsbegründung (DEMO)', dueAt: at(24 * 3), responsibleUserId: U.judge1 });
  assert.equal(d.status, 201);
  assert.equal(d.body.state, 'DUE_SOON');
  const late = await C.courtAdmin.post('/api/deadlines', { caseId: K.case, title: 'Akteneinsicht (DEMO)', dueAt: at(-24), responsibleUserId: U.judge1 });
  assert.equal(late.body.state, 'OVERDUE');
  const overdue = (await C.judge1.get('/api/deadlines?mine=1&state=overdue')).body.items.map((x) => x.id);
  assert.deepEqual(overdue, [late.body.id]);

  assert.equal((await C.judge1.post(`/api/deadlines/${d.body.id}/extend`, { dueAt: at(24), reason: 'shorter' })).status, 400);
  const ext = await C.judge1.post(`/api/deadlines/${d.body.id}/extend`, { dueAt: at(24 * 14), reason: 'Umfangreiche Beweisaufnahme' });
  assert.equal(ext.body.extensions.length, 1);
  assert.equal(ext.body.state, 'OPEN');
  assert.throws(() => t.db.prepare('DELETE FROM deadline_extensions').run(), /append-only/);

  assert.equal((await C.pro.post(`/api/deadlines/${late.body.id}/complete`)).status, 404, 'no case access');
  assert.equal((await C.judge1.post(`/api/deadlines/${late.body.id}/complete`)).body.status, 'DONE');
  assert.equal((await C.judge1.post(`/api/deadlines/${late.body.id}/complete`)).status, 409);
  const types = (await C.judge1.get(`/api/cases/${K.case}/timeline`)).body.map((e) => e.type);
  assert.ok(types.includes('DEADLINE_SET') && types.includes('DEADLINE_EXTENDED') && types.includes('DEADLINE_DONE'));
});

test('audit chain intact', () => assert.equal(t.ctx.audit.verify().ok, true));
