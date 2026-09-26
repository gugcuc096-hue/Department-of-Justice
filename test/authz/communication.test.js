'use strict';
/**
 * Benachrichtigungen, Nachrichten, offizielle Anfragen (Schritt 3.14) – über die HTTP-API.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers');
const { createUser, login, orgId } = require('../fixtures');
const { GENERIC } = require('../../src/core/notifications/service');

let t;
const U = {};
const C = {};
const K = {};

const users = [
  ['pro', { orgs: [['DA', 'Prosecutor']], roles: [['PROSECUTOR', 'DA']] }],
  ['daSup', { orgs: [['DA', 'District Attorney']], roles: [['PROSECUTION_SUPERVISOR', 'DA']] }],
  ['ag', { orgs: [['AG', 'Attorney General']], roles: [['PROSECUTOR', 'AG']] }],
  ['courtAdmin', { orgs: [['DC']], roles: [['COURT_ADMINISTRATION', 'DC']] }],
  ['judge', { orgs: [['DC', 'Judge']], roles: [['JUDGE', 'DC']] }],
  ['judge2', { orgs: [['DC', 'Judge']], roles: [['JUDGE', 'DC']] }],
  ['dep', { orgs: [['USMS']], roles: [['USMS_DEPUTY', 'USMS']] }],
  ['usSup', { orgs: [['USMS']], roles: [['USMS_SUPERVISOR', 'USMS']] }],
  ['usSup2', { orgs: [['USMS']], roles: [['USMS_SUPERVISOR', 'USMS']] }],
];

const notes = async (who) => (await C[who].get('/api/notifications')).body.items;
const types = async (who) => (await notes(who)).map((n) => n.type);
const counters = async (who) => (await C[who].get('/api/me/counters')).body;

test.before(async () => {
  t = await startApp();
  for (const [name, o] of users) U[name] = createUser(t.db, { username: name, ...o });
  for (const [name] of users) C[name] = await login(t, name);
  K.daCase = (await C.pro.post('/api/cases', { typeCode: 'CRIMINAL', orgId: orgId(t.db, 'DA'), title: 'State v. Doe (DEMO)' })).body.id;
  K.doc = (await C.pro.post('/api/documents', { typeCode: 'MEMO', caseId: K.daCase, title: 'Vermerk (DEMO)', content: { text: 'x' } })).body.id;
  K.court = (await C.courtAdmin.post('/api/cases', { typeCode: 'CRIMINAL', orgId: orgId(t.db, 'DC'), title: 'Court case (DEMO)' })).body.id;
});
test.after(() => t.close());

// ------------------------------------------------------------------ Benachrichtigungen

test('the application procedure notifies exactly the people who have to act', async () => {
  const a = (await C.pro.post('/api/applications', { sourceCaseId: K.daCase, kind: 'ARREST_WARRANT', title: 'Festnahme Doe (DEMO)',
    content: { subjectName: 'J. Doe (DEMO)', offense: 'des Raubes', requestedMeasure: 'Festnahme', grounds: 'Zeugen (DEMO)' } })).body.id;
  await C.pro.post(`/api/applications/${a}/submit`, {});
  assert.ok((await types('courtAdmin')).includes('APPLICATION_SUBMITTED'));
  assert.ok(!(await types('ag')).includes('APPLICATION_SUBMITTED'), 'other offices are not notified');
  assert.ok(!(await types('pro')).includes('APPLICATION_SUBMITTED'), 'no notification for your own action');

  await C.courtAdmin.post(`/api/applications/${a}/accept`, { judgeId: U.judge });
  assert.ok((await types('judge')).includes('APPLICATION_ASSIGNED'));
  const approved = (await C.judge.post(`/api/applications/${a}/approve`, {})).body;
  assert.ok((await types('pro')).includes('APPLICATION_APPROVE'));
  await C.judge.post(`/api/documents/${approved.decisionDocumentId}/sign`, {});
  await C.judge.post(`/api/applications/${a}/issue`, {});
  const depNotes = await notes('dep');
  const w = depNotes.find((n) => n.type === 'WARRANT_ISSUED');
  assert.ok(w, 'executing agency notified');
  assert.match(w.link, /^\/app\/warrants\/\d+$/);
  assert.ok((await counters('dep')).notifications >= 1);
});

test('notifications disappear when access is withdrawn', async () => {
  await C.courtAdmin.post(`/api/cases/${K.court}/participants`, { userId: U.judge2, role: 'JUDGE' });
  const before = await notes('judge2');
  assert.ok(before.some((n) => n.type === 'CASE_PARTICIPANT_ADDED'));
  // Beteiligung entfernen und Office-Sicht entziehen (Akte versiegeln, ohne judge2)
  await C.courtAdmin.post(`/api/cases/${K.court}/participants`, { userId: U.judge, role: 'JUDGE' });
  const part = t.db.prepare('SELECT id FROM case_participants WHERE case_id = ? AND user_id = ?').get(K.court, U.judge2).id;
  await C.courtAdmin.post(`/api/cases/${K.court}/participants/${part}/remove`, { reason: 'Reassigned' });
  await C.judge.post(`/api/cases/${K.court}/seal`, { reason: 'Protection' });
  const after = await notes('judge2');
  assert.ok(!after.some((n) => n.type === 'CASE_PARTICIPANT_ADDED'), 'hidden after losing access');
});

test('notifications about sealed matters carry no details', async () => {
  const judge3 = createUser(t.db, { username: 'judge3', orgs: [['DC', 'Judge']], roles: [['JUDGE', 'DC']] });
  C.judge3 = await login(t, 'judge3');
  const k = (await C.courtAdmin.post('/api/cases', { typeCode: 'CRIMINAL', orgId: orgId(t.db, 'DC'), title: 'Secret witness matter (DEMO)' })).body.id;
  await C.courtAdmin.post(`/api/cases/${k}/participants`, { userId: U.judge, role: 'JUDGE', isPresiding: true });
  await C.courtAdmin.post(`/api/cases/${k}/participants`, { userId: judge3, role: 'JUDGE' });
  assert.equal((await C.judge.post(`/api/cases/${k}/seal`, { reason: 'Witness protection', keepUserIds: [judge3] })).status, 200);
  const d = await C.judge.post('/api/deadlines', { caseId: k, title: 'Secret witness statement (DEMO)', dueAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), responsibleUserId: judge3 });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const n = (await notes('judge3')).find((x) => x.type === 'DEADLINE_ASSIGNED');
  assert.ok(n);
  assert.equal(n.title, GENERIC.title);
  assert.doesNotMatch(JSON.stringify(n), /Secret|DC-CR/);
});

test('reminders: due-soon and overdue deadlines, sent once', async () => {
  const k = (await C.courtAdmin.post('/api/cases', { typeCode: 'CRIMINAL', orgId: orgId(t.db, 'DC'), title: 'Reminder case (DEMO)' })).body.id;
  await C.courtAdmin.post(`/api/cases/${k}/participants`, { userId: U.judge2, role: 'JUDGE' });
  await C.courtAdmin.post('/api/deadlines', { caseId: k, title: 'Soon (DEMO)', dueAt: new Date(Date.now() + 2 * 3_600_000).toISOString(), responsibleUserId: U.judge2 });
  await C.courtAdmin.post('/api/deadlines', { caseId: k, title: 'Late (DEMO)', dueAt: new Date(Date.now() - 3_600_000).toISOString(), responsibleUserId: U.judge2 });
  const first = t.ctx.reminders.runReminders();
  assert.ok(first >= 2);
  assert.equal(t.ctx.reminders.runReminders(), 0, 'idempotent');
  const kinds = await types('judge2');
  assert.ok(kinds.includes('DEADLINE_DUE_SOON') && kinds.includes('DEADLINE_OVERDUE'));
});

test('no notification is even stored for someone who lost access (not just hidden)', async () => {
  const k = (await C.courtAdmin.post('/api/cases', { typeCode: 'CRIMINAL', orgId: orgId(t.db, 'DC'), title: 'Lost access (DEMO)' })).body.id;
  await C.courtAdmin.post(`/api/cases/${k}/participants`, { userId: U.judge, role: 'JUDGE' });
  await C.courtAdmin.post(`/api/cases/${k}/participants`, { userId: U.judge2, role: 'JUDGE' });
  const d = (await C.courtAdmin.post('/api/deadlines', { caseId: k, title: 'Due soon (DEMO)', dueAt: new Date(Date.now() + 3_600_000).toISOString(), responsibleUserId: U.judge2 })).body.id;
  // judge2 verliert den Zugang: Beteiligung entfernt, Akte ohne judge2 versiegelt
  const part = t.db.prepare('SELECT id FROM case_participants WHERE case_id = ? AND user_id = ?').get(k, U.judge2).id;
  await C.courtAdmin.post(`/api/cases/${k}/participants/${part}/remove`, { reason: 'Reassigned' });
  await C.judge.post(`/api/cases/${k}/seal`, { reason: 'Protection' });
  t.ctx.reminders.runReminders();
  const stored = t.db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND subject_type = 'deadline' AND subject_id = ? AND type = 'DEADLINE_DUE_SOON'").get(U.judge2, d).n;
  assert.equal(stored, 0);
});

test('mark as read updates the counter', async () => {
  const before = (await counters('judge2')).notifications;
  assert.ok(before > 0);
  await C.judge2.post('/api/notifications/read-all', {});
  assert.equal((await counters('judge2')).notifications, 0);
});

// ------------------------------------------------------------------ Nachrichten

test('direct messages: only members see them; unread counts; messages are immutable', async () => {
  const c = await C.pro.post('/api/conversations', { kind: 'DIRECT', userIds: [U.dep], subject: 'Transport (DEMO)', body: 'Can you take over the transport?' });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  K.dm = c.body.id;
  assert.equal((await counters('dep')).messages, 1);
  assert.ok((await types('dep')).includes('MESSAGE'));
  assert.equal((await C.ag.get(`/api/conversations/${K.dm}`)).status, 404);
  const read = await C.dep.get(`/api/conversations/${K.dm}`);
  assert.equal(read.body.messages.length, 1);
  assert.equal((await counters('dep')).messages, 0);
  assert.equal((await C.dep.post(`/api/conversations/${K.dm}/messages`, { body: 'Yes, 14:00.' })).status, 201);
  assert.equal((await counters('pro')).messages, 1);
  assert.throws(() => t.db.prepare("UPDATE messages SET body = 'x'").run(), /append-only/);
});

test('case conversations follow case visibility', async () => {
  const k = (await C.courtAdmin.post('/api/cases', { typeCode: 'CRIMINAL', orgId: orgId(t.db, 'DC'), title: 'Chat case (DEMO)' })).body.id;
  const c = await C.courtAdmin.post('/api/conversations', { kind: 'CASE', caseId: k, subject: 'Scheduling (DEMO)', body: 'Trial dates?' });
  assert.equal(c.status, 201);
  assert.equal((await C.judge2.get(`/api/conversations/${c.body.id}`)).status, 200, 'office colleague');
  assert.equal((await C.pro.get(`/api/conversations/${c.body.id}`)).status, 404);
  assert.equal((await C.pro.post('/api/conversations', { kind: 'CASE', caseId: k, subject: 'x-x', body: 'x' })).status, 404);
});

test('department conversations: org members read, only authorized staff speak for the organization', async () => {
  const c = await C.daSup.post('/api/conversations', { kind: 'DEPARTMENT', fromOrgId: orgId(t.db, 'DA'), toOrgId: orgId(t.db, 'USMS'), subject: 'Cooperation (DEMO)', body: 'Coordination meeting?' });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal((await C.pro.post('/api/conversations', { kind: 'DEPARTMENT', fromOrgId: orgId(t.db, 'DA'), toOrgId: orgId(t.db, 'USMS'), subject: 'x-x', body: 'x' })).status, 403);
  const dep = await C.dep.get(`/api/conversations/${c.body.id}`);
  assert.equal(dep.status, 200);
  assert.equal(dep.body.canWrite, false);
  assert.equal((await C.dep.post(`/api/conversations/${c.body.id}/messages`, { body: 'x' })).status, 403);
  const reply = await C.usSup.post(`/api/conversations/${c.body.id}/messages`, { body: 'Agreed.' });
  assert.equal(reply.body.messages.at(-1).onBehalfOf.code, 'USMS');
  assert.equal((await C.ag.get(`/api/conversations/${c.body.id}`)).status, 404);
});

// ------------------------------------------------------------------ Offizielle Anfragen

test('official request: sent with a case document, assigned, answered and closed', async () => {
  const r = await C.daSup.post('/api/requests', { senderOrgId: orgId(t.db, 'DA'), receiverOrgId: orgId(t.db, 'USMS'), subject: 'Transport of a prisoner (DEMO)',
    body: 'Please transport J. Doe to the District Court.', priority: 'HIGH', caseId: K.daCase, documentIds: [K.doc] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  K.req = r.body.id;
  assert.match(r.body.requestNo, /^REQ-\d{4}-\d{4}$/);
  assert.ok((await types('usSup')).includes('REQUEST_RECEIVED'));

  const inbox = await C.usSup.get(`/api/requests/${K.req}`);
  assert.equal(inbox.body.case, null, 'receiver does not see the sender case');
  assert.deepEqual(inbox.body.documents.map((d) => d.id), [K.doc]);
  assert.equal((await C.usSup.get(`/api/documents/${K.doc}`)).status, 200);
  assert.equal((await C.dep.get(`/api/requests/${K.req}`)).status, 404, 'deputies without request rights');
  assert.equal((await C.ag.get(`/api/requests/${K.req}`)).status, 404);

  assert.equal((await C.usSup.post(`/api/requests/${K.req}/assign`, { userId: U.dep })).status, 400, 'assignee needs REQUEST_RESPOND');
  const as = await C.usSup.post(`/api/requests/${K.req}/assign`, { userId: U.usSup2 });
  assert.equal(as.body.status, 'ASSIGNED');
  assert.ok((await types('usSup2')).includes('REQUEST_ASSIGNED'));
  assert.equal((await C.usSup2.post(`/api/requests/${K.req}/start`)).body.status, 'IN_PROGRESS');
  const ans = await C.usSup2.post(`/api/requests/${K.req}/respond`, { response: 'Transport scheduled for Monday, 09:00. (DEMO)' });
  assert.equal(ans.body.status, 'ANSWERED');
  assert.ok((await types('daSup')).includes('REQUEST_ANSWERED'));
  assert.equal((await C.usSup.post(`/api/requests/${K.req}/close`)).status, 403, 'only the sender closes');
  const closed = await C.daSup.post(`/api/requests/${K.req}/close`);
  assert.equal(closed.body.status, 'CLOSED');
  assert.deepEqual(closed.body.history.map((h) => h.type), ['CREATED', 'ASSIGNED', 'IN_PROGRESS', 'ANSWERED', 'CLOSED']);
});

test('requests cannot be sent on behalf of foreign organizations; decline needs a reason', async () => {
  assert.equal((await C.daSup.post('/api/requests', { senderOrgId: orgId(t.db, 'USMS'), receiverOrgId: orgId(t.db, 'DC'), subject: 'x-x-x', body: 'x-x-x' })).status, 403);
  const r = (await C.daSup.post('/api/requests', { senderOrgId: orgId(t.db, 'DA'), receiverOrgId: orgId(t.db, 'USMS'), subject: 'Second (DEMO)', body: 'Please …' })).body.id;
  assert.equal((await C.usSup.post(`/api/requests/${r}/decline`, {})).status, 400);
  assert.equal((await C.usSup.post(`/api/requests/${r}/decline`, { reason: 'Not our jurisdiction' })).body.status, 'DECLINED');
  assert.ok((await types('daSup')).includes('REQUEST_DECLINED'));
});

test('audit chain intact', () => assert.equal(t.ctx.audit.verify().ok, true));
