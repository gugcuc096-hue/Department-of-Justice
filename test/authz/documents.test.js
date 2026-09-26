'use strict';
/**
 * Dokumente, Vorlagen, Signaturen, Uploads (Schritt 3.10) – über die HTTP-API.
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
  ['clerk', { orgs: [['DC']], roles: [['COURT_ADMINISTRATION', 'DC']] }],
  ['judge1', { orgs: [['DC', 'Judge']], roles: [['JUDGE', 'DC']] }],
  ['judge2', { orgs: [['DC', 'Senior Judge']], roles: [['JUDGE', 'DC']] }],
  ['daPro', { orgs: [['DA', 'Prosecutor']], roles: [['PROSECUTOR', 'DA']] }],
  ['daPro2', { orgs: [['DA', 'Prosecutor']], roles: [['PROSECUTOR', 'DA']] }],
  ['daSup', { orgs: [['DA', 'District Attorney']], roles: [['PROSECUTION_SUPERVISOR', 'DA']] }],
  ['deputy', { orgs: [['USMS']], roles: [['USMS_DEPUTY', 'USMS']] }],
  ['deputy2', { orgs: [['USMS']], roles: [['USMS_DEPUTY', 'USMS']] }],
  ['sid', { orgs: [['SID']], roles: [['SID_INVESTIGATOR', 'SID']], compartments: ['SID'] }],
];

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

async function upload(client, buffer, type, name = 'evidence.pdf') {
  const res = await fetch(`${t.baseUrl}/api/files`, {
    method: 'POST', body: buffer,
    headers: { 'content-type': type, 'x-filename': encodeURIComponent(name), 'x-csrf-token': client.csrf,
      cookie: [...client.jar].map(([k, v]) => `${k}=${v}`).join('; ') },
  });
  return { status: res.status, body: await res.json() };
}

test.before(async () => {
  t = await startApp();
  for (const [name, o] of users) U[name] = createUser(t.db, { username: name, ...o });
  for (const [name] of users) C[name] = await login(t, name);
  K.court = (await C.clerk.post('/api/cases', { typeCode: 'CRIMINAL', orgId: orgId(t.db, 'DC'), title: 'Court case (DEMO)' })).body.id;
  await C.clerk.post(`/api/cases/${K.court}/participants`, { userId: U.judge1, role: 'JUDGE', isPresiding: true });
  K.da = (await C.daPro.post('/api/cases', { typeCode: 'CRIMINAL', orgId: orgId(t.db, 'DA'), title: 'DA case (DEMO)' })).body.id;
  K.sid = (await C.sid.post('/api/cases', { typeCode: 'SID_INVESTIGATION', orgId: orgId(t.db, 'SID'), title: 'SID case (DEMO)' })).body.id;
});
test.after(() => t.close());

// Gerichtsbeschluss (Vorlage des Auftraggebers, prompt.txt 8.3). Haft-/Durchsuchungsbeschlüsse entstehen nur über
// das Antragsverfahren und werden in test/authz/applications.test.js geprüft.
const warrant = (extra = {}) => ({
  typeCode: 'COURT_ORDER', caseId: K.court, title: 'Gerichtsbeschluss (DEMO)',
  content: { vorsitzenderRichter: 'Judge One (DEMO)', angeklagtePerson: 'J. Carter (DEMO)', beschluss: 'Die Untersuchungshaft wird fortgesetzt.',
    begruendung: 'Fluchtgefahr <script>alert(1)</script>' },
  ...extra,
});

test('court order template follows the client template, escapes input and uses the agreed court name', async () => {
  const res = await C.judge1.post('/api/documents', warrant());
  assert.equal(res.status, 201, JSON.stringify(res.body));
  K.warrant = res.body.id;
  assert.match(res.body.docNumber, /^DC-B-\d{4}-0001$/);
  const html = res.body.currentVersion.renderedHtml;
  assert.match(html, /GERICHTSBESCHLUSS DES DISTRICT COURT OF THE UNITED STATES OF AMERICA/);
  assert.match(html, /Vorsitzender Richter/);
  assert.match(html, /Die Untersuchungshaft wird fortgesetzt/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(res.body.legalStatus, 'NOT_VERIFIED');
});

test('warrants cannot be created directly – only through the application procedure', async () => {
  const res = await C.judge1.post('/api/documents', { typeCode: 'SEARCH_WARRANT', caseId: K.court, title: 'Direct',
    content: { delikt: 'x', beschluss: 'x', begruendung: 'x' } });
  assert.equal(res.status, 400);
  const types = (await C.judge1.get(`/api/document-types?caseId=${K.court}`)).body.map((x) => x.code);
  assert.ok(!types.includes('SEARCH_WARRANT') && !types.includes('ARREST_WARRANT') && types.includes('COURT_ORDER'));
});

test('required template fields are validated with field errors', async () => {
  const res = await C.judge1.post('/api/documents', warrant({ content: { beschluss: 'x', begruendung: 'y' } }));
  assert.equal(res.status, 400);
  assert.ok(res.body.error.details.some((d) => d.field === 'content.vorsitzenderRichter'));
});

test('document types are restricted to issuing organizations', async () => {
  const res = await C.daPro.post('/api/documents', { ...warrant(), caseId: K.da });
  assert.equal(res.status, 400);
  const types = (await C.daPro.get(`/api/document-types?caseId=${K.da}`)).body.map((x) => x.code);
  assert.ok(types.includes('PROSECUTION_FILING') && !types.includes('COURT_ORDER') && !types.includes('JUDGMENT'));
});

test('office colleagues can read case documents but cannot edit or sign them', async () => {
  assert.equal((await C.judge2.get(`/api/documents/${K.warrant}`)).status, 200);
  assert.equal((await C.judge2.patch(`/api/documents/${K.warrant}`, { title: 'changed' })).status, 403);
  assert.equal((await C.judge2.post(`/api/documents/${K.warrant}/sign`, {})).status, 403);
  assert.equal((await C.daPro.get(`/api/documents/${K.warrant}`)).status, 404, 'other office: not found');
});

test('signing binds to version and hash; issued documents are frozen', async () => {
  const signed = await C.judge1.post(`/api/documents/${K.warrant}/sign`, { capacity: 'Issuing judge' });
  assert.equal(signed.status, 200);
  assert.equal(signed.body.status, 'SIGNED');
  const [sig] = signed.body.signatures;
  assert.equal(sig.status, 'VALID');
  assert.equal(sig.version, 1);
  assert.equal(sig.sha256, signed.body.currentVersion.sha256);
  assert.equal(sig.signer.rank, 'Judge');
  assert.equal(sig.signer.org, 'District Court of the United States of America');
  assert.equal((await C.judge1.post(`/api/documents/${K.warrant}/sign`, {})).status, 403, 'no double signature');

  const issued = await C.judge1.post(`/api/documents/${K.warrant}/issue`);
  assert.equal(issued.body.status, 'ISSUED');
  assert.equal((await C.judge1.patch(`/api/documents/${K.warrant}`, { title: 'late change' })).status, 403);
  const timeline = (await C.judge1.get(`/api/cases/${K.court}/timeline`)).body.map((e) => e.type);
  assert.ok(timeline.includes('DOCUMENT_SIGNED') && timeline.includes('DOCUMENT_ISSUED'));
});

test('editing a signed document creates a new version; the old signature is superseded, never valid for new content', async () => {
  const memo = (await C.judge1.post('/api/documents', { typeCode: 'MEMO', caseId: K.court, title: 'Vermerk (DEMO)', content: { text: 'Erster Stand' } })).body;
  await C.judge1.post(`/api/documents/${memo.id}/sign`, {});
  const edited = await C.judge1.patch(`/api/documents/${memo.id}`, { content: { text: 'Geänderter Stand' }, changeNote: 'Korrektur' });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.currentVersion.version, 2);
  assert.equal(edited.body.status, 'DRAFT');
  assert.deepEqual(edited.body.signatures.map((s) => [s.version, s.status]), [[1, 'SUPERSEDED']]);
  assert.equal((await C.judge1.post(`/api/documents/${memo.id}/issue`)).status, 403, 'cannot issue without a valid signature');
  const v1 = await C.judge1.get(`/api/documents/${memo.id}/versions/1`);
  assert.match(v1.body.renderedHtml, /Erster Stand/, 'old version remains retrievable');
  K.memo = memo.id;
});

test('tampering with a stored version is detected: signature INVALID, signing refused', async () => {
  const d = (await C.judge1.post('/api/documents', { typeCode: 'MEMO', caseId: K.court, title: 'Tamper test (DEMO)', content: { text: 'Original' } })).body;
  await C.judge1.post(`/api/documents/${d.id}/sign`, {});
  assert.throws(() => t.db.prepare("UPDATE document_versions SET rendered_html = 'x' WHERE document_id = ?").run(d.id), /append-only/);
  t.db.exec('DROP TRIGGER document_versions_no_update');
  t.db.prepare("UPDATE document_versions SET rendered_html = '<p>Forged</p>' WHERE document_id = ?").run(d.id);
  const after = await C.judge1.get(`/api/documents/${d.id}`);
  assert.equal(after.body.signatures[0].status, 'INVALID');
  t.db.exec(`CREATE TRIGGER document_versions_no_update BEFORE UPDATE ON document_versions
    BEGIN SELECT RAISE(ABORT, 'document_versions is append-only'); END`);
});

test('review flow: no self-approval, supervisor approves, author signs', async () => {
  const filing = (await C.daPro.post('/api/documents', { typeCode: 'PROSECUTION_FILING', caseId: K.da, title: 'Anklage (DEMO)',
    content: { betreff: 'Anklageschrift', sachverhalt: 'Sachverhalt (DEMO)' } })).body;
  assert.equal((await C.daPro.post(`/api/documents/${filing.id}/submit`)).body.status, 'IN_REVIEW');
  assert.equal((await C.daPro.post(`/api/documents/${filing.id}/approve`, { reason: 'self approval' })).status, 403);
  const approved = await C.daSup.post(`/api/documents/${filing.id}/approve`, { reason: 'Checked and approved' });
  assert.equal(approved.body.status, 'APPROVED');
  const signed = await C.daPro.post(`/api/documents/${filing.id}/sign`, { capacity: 'Prosecutor' });
  assert.equal(signed.body.status, 'SIGNED');
  assert.equal(signed.body.signatures[0].signer.rank, 'Prosecutor');
});

test('signature revocation by the signer, with reason; status falls back to draft', async () => {
  const d = (await C.daPro.post('/api/documents', { typeCode: 'MEMO', caseId: K.da, title: 'Revocation (DEMO)', content: { text: 'x' } })).body;
  const s = (await C.daPro.post(`/api/documents/${d.id}/sign`, {})).body.signatures[0];
  assert.equal((await C.daPro2.post(`/api/documents/${d.id}/signatures/${s.id}/revoke`, { reason: 'not mine' })).status, 403);
  const r = await C.daPro.post(`/api/documents/${d.id}/signatures/${s.id}/revoke`, { reason: 'Signed by mistake' });
  assert.equal(r.body.signatures[0].status, 'REVOKED');
  assert.equal(r.body.status, 'DRAFT');
  assert.throws(() => t.db.prepare('DELETE FROM signature_revocations').run(), /append-only/);
  assert.throws(() => t.db.prepare('DELETE FROM document_signatures').run(), /append-only/);
});

test('uploads: allow-list and content check, attachment and protected download', async () => {
  assert.equal((await upload(C.daPro, Buffer.from('<svg onload=alert(1)>'), 'image/svg+xml', 'x.svg')).status, 415);
  assert.equal((await upload(C.daPro, Buffer.from('not a pdf'), 'application/pdf')).status, 400);
  const up = await upload(C.daPro, PDF, 'application/pdf', '../../etc/passwd.pdf');
  assert.equal(up.status, 201);
  assert.doesNotMatch(up.body.originalName, /\.\.\//);

  // Fremde Datei kann nicht verwendet werden
  const foreign = await C.daSup.post('/api/documents', { typeCode: 'ATTACHMENT', caseId: K.da, title: 'Stolen', fileId: up.body.id });
  assert.equal(foreign.status, 400);
  const att = await C.daPro.post('/api/documents', { typeCode: 'ATTACHMENT', caseId: K.da, title: 'Evidence scan (DEMO)', fileId: up.body.id });
  assert.equal(att.status, 201);
  assert.equal(att.body.currentVersion.file.sha256.length, 64);

  const dl = await C.daPro2.get(`/api/files/${up.body.id}`);
  assert.equal(dl.status, 200, 'office colleague may download');
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  assert.match(dl.headers.get('content-security-policy'), /sandbox/);
  assert.equal((await C.judge1.get(`/api/files/${up.body.id}`)).status, 404, 'no access to the case → not found');
  assert.equal((await C.daPro.post('/api/documents', { typeCode: 'ATTACHMENT', caseId: K.da, title: 'Reuse', fileId: up.body.id })).status, 400, 'file already in use');
});

test('sealing the case hides its documents and files', async () => {
  const k = (await C.clerk.post('/api/cases', { typeCode: 'CRIMINAL', orgId: orgId(t.db, 'DC'), title: 'To seal (DEMO)' })).body.id;
  await C.clerk.post(`/api/cases/${k}/participants`, { userId: U.judge1, role: 'JUDGE' });
  const doc = (await C.judge1.post('/api/documents', { typeCode: 'MEMO', caseId: k, title: 'Hidden memo (DEMO)', content: { text: 'secret' } })).body;
  assert.equal((await C.judge2.get(`/api/documents/${doc.id}`)).status, 200);
  await C.judge1.post(`/api/cases/${k}/seal`, { reason: 'Witness protection' });
  assert.equal((await C.judge2.get(`/api/documents/${doc.id}`)).status, 404);
  assert.ok(!(await C.judge2.get('/api/documents?limit=100')).body.items.some((x) => x.id === doc.id));
  assert.equal((await C.judge1.get(`/api/documents/${doc.id}`)).status, 200);
});

test('SID documents require the SID compartment', async () => {
  const d = (await C.sid.post('/api/documents', { typeCode: 'MEMO', caseId: K.sid, title: 'SID memo (DEMO)', content: { text: 'x' } })).body;
  assert.deepEqual(d.compartments, ['SID']);
  assert.equal((await C.daSup.get(`/api/documents/${d.id}`)).status, 404);
});

test('documents cannot be less protected than their case', async () => {
  const res = await C.sid.post('/api/documents', { typeCode: 'MEMO', caseId: K.sid, title: 'Downgrade', content: { text: 'x' }, securityLevel: 'INTERNAL' });
  assert.equal(res.status, 400);
});

test('standalone documents: office visibility only', async () => {
  const d = await C.deputy.post('/api/documents', { typeCode: 'REPORT', orgId: orgId(t.db, 'USMS'), title: 'Operations report (DEMO)', content: { sachverhalt: 'x' } });
  assert.equal(d.status, 201);
  assert.match(d.body.docNumber, /^USMS-R-/);
  assert.equal((await C.deputy2.get(`/api/documents/${d.body.id}`)).status, 200);
  assert.equal((await C.daPro.get(`/api/documents/${d.body.id}`)).status, 404);
  assert.equal((await C.daPro.post('/api/documents', { typeCode: 'MEMO', orgId: orgId(t.db, 'USMS'), title: 'Foreign', content: { text: 'x' } })).status, 403);
});

test('draft deletion: only own unsigned drafts; deleted drafts disappear', async () => {
  const d = (await C.daPro.post('/api/documents', { typeCode: 'MEMO', caseId: K.da, title: 'Draft (DEMO)', content: { text: 'x' } })).body;
  assert.equal((await C.daPro2.delete(`/api/documents/${d.id}`)).status, 403);
  assert.equal((await C.daPro.delete(`/api/documents/${d.id}`)).status, 200);
  assert.equal((await C.daPro.get(`/api/documents/${d.id}`)).status, 404);
});

test('disabled legal function: court decisions cannot be created or signed while the flag is off', async () => {
  const d = (await C.judge1.post('/api/documents', warrant({ title: 'Second order (DEMO)' }))).body;
  t.db.prepare("UPDATE feature_flags SET enabled = 0 WHERE code = 'COURT_DECISIONS'").run();
  const created = await C.judge1.post('/api/documents', warrant());
  assert.equal(created.status, 403);
  assert.equal(created.body.error.code, 'FEATURE_DISABLED');
  assert.equal((await C.judge1.post(`/api/documents/${d.id}/sign`, {})).status, 403);
  t.db.prepare("UPDATE feature_flags SET enabled = 1 WHERE code = 'COURT_DECISIONS'").run();
});

test('audit chain intact', () => assert.equal(t.ctx.audit.verify().ok, true));
