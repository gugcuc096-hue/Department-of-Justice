'use strict';
/**
 * Cross-Department-Verfahren (prompt.txt 6.5, WORKFLOWS.md 4):
 * Prosecution → District Court → Richterentscheidung → Signatur → Ausfertigung → USMS → Vollstreckung → Rückmeldung.
 * Bei jedem Schritt wird geprüft, wer was sehen und tun darf.
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
  ['pro2', { orgs: [['DA', 'Prosecutor']], roles: [['PROSECUTOR', 'DA']] }],
  ['ag', { orgs: [['AG', 'Attorney General']], roles: [['PROSECUTOR', 'AG']] }],
  ['clerk', { orgs: [['DC']], roles: [['COURT_ADMINISTRATION', 'DC']] }],
  ['judge', { orgs: [['DC', 'Senior Judge']], roles: [['JUDGE', 'DC']] }],
  ['judge2', { orgs: [['DC', 'Judge']], roles: [['JUDGE', 'DC']] }],
  ['deputy', { orgs: [['USMS']], roles: [['USMS_DEPUTY', 'USMS']] }],
  ['coa', { orgs: [['COA', 'Appellate Justice']], roles: [['JUDGE', 'COA']] }],
];

const application = (extra = {}) => ({
  sourceCaseId: K.source, kind: 'SEARCH_WARRANT', title: 'Wohnung Carter (DEMO)',
  content: { subjectName: 'J. Carter (DEMO)', offense: 'des bewaffneten Raubes', requestedMeasure: 'Die Durchsuchung der Wohnung Grove Street 12 wird angeordnet.',
    grounds: 'Zeugenaussagen belegen, dass die Tatbeute dort gelagert wird. (DEMO)' },
  ...extra,
});

test.before(async () => {
  t = await startApp();
  for (const [name, o] of users) U[name] = createUser(t.db, { username: name, ...o });
  for (const [name] of users) C[name] = await login(t, name);
  K.source = (await C.pro.post('/api/cases', { typeCode: 'CRIMINAL', orgId: orgId(t.db, 'DA'), title: 'State v. Carter (DEMO)' })).body.id;
  K.evidence = (await C.pro.post('/api/documents', { typeCode: 'MEMO', caseId: K.source, title: 'Zeugenvermerk (DEMO)', content: { text: 'Aussage (DEMO)' } })).body.id;
  K.internal = (await C.pro.post('/api/documents', { typeCode: 'MEMO', caseId: K.source, title: 'Interne Strategie (DEMO)', content: { text: 'intern' } })).body.id;
});
test.after(() => t.close());

test('prosecutor drafts an application from the case; incomplete drafts cannot be submitted', async () => {
  const opts = (await C.pro.get(`/api/application-options?caseId=${K.source}`)).body;
  assert.deepEqual(opts.kinds.map((k) => k.code).sort(), ['ARREST_WARRANT', 'SEARCH_WARRANT', 'SUBPOENA']);
  assert.deepEqual(opts.courts.map((c) => c.code), ['DC']);

  const empty = await C.pro.post('/api/applications', application({ content: {} }));
  assert.equal(empty.status, 201);
  const submitEmpty = await C.pro.post(`/api/applications/${empty.body.id}/submit`, {});
  assert.equal(submitEmpty.status, 400);

  const res = await C.pro.post('/api/applications', application({ documentIds: [K.evidence] }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  K.app = res.body.id;
  assert.equal(res.body.status, 'DRAFT');
  assert.equal(res.body.securityLevel, 'CONFIDENTIAL', 'warrant applications are at least confidential');
  assert.match(res.body.applicationNo, /^APP-\d{4}-\d{4}$/);
});

test('attachments must come from the originating case', async () => {
  const other = (await C.ag.post('/api/cases', { typeCode: 'CRIMINAL', orgId: orgId(t.db, 'AG'), title: 'AG case (DEMO)' })).body.id;
  const doc = (await C.ag.post('/api/documents', { typeCode: 'MEMO', caseId: other, title: 'AG memo', content: { text: 'x' } })).body.id;
  assert.equal((await C.pro.patch(`/api/applications/${K.app}`, { documentIds: [doc] })).status, 400);
});

test('the court sees nothing before submission; after submission only the application and attached documents', async () => {
  assert.equal((await C.clerk.get(`/api/applications/${K.app}`)).status, 404);
  const sub = await C.pro.post(`/api/applications/${K.app}/submit`, {});
  assert.equal(sub.status, 200);
  assert.equal(sub.body.status, 'SUBMITTED');

  const seen = await C.clerk.get(`/api/applications/${K.app}`);
  assert.equal(seen.status, 200);
  assert.equal(seen.body.sourceCase, null, 'court does not see the prosecution case');
  assert.deepEqual(seen.body.documents.map((d) => d.id), [K.evidence]);
  assert.equal((await C.clerk.get(`/api/documents/${K.evidence}`)).status, 200, 'attached document shared');
  assert.equal((await C.clerk.get(`/api/documents/${K.internal}`)).status, 404, 'other case documents stay hidden');
  assert.equal((await C.clerk.get(`/api/cases/${K.source}`)).status, 404);
  assert.ok(seen.body.actions.some((a) => a.action === 'accept'));

  // Office-Kollege der Staatsanwaltschaft sieht den Antrag, andere Offices und Gerichte nicht
  assert.equal((await C.pro2.get(`/api/applications/${K.app}`)).status, 200);
  assert.equal((await C.ag.get(`/api/applications/${K.app}`)).status, 404);
  assert.equal((await C.coa.get(`/api/applications/${K.app}`)).status, 404);
  assert.equal((await C.deputy.get(`/api/applications/${K.app}`)).status, 404);
});

test('only court administration accepts; a judge of the court must be assigned', async () => {
  assert.equal((await C.judge2.post(`/api/applications/${K.app}/accept`, { judgeId: U.judge })).status, 403);
  const judges = (await C.clerk.get(`/api/applications/${K.app}/judges`)).body.map((j) => j.id).sort();
  assert.deepEqual(judges, [U.judge, U.judge2].sort());
  assert.equal((await C.clerk.post(`/api/applications/${K.app}/accept`, { judgeId: U.deputy })).status, 400);
  assert.equal((await C.clerk.post(`/api/applications/${K.app}/approve`, {})).status, 409, 'not possible in this state');

  const acc = await C.clerk.post(`/api/applications/${K.app}/accept`, { judgeId: U.judge });
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  assert.equal(acc.body.status, 'UNDER_REVIEW');
  assert.equal(acc.body.assignedJudge.id, U.judge);
  K.courtCase = acc.body.courtCase.id;
  assert.match(acc.body.courtCase.caseNumber, /^DC-W-/);
  assert.equal((await C.pro.get(`/api/cases/${K.courtCase}`)).status, 404, 'prosecution does not see the court case');
  assert.equal((await C.pro.get(`/api/applications/${K.app}`)).body.courtCase, null);
});

test('only the assigned judge decides; revision goes back to the applicant and returns to the same judge', async () => {
  assert.equal((await C.judge2.post(`/api/applications/${K.app}/approve`, {})).status, 403, 'unassigned judge');
  // Ablehnen und Überarbeitung anfordern erzeugen kein Dokument – hier greift allein die Zuweisungsregel
  assert.equal((await C.judge2.post(`/api/applications/${K.app}/deny`, { reason: 'not my case' })).status, 403, 'unassigned judge cannot deny');
  assert.equal((await C.judge2.post(`/api/applications/${K.app}/request_revision`, { reason: 'not my case' })).status, 403, 'unassigned judge cannot request revision');
  assert.equal((await C.pro.post(`/api/applications/${K.app}/approve`, {})).status, 403, 'applicant');
  assert.equal((await C.judge.post(`/api/applications/${K.app}/request_revision`, {})).status, 400, 'reason required');

  const rev = await C.judge.post(`/api/applications/${K.app}/request_revision`, { reason: 'Bitte konkrete Beweismittel benennen.' });
  assert.equal(rev.body.status, 'REVISION_REQUESTED');
  const mine = await C.pro.get(`/api/applications/${K.app}`);
  assert.ok(mine.body.canEdit);
  assert.equal(mine.body.decisionReason, 'Bitte konkrete Beweismittel benennen.');
  await C.pro.patch(`/api/applications/${K.app}`, { content: { ...application().content, grounds: 'Zeugin M. sah die Beute am 20.09. (DEMO)' } });
  const again = await C.pro.post(`/api/applications/${K.app}/submit`, {});
  assert.equal(again.body.status, 'UNDER_REVIEW', 'back to the assigned judge');
});

test('approval drafts the warrant from the client template; issuing requires a signature', async () => {
  const ok = await C.judge.post(`/api/applications/${K.app}/approve`, { reason: 'Voraussetzungen liegen vor.' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, 'APPROVED');
  K.decision = ok.body.decisionDocumentId;
  const doc = (await C.judge.get(`/api/documents/${K.decision}`)).body;
  assert.equal(doc.type.code, 'SEARCH_WARRANT');
  assert.match(doc.docNumber, /^DC-DB-/);
  assert.match(doc.currentVersion.renderedHtml, /erlässt das District Court of the United States of America folgenden/);
  assert.match(doc.currentVersion.renderedHtml, /wegen des Verdachts des bewaffneten Raubes/);
  assert.match(doc.currentVersion.renderedHtml, /Zeugin M\. sah die Beute/);
  assert.equal((await C.pro.get(`/api/documents/${K.decision}`)).status, 404, 'draft decision not visible to the applicant');

  const early = await C.judge.post(`/api/applications/${K.app}/issue`, {});
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, 'SIGNATURE_REQUIRED');
  assert.equal((await C.judge.post(`/api/documents/${K.decision}/sign`, { capacity: 'Issuing judge' })).status, 200);
});

test('issuing creates the warrant; USMS sees warrant and decision only, never the cases', async () => {
  const issued = await C.judge.post(`/api/applications/${K.app}/issue`, {});
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  assert.equal(issued.body.status, 'ISSUED');
  K.warrant = issued.body.warrant.id;
  assert.match(issued.body.warrant.warrantNo, /^W-\d{4}-\d{4}$/);
  assert.equal((await C.judge.get(`/api/documents/${K.decision}`)).body.status, 'ISSUED');

  const w = await C.deputy.get(`/api/warrants/${K.warrant}`);
  assert.equal(w.status, 200);
  assert.equal(w.body.subjectName, 'J. Carter (DEMO)');
  assert.equal(w.body.courtCase, null);
  assert.equal(w.body.sourceCase, null);
  assert.equal(w.body.applicationId, null);
  assert.equal(w.body.documentId, K.decision);
  assert.equal((await C.deputy.get(`/api/documents/${K.decision}`)).status, 200);
  assert.equal((await C.deputy.get(`/api/cases/${K.courtCase}`)).status, 404);
  assert.equal((await C.deputy.get(`/api/cases/${K.source}`)).status, 404);
  assert.ok(w.body.capabilities.start && w.body.capabilities.report);

  // Antragsteller sieht den ausgefertigten Beschluss und den Haftbefehl
  assert.equal((await C.pro.get(`/api/documents/${K.decision}`)).status, 200);
  assert.equal((await C.pro.get(`/api/warrants/${K.warrant}`)).status, 200);
  assert.equal((await C.ag.get(`/api/warrants/${K.warrant}`)).status, 404);
});

test('USMS executes and reports; the court acknowledges the return and the application closes', async () => {
  assert.equal((await C.pro.post(`/api/warrants/${K.warrant}/start`)).status, 403, 'prosecution cannot execute');
  assert.equal((await C.deputy.post(`/api/warrants/${K.warrant}/start`)).body.status, 'IN_EXECUTION');
  assert.equal((await C.deputy.post(`/api/warrants/${K.warrant}/acknowledge`)).status, 403);
  const rep = await C.deputy.post(`/api/warrants/${K.warrant}/report`, { outcome: 'Durchsuchung durchgeführt, Beute sichergestellt.', details: 'Zutritt 06:00 Uhr … (DEMO)' });
  assert.equal(rep.status, 200, JSON.stringify(rep.body));
  assert.equal(rep.body.status, 'EXECUTED');
  const reportId = rep.body.executionReportDocumentId;
  assert.equal((await C.judge.get(`/api/documents/${reportId}`)).status, 200, 'court sees the execution report');
  assert.equal((await C.pro.get(`/api/documents/${reportId}`)).status, 200, 'applicant sees the execution report');

  const ack = await C.clerk.post(`/api/warrants/${K.warrant}/acknowledge`);
  assert.equal(ack.body.status, 'RETURNED');
  assert.equal((await C.pro.get(`/api/applications/${K.app}`)).body.status, 'CLOSED');

  const courtTimeline = (await C.judge.get(`/api/cases/${K.courtCase}/timeline`)).body.map((e) => e.type);
  const sourceTimeline = (await C.pro.get(`/api/cases/${K.source}/timeline`)).body.map((e) => e.type);
  for (const type of ['APPLICATION_ISSUED', 'WARRANT_EXECUTED', 'WARRANT_RETURNED']) {
    assert.ok(courtTimeline.includes(type), `court ${type}`);
    assert.ok(sourceTimeline.includes(type), `source ${type}`);
  }
  const history = (await C.pro.get(`/api/applications/${K.app}`)).body.history.map((h) => h.action);
  assert.deepEqual(history, ['create', 'submit', 'accept', 'request_revision', 'submit', 'resubmit_review', 'approve', 'issue', 'close']);
});

test('recall: a judge recalls an active warrant; USMS can no longer execute it', async () => {
  const a = (await C.pro.post('/api/applications', application({ kind: 'ARREST_WARRANT', title: 'Festnahme Carter (DEMO)' }))).body.id;
  await C.pro.post(`/api/applications/${a}/submit`, {});
  await C.clerk.post(`/api/applications/${a}/accept`, { judgeId: U.judge });
  const approved = (await C.judge.post(`/api/applications/${a}/approve`, {})).body;
  await C.judge.post(`/api/documents/${approved.decisionDocumentId}/sign`, {});
  const w = (await C.judge.post(`/api/applications/${a}/issue`, {})).body.warrant.id;
  assert.equal((await C.deputy.post(`/api/warrants/${w}/recall`, { reason: 'try' })).status, 403);
  const r = await C.judge.post(`/api/warrants/${w}/recall`, { reason: 'Beschuldigter hat sich gestellt.' });
  assert.equal(r.body.status, 'RECALLED');
  assert.equal((await C.deputy.post(`/api/warrants/${w}/report`, { outcome: 'x-x', details: 'x-x' })).status, 409);
});

test('deny requires a reason and ends the procedure', async () => {
  const a = (await C.pro.post('/api/applications', application({ title: 'Zweite Durchsuchung (DEMO)' }))).body.id;
  await C.pro.post(`/api/applications/${a}/submit`, {});
  await C.clerk.post(`/api/applications/${a}/accept`, { judgeId: U.judge2 });
  assert.equal((await C.judge2.post(`/api/applications/${a}/deny`, {})).status, 400);
  const d = await C.judge2.post(`/api/applications/${a}/deny`, { reason: 'Kein hinreichender Tatverdacht.' });
  assert.equal(d.body.status, 'DENIED');
  assert.deepEqual(d.body.actions, []);
  assert.equal((await C.pro.post(`/api/applications/${a}/submit`, {})).status, 409);
});

test('disabled legal basis: warrant applications and execution can be switched off', async () => {
  t.db.prepare("UPDATE feature_flags SET enabled = 0 WHERE code = 'WARRANTS'").run();
  const res = await C.pro.post('/api/applications', application());
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'FEATURE_DISABLED');
  t.db.prepare("UPDATE feature_flags SET enabled = 1 WHERE code = 'WARRANTS'").run();
});

test('workflow history is append-only', () => {
  assert.throws(() => t.db.prepare('DELETE FROM workflow_actions').run(), /append-only/);
  assert.throws(() => t.db.prepare("UPDATE workflow_actions SET action = 'x'").run(), /append-only/);
});

test('audit chain intact', () => assert.equal(t.ctx.audit.verify().ok, true));
