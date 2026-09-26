'use strict';
/**
 * Beweismittel und Chain of Custody (Schritt 3.12) – über die HTTP-API.
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
  ['dep', { orgs: [['USMS']], roles: [['USMS_DEPUTY', 'USMS']] }],
  ['dep2', { orgs: [['USMS']], roles: [['USMS_DEPUTY', 'USMS']] }],
  ['sup', { orgs: [['USMS']], roles: [['USMS_SUPERVISOR', 'USMS']] }],
  ['clerk', { orgs: [['DC']], roles: [['COURT_CLERK', 'DC']] }],
  ['judge', { orgs: [['DC', 'Judge']], roles: [['JUDGE', 'DC']] }],
  ['pro', { orgs: [['DA', 'Prosecutor']], roles: [['PROSECUTOR', 'DA']] }],
  ['low', { orgs: [['DC']], roles: [['COURT_CLERK', 'DC']], clearance: 'INTERNAL' }],
  ['registrar', { orgs: [['REG']], roles: [['REGISTRAR', 'REG']] }],
];

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test.before(async () => {
  t = await startApp();
  for (const [name, o] of users) U[name] = createUser(t.db, { username: name, ...o });
  for (const [name] of users) C[name] = await login(t, name);
  K.case = (await C.dep.post('/api/cases', { typeCode: 'USMS_INVESTIGATION', orgId: orgId(t.db, 'USMS'), title: 'Raid Grove Street (DEMO)' })).body.id;
});
test.after(() => t.close());

test('registering evidence starts the chain with the collector in custody', async () => {
  const res = await C.dep.post('/api/evidence', { caseId: K.case, description: 'Pistol, serial filed off (DEMO)', category: 'WEAPON', location: 'Grove Street 12, bedroom' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  K.ev = res.body.id;
  assert.match(res.body.evidenceNo, /^USMS-EV-\d{4}-0001$/);
  assert.equal(res.body.holder.id, U.dep);
  assert.equal(res.body.custody.length, 1);
  assert.equal(res.body.custody[0].kind, 'COLLECTED');
  assert.equal(res.body.integrity.ok, true);
  assert.equal((await C.pro.post('/api/evidence', { caseId: K.case, description: 'Knife (DEMO)', category: 'OTHER', location: 'Kitchen' })).status, 404, 'no case access');
});

test('visibility follows the case: office colleague yes, other institutions no', async () => {
  assert.equal((await C.dep2.get(`/api/evidence/${K.ev}`)).status, 200);
  assert.equal((await C.pro.get(`/api/evidence/${K.ev}`)).status, 404);
  assert.equal((await C.clerk.get(`/api/evidence/${K.ev}`)).status, 404);
});

test('only the holder can transfer; recipients must be authorized and cleared', async () => {
  assert.equal((await C.dep2.post(`/api/evidence/${K.ev}/transfer`, { toUserId: U.clerk, location: 'Court evidence room', reason: 'For trial' })).status, 403);
  assert.equal((await C.dep.post(`/api/evidence/${K.ev}/transfer`, { toUserId: U.registrar, location: 'x-x', reason: 'x-x' })).status, 400, 'no evidence permission → cannot hold evidence');
  assert.equal((await C.dep.post(`/api/evidence/${K.ev}/transfer`, { toUserId: U.low, location: 'x-x', reason: 'x-x' })).status, 200, 'INTERNAL case: clearance suffices');
  assert.equal((await C.dep.post(`/api/evidence/${K.ev}/cancel`, { reason: 'Wrong recipient' })).body.custody.at(-1).kind, 'TRANSFER_CANCELLED');
});

test('two-sided transfer: custody changes only after the recipient confirms', async () => {
  const init = await C.dep.post(`/api/evidence/${K.ev}/transfer`, { toUserId: U.clerk, location: 'Court evidence room, locker 4', reason: 'Required for trial' });
  assert.equal(init.status, 200);
  assert.equal(init.body.status, 'IN_TRANSFER');
  assert.equal(init.body.holder.id, U.dep, 'still with the deputy');
  const chainBefore = init.body.custody.length;

  // Empfänger sieht das Beweismittel (nicht die Akte) und kann bestätigen
  const seen = await C.clerk.get(`/api/evidence/${K.ev}`);
  assert.equal(seen.status, 200);
  assert.equal(seen.body.case, null);
  assert.ok(seen.body.capabilities.accept);
  assert.equal((await C.clerk.get(`/api/cases/${K.case}`)).status, 404);
  assert.ok((await C.clerk.get('/api/evidence?mine=1')).body.items.some((x) => x.id === K.ev && x.awaitingMyAcceptance));
  assert.equal((await C.dep2.post(`/api/evidence/${K.ev}/accept`)).status, 403, 'only the named recipient');

  const acc = await C.clerk.post(`/api/evidence/${K.ev}/accept`);
  assert.equal(acc.body.status, 'IN_CUSTODY');
  assert.equal(acc.body.holder.id, U.clerk);
  const last = acc.body.custody.at(-1);
  assert.equal(acc.body.custody.length, chainBefore + 1);
  assert.equal(last.kind, 'TRANSFER');
  assert.equal(last.from.id, U.dep);
  assert.equal(last.to.id, U.clerk);
  assert.equal(last.location, 'Court evidence room, locker 4');
  assert.equal(last.reason, 'Required for trial');
  assert.ok(last.initiatedAt && last.confirmedAt, 'both confirmations recorded');
  assert.equal(acc.body.integrity.ok, true);

  // Ehemaliger Gewahrsamsinhaber sieht die Kette weiter (über die Akte), darf aber nicht mehr übergeben
  const dep = await C.dep.get(`/api/evidence/${K.ev}`);
  assert.equal(dep.body.holder.id, U.clerk);
  assert.equal(dep.body.capabilities.transfer, false);
});

test('rejection keeps custody and is recorded', async () => {
  const tr = await C.clerk.post(`/api/evidence/${K.ev}/transfer`, { toUserId: U.judge, location: 'Chambers', reason: 'Inspection' });
  assert.equal(tr.status, 200, JSON.stringify(tr.body));
  const rej = await C.judge.post(`/api/evidence/${K.ev}/reject`, { reason: 'Not needed in chambers' });
  assert.equal(rej.status, 200);
  assert.deepEqual(rej.body, { declined: true }, 'recipient without case access gets no details after rejecting');
  const after = (await C.clerk.get(`/api/evidence/${K.ev}`)).body;
  assert.equal(after.holder.id, U.clerk);
  assert.equal(after.custody.at(-1).kind, 'TRANSFER_REJECTED');
  assert.equal((await C.judge.get(`/api/evidence/${K.ev}`)).status, 404, 'no longer pending → no longer visible');
});

test('location changes by the holder are part of the chain', async () => {
  const m = await C.clerk.post(`/api/evidence/${K.ev}/move`, { location: 'Court evidence room, safe 1', reason: 'Firearms must be stored in the safe' });
  assert.equal(m.body.location, 'Court evidence room, safe 1');
  assert.equal(m.body.custody.at(-1).kind, 'LOCATION_CHANGE');
  assert.equal((await C.dep.post(`/api/evidence/${K.ev}/move`, { location: 'x-x', reason: 'x-x' })).status, 403);
});

test('photos: attached by the holder, visible only to those who see the item', async () => {
  const up = await fetch(`${t.baseUrl}/api/files`, { method: 'POST', body: PNG, headers: { 'content-type': 'image/png', 'x-filename': 'pistol.png',
    'x-csrf-token': C.clerk.csrf, cookie: [...C.clerk.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(up.status, 201, 'court clerks may upload');
  const up2 = await fetch(`${t.baseUrl}/api/files`, { method: 'POST', body: PNG, headers: { 'content-type': 'image/png', 'x-filename': 'pistol.png',
    'x-csrf-token': C.dep.csrf, cookie: [...C.dep.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
  const file = await up2.json();
  const ev2 = (await C.dep.post('/api/evidence', { caseId: K.case, description: 'Cash bundle (DEMO)', category: 'CASH', location: 'Kitchen' })).body.id;
  const att = await C.dep.post(`/api/evidence/${ev2}/files`, { fileId: file.id, caption: 'As found' });
  assert.equal(att.status, 201);
  assert.equal((await C.dep2.get(`/api/files/${file.id}`)).status, 200, 'colleague sees the item and the photo');
  assert.equal((await C.pro.get(`/api/files/${file.id}`)).status, 404);
  assert.equal((await C.dep.post('/api/documents', { typeCode: 'ATTACHMENT', caseId: K.case, title: 'Reuse', fileId: file.id })).status, 400, 'file already used');
  K.ev2 = ev2;
});

test('release and disposal are final and need EVIDENCE_DISPOSE', async () => {
  assert.equal((await C.dep.post(`/api/evidence/${K.ev2}/dispose`, { reason: 'x-x-x' })).status, 403, 'deputy lacks EVIDENCE_DISPOSE');
  await C.dep.post(`/api/evidence/${K.ev2}/transfer`, { toUserId: U.sup, location: 'USMS evidence room', reason: 'Supervisor review' });
  await C.sup.post(`/api/evidence/${K.ev2}/accept`);
  const rel = await C.sup.post(`/api/evidence/${K.ev2}/release`, { reason: 'Returned to lawful owner (DEMO)' });
  assert.equal(rel.body.status, 'RELEASED');
  assert.equal(rel.body.custody.at(-1).kind, 'RELEASED');
  const again = await C.sup.post(`/api/evidence/${K.ev2}/transfer`, { toUserId: U.dep, location: 'x-x', reason: 'x-x' });
  assert.equal(again.status, 409);
});

test('the case timeline records registration and transfers', async () => {
  const types = (await C.dep.get(`/api/cases/${K.case}/timeline`)).body.map((e) => e.type);
  assert.ok(types.includes('EVIDENCE_REGISTERED') && types.includes('EVIDENCE_TRANSFERRED') && types.includes('EVIDENCE_RELEASED'));
});

test('the chain cannot be changed silently; direct tampering is detected', async () => {
  assert.throws(() => t.db.prepare("UPDATE evidence_custody SET reason = 'x'").run(), /append-only/);
  assert.throws(() => t.db.prepare('DELETE FROM evidence_custody').run(), /append-only/);
  t.db.exec('DROP TRIGGER evidence_custody_no_update');
  t.db.prepare("UPDATE evidence_custody SET location = 'Somewhere else' WHERE evidence_id = ? AND kind = 'TRANSFER'").run(K.ev);
  const res = await C.dep.get(`/api/evidence/${K.ev}`);
  assert.equal(res.body.integrity.ok, false);
});

test('audit chain intact', () => assert.equal(t.ctx.audit.verify().ok, true));
