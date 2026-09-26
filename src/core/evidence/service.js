// @ts-check
'use strict';
/**
 * Beweismittel und Chain of Custody (prompt.txt 6.4, WORKFLOWS.md Abschnitt 11).
 *
 * Chain of Custody:
 *   - Jeder Eintrag hält FROM, TO, Zeitpunkt, Ort, Grund und die Bestätigungen beider Seiten fest.
 *   - Übergaben sind zweiseitig: Die abgebende Person leitet ein (1. Bestätigung), die empfangende Person bestätigt
 *     den Empfang (2. Bestätigung). Erst dann entsteht der Eintrag und der Gewahrsam wechselt.
 *     Ablehnung und Rückzug werden ebenfalls als Tatsache festgehalten.
 *   - Die Kette ist append-only (Trigger) und je Beweismittel hash-verkettet: stille Änderungen sind unmöglich,
 *     Manipulationen direkt in der Datei werden von verify() erkannt.
 *
 * Sichtbarkeit: über die Akte (gleiches Prädikat, inkl. Level/Compartments/Sealing) – oder als aktuelle bzw.
 * vorgesehene Gewahrsamsperson (z. B. Asservatenkammer des Gerichts), die das Beweismittel, aber nicht die Akte sieht.
 */
const crypto = require('crypto');
const { z } = require('zod');
const { transaction, now } = require('../../db');
const { forbidden, notFound, badRequest, conflict } = require('../../http/errors');
const { caseVisibility, canViewCase } = require('../cases/visibility');
const { createCaseService } = require('../cases/service');
const { loadPrincipal } = require('../authz/principal');
const { canonical } = require('../documents/render');
const { nextNumber } = require('../numbers');
const { orgRef } = require('../users/me');

const GENESIS = '0'.repeat(64);
const CATEGORIES = ['WEAPON', 'DRUGS', 'CASH', 'DOCUMENT', 'ELECTRONIC', 'VEHICLE', 'CLOTHING', 'BIOLOGICAL', 'PHOTO_VIDEO', 'OTHER'];

const text = (min, max) => z.string().trim().min(min).max(max);
const schemas = {
  create: z.object({
    caseId: z.number().int().positive(),
    description: text(3, 2000),
    category: z.enum(/** @type {[string, ...string[]]} */ (CATEGORIES)),
    collectedAt: z.string().datetime({ offset: true }).optional(),
    location: text(2, 300),
  }),
  transfer: z.object({ toUserId: z.number().int().positive(), location: text(2, 300), reason: text(3, 1000) }),
  reason: z.object({ reason: text(3, 1000) }),
  location: z.object({ location: text(2, 300), reason: text(3, 1000) }),
  file: z.object({ fileId: z.number().int().positive(), caption: z.string().trim().max(300).default('') }),
  list: z.object({
    caseId: z.coerce.number().int().positive().optional(),
    mine: z.enum(['0', '1']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }),
};

const FIELDS = ['evidence_id', 'seq', 'kind', 'from_user_id', 'from_name', 'to_user_id', 'to_name', 'location', 'reason', 'initiated_at', 'confirmed_at', 'recorded_by'];
const entryHash = (prev, e) => crypto.createHash('sha256').update(prev + canonical(Object.fromEntries(FIELDS.map((f) => [f, e[f] ?? null])))).digest('hex');

/** @param {import('../../app').AppContext} ctx */
function createEvidenceService(ctx) {
  const { db, audit } = ctx;
  const cases = createCaseService(ctx);

  const caseComps = (caseId) => db.prepare('SELECT compartment_code c FROM case_compartments WHERE case_id = ?').all(caseId).map((r) => String(r.c));
  const res = (e) => {
    const c = /** @type {any} */ (db.prepare('SELECT owning_org_id FROM cases WHERE id = ?').get(e.case_id));
    return { resourceType: 'evidence', resourceId: e.id, resourceOrgId: c.owning_org_id, resourceLevel: e.security_level, resourceCompartments: caseComps(e.case_id) };
  };
  const nameOf = (uid) => (uid ? String(/** @type {any} */ (db.prepare('SELECT display_name FROM users WHERE id = ?').get(uid))?.display_name ?? '') : '');
  const pendingOf = (id) => /** @type {any} */ (db.prepare("SELECT * FROM evidence_transfers WHERE evidence_id = ? AND status = 'PENDING'").get(id)) ?? null;
  const caseEvent = (caseId, type, actorId, summary, payload = {}) => {
    db.prepare('INSERT INTO case_events (case_id, type, actor_user_id, summary, payload, created_at) VALUES (?,?,?,?,?,?)')
      .run(caseId, type, actorId, summary, JSON.stringify(payload), now());
    db.prepare('UPDATE cases SET updated_at = ? WHERE id = ?').run(now(), caseId);
  };

  /** Eintrag an die Kette anhängen (in der Transaktion des Aufrufers). */
  function append(evidenceId, e) {
    const last = /** @type {any} */ (db.prepare('SELECT seq, entry_hash FROM evidence_custody WHERE evidence_id = ? ORDER BY seq DESC LIMIT 1').get(evidenceId));
    const row = { evidence_id: evidenceId, seq: (last?.seq ?? 0) + 1, from_name: nameOf(e.from_user_id), to_name: nameOf(e.to_user_id), ...e };
    const prev = last?.entry_hash ?? GENESIS;
    const hash = entryHash(prev, row);
    db.prepare(`INSERT INTO evidence_custody (evidence_id, seq, kind, from_user_id, from_name, to_user_id, to_name, location, reason, initiated_at, confirmed_at, recorded_by, prev_hash, entry_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.evidence_id, row.seq, row.kind, row.from_user_id ?? null, row.from_name, row.to_user_id ?? null, row.to_name,
      row.location, row.reason, row.initiated_at, row.confirmed_at ?? null, row.recorded_by, prev, hash);
  }

  /** Kette eines Beweismittels prüfen. */
  function verify(evidenceId) {
    let prev = GENESIS;
    let seq = 0;
    for (const r of db.prepare('SELECT * FROM evidence_custody WHERE evidence_id = ? ORDER BY seq').all(evidenceId)) {
      const row = /** @type {any} */ (r);
      seq++;
      if (row.seq !== seq || row.prev_hash !== prev || entryHash(prev, row) !== row.entry_hash) return { ok: false, brokenAtSeq: row.seq };
      prev = row.entry_hash;
    }
    return { ok: true, entries: seq };
  }

  function visibility(p, alias = 'e') {
    const v = caseVisibility(db, p, { alias: 'evc' });
    return {
      sql: `((SELECT rank FROM security_levels WHERE code = ${alias}.security_level) <= ? AND (
        EXISTS (SELECT 1 FROM cases evc WHERE evc.id = ${alias}.case_id AND ${v.sql})
        OR ${alias}.current_holder_user_id = ?
        OR EXISTS (SELECT 1 FROM evidence_transfers et WHERE et.evidence_id = ${alias}.id AND et.status = 'PENDING' AND et.to_user_id = ?)))`,
      params: [p.clearanceRank, ...v.params, p.user.id, p.user.id],
    };
  }

  function loadVisible(p, reqCtx, id) {
    const v = visibility(p);
    const e = /** @type {any} */ (db.prepare(`SELECT e.* FROM evidence e WHERE e.id = ? AND ${v.sql}`).get(id, ...v.params));
    if (e) return e;
    const hidden = /** @type {any} */ (db.prepare('SELECT * FROM evidence WHERE id = ?').get(id));
    if (hidden && reqCtx) audit.write({ ...reqCtx, action: 'EVIDENCE_ACCESS', outcome: 'DENIED', ...res(hidden) });
    throw notFound();
  }

  function capabilities(p, e) {
    const pending = pendingOf(e.id);
    const holder = e.current_holder_user_id === p.user.id;
    const active = ['IN_CUSTODY', 'IN_TRANSFER'].includes(e.status);
    const c = /** @type {any} */ (db.prepare('SELECT * FROM cases WHERE id = ?').get(e.case_id));
    const caseVisible = canViewCase(db, p, e.case_id);
    return {
      transfer: holder && e.status === 'IN_CUSTODY' && p.hasAnywhere('EVIDENCE_TRANSFER'),
      accept: Boolean(pending) && pending.to_user_id === p.user.id,
      reject: Boolean(pending) && pending.to_user_id === p.user.id,
      cancel: Boolean(pending) && pending.from_user_id === p.user.id,
      move: holder && e.status === 'IN_CUSTODY',
      dispose: holder && e.status === 'IN_CUSTODY' && p.has('EVIDENCE_DISPOSE', c.owning_org_id),
      addFile: active && (holder || (caseVisible && cases.capabilities(p, c).addDocument)) && p.hasAnywhere('EVIDENCE_CREATE'),
    };
  }

  function detail(p, e) {
    const caseVisible = canViewCase(db, p, e.case_id);
    const c = /** @type {any} */ (db.prepare('SELECT id, case_number, owning_org_id FROM cases WHERE id = ?').get(e.case_id));
    const pending = pendingOf(e.id);
    return {
      id: e.id, evidenceNo: e.evidence_no, description: e.description, category: e.category, status: e.status,
      securityLevel: e.security_level, isDemo: Boolean(e.is_demo),
      collectedAt: e.collected_at, collectedBy: nameOf(e.collected_by), collectedLocation: e.collected_location,
      holder: { id: e.current_holder_user_id, name: nameOf(e.current_holder_user_id) }, location: e.current_location,
      owningOrg: orgRef(p.orgs, c.owning_org_id),
      case: caseVisible ? { id: c.id, caseNumber: c.case_number } : null,
      pendingTransfer: pending ? { id: pending.id, from: { id: pending.from_user_id, name: nameOf(pending.from_user_id) },
        to: { id: pending.to_user_id, name: nameOf(pending.to_user_id) }, location: pending.location, reason: pending.reason, createdAt: pending.created_at } : null,
      custody: db.prepare('SELECT * FROM evidence_custody WHERE evidence_id = ? ORDER BY seq').all(e.id).map((r) => ({
        seq: r.seq, kind: r.kind, from: r.from_user_id ? { id: r.from_user_id, name: r.from_name } : null, to: r.to_user_id ? { id: r.to_user_id, name: r.to_name } : null,
        location: r.location, reason: r.reason, initiatedAt: r.initiated_at, confirmedAt: r.confirmed_at, hash: r.entry_hash,
      })),
      integrity: verify(e.id),
      files: db.prepare(`SELECT f.id, f.original_name, f.mime, f.size, ef.caption, ef.added_at FROM evidence_files ef JOIN files f ON f.id = ef.file_id
        WHERE ef.evidence_id = ? ORDER BY ef.added_at`).all(e.id).map((f) => ({ id: f.id, name: f.original_name, mime: f.mime, size: f.size, caption: f.caption, addedAt: f.added_at })),
      capabilities: capabilities(p, e),
    };
  }

  function requireCap(p, reqCtx, cap, e) {
    if (capabilities(p, e)[cap]) return;
    audit.write({ ...reqCtx, action: `EVIDENCE_${cap.toUpperCase()}`, outcome: 'DENIED', ...res(e) });
    if (['RELEASED', 'DISPOSED'].includes(e.status)) throw conflict('This item has been released or disposed of.', 'EVIDENCE_CLOSED');
    throw forbidden();
  }

  return {
    schemas,
    CATEGORIES,
    visibility,
    verify,

    create(p, reqCtx, input) {
      const d = schemas.create.parse(input);
      const c = cases.loadVisible(p, reqCtx, d.caseId);
      if (!cases.capabilities(p, c).addDocument || !p.has('EVIDENCE_CREATE', c.owning_org_id)) throw forbidden();
      const org = p.orgs.byId.get(c.owning_org_id);
      const id = transaction(db, () => {
        const ts = now();
        const collected = d.collectedAt ? new Date(d.collectedAt).toISOString() : ts;
        if (Date.parse(collected) > Date.now() + 60_000) throw badRequest('The collection time cannot be in the future.', [{ field: 'collectedAt', message: 'Must not be in the future.' }]);
        const number = nextNumber(db, `${org.code}-EV`);
        const { lastInsertRowid } = db.prepare(`INSERT INTO evidence (evidence_no, case_id, description, category, collected_at, collected_by, collected_location,
          current_holder_user_id, current_location, security_level, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(number, c.id, d.description, d.category, collected, p.user.id, d.location, p.user.id, d.location, c.security_level, ts, ts);
        const evId = Number(lastInsertRowid);
        append(evId, { kind: 'COLLECTED', from_user_id: null, to_user_id: p.user.id, location: d.location, reason: 'Collected and registered',
          initiated_at: collected, confirmed_at: ts, recorded_by: p.user.id });
        caseEvent(c.id, 'EVIDENCE_REGISTERED', p.user.id, `Evidence ${number} registered`, { evidenceId: evId });
        audit.write({ ...reqCtx, action: 'EVIDENCE_CREATE', resourceType: 'evidence', resourceId: evId, resourceOrgId: c.owning_org_id,
          resourceLevel: c.security_level, resourceCompartments: caseComps(c.id), details: { evidenceNo: number, category: d.category } });
        return evId;
      });
      return detail(p, db.prepare('SELECT * FROM evidence WHERE id = ?').get(id));
    },

    list(p, query) {
      const f = schemas.list.parse(query);
      const v = visibility(p);
      const where = [v.sql];
      const params = [...v.params];
      if (f.caseId) { where.push('e.case_id = ?'); params.push(f.caseId); }
      if (f.mine === '1') {
        where.push("(e.current_holder_user_id = ? OR EXISTS (SELECT 1 FROM evidence_transfers mt WHERE mt.evidence_id = e.id AND mt.status = 'PENDING' AND mt.to_user_id = ?))");
        params.push(p.user.id, p.user.id);
      }
      const w = where.join(' AND ');
      const total = Number(/** @type {any} */ (db.prepare(`SELECT COUNT(*) n FROM evidence e WHERE ${w}`).get(...params)).n);
      const rows = db.prepare(`SELECT e.* FROM evidence e WHERE ${w} ORDER BY e.updated_at DESC, e.id DESC LIMIT ? OFFSET ?`).all(...params, f.limit, f.offset);
      return {
        total,
        items: rows.map((e) => {
          const pending = pendingOf(e.id);
          return { id: e.id, evidenceNo: e.evidence_no, description: e.description, category: e.category, status: e.status,
            holder: nameOf(e.current_holder_user_id), location: e.current_location, updatedAt: e.updated_at,
            awaitingMyAcceptance: Boolean(pending && pending.to_user_id === p.user.id) };
        }),
      };
    },

    get(p, reqCtx, id) {
      const e = loadVisible(p, reqCtx, id);
      audit.write({ ...reqCtx, action: 'EVIDENCE_VIEW', ...res(e) });
      return detail(p, e);
    },

    /** Übergabe einleiten (1. Bestätigung durch die abgebende Person). */
    transfer(p, reqCtx, id, input) {
      const d = schemas.transfer.parse(input);
      const e = loadVisible(p, reqCtx, id);
      requireCap(p, reqCtx, 'transfer', e);
      if (d.toUserId === p.user.id) throw badRequest('You already hold this item.');
      const to = /** @type {any} */ (db.prepare("SELECT * FROM users WHERE id = ? AND status = 'ACTIVE'").get(d.toUserId));
      const tp = to ? loadPrincipal(db, to, { orgs: p.orgs }) : null;
      if (!tp || !tp.hasAnywhere('EVIDENCE_VIEW') || !tp.clearedFor(e.security_level)) {
        throw badRequest('This person cannot take custody of evidence at this security level.', [{ field: 'toUserId', message: 'Choose an authorized recipient.' }]);
      }
      transaction(db, () => {
        const ts = now();
        db.prepare('INSERT INTO evidence_transfers (evidence_id, from_user_id, to_user_id, location, reason, created_at) VALUES (?,?,?,?,?,?)')
          .run(id, p.user.id, d.toUserId, d.location, d.reason, ts);
        db.prepare("UPDATE evidence SET status = 'IN_TRANSFER', updated_at = ? WHERE id = ?").run(ts, id);
        audit.write({ ...reqCtx, action: 'EVIDENCE_TRANSFER_INITIATE', ...res(e), details: { toUserId: d.toUserId, location: d.location, reason: d.reason } });
        ctx.notify?.toUsers([d.toUserId], { type: 'EVIDENCE_TRANSFER_REQUESTED', title: `Please confirm receipt of evidence ${e.evidence_no}`,
          body: `From ${p.user.display_name} · ${d.location}`, link: `/app/evidence/${id}`, subjectType: 'evidence', subjectId: id, level: e.security_level, compartments: res(e).resourceCompartments });
      });
      return detail(p, loadVisible(p, reqCtx, id));
    },

    /** Empfang bestätigen (2. Bestätigung) – erst jetzt entsteht der Kettenglied und der Gewahrsam wechselt. */
    accept(p, reqCtx, id) {
      const e = loadVisible(p, reqCtx, id);
      requireCap(p, reqCtx, 'accept', e);
      const t = pendingOf(id);
      transaction(db, () => {
        const ts = now();
        db.prepare("UPDATE evidence_transfers SET status = 'ACCEPTED', decided_at = ? WHERE id = ?").run(ts, t.id);
        append(id, { kind: 'TRANSFER', from_user_id: t.from_user_id, to_user_id: t.to_user_id, location: t.location, reason: t.reason,
          initiated_at: t.created_at, confirmed_at: ts, recorded_by: p.user.id });
        db.prepare("UPDATE evidence SET status = 'IN_CUSTODY', current_holder_user_id = ?, current_location = ?, updated_at = ? WHERE id = ?").run(t.to_user_id, t.location, ts, id);
        caseEvent(e.case_id, 'EVIDENCE_TRANSFERRED', p.user.id, `Evidence ${e.evidence_no}: custody transferred from ${nameOf(t.from_user_id)} to ${nameOf(t.to_user_id)}`, { evidenceId: id });
        audit.write({ ...reqCtx, action: 'EVIDENCE_TRANSFER', ...res(e), details: { from: t.from_user_id, to: t.to_user_id, location: t.location } });
        ctx.notify?.toUsers([t.from_user_id], { type: 'EVIDENCE_TRANSFER_CONFIRMED', title: `Receipt confirmed: ${e.evidence_no}`, body: `by ${p.user.display_name}`,
          link: `/app/evidence/${id}`, subjectType: 'evidence', subjectId: id, level: e.security_level, compartments: res(e).resourceCompartments });
      });
      return detail(p, loadVisible(p, reqCtx, id));
    },

    /** Ablehnen (Empfänger) oder zurückziehen (Abgebender) – der Gewahrsam bleibt, die Tatsache wird festgehalten. */
    decline(p, reqCtx, id, kind, input) {
      const { reason } = schemas.reason.parse(input);
      const e = loadVisible(p, reqCtx, id);
      requireCap(p, reqCtx, kind === 'reject' ? 'reject' : 'cancel', e);
      const t = pendingOf(id);
      transaction(db, () => {
        const ts = now();
        db.prepare('UPDATE evidence_transfers SET status = ?, decided_at = ? WHERE id = ?').run(kind === 'reject' ? 'REJECTED' : 'CANCELLED', ts, t.id);
        append(id, { kind: kind === 'reject' ? 'TRANSFER_REJECTED' : 'TRANSFER_CANCELLED', from_user_id: t.from_user_id, to_user_id: t.to_user_id,
          location: e.current_location, reason, initiated_at: t.created_at, confirmed_at: ts, recorded_by: p.user.id });
        db.prepare("UPDATE evidence SET status = 'IN_CUSTODY', updated_at = ? WHERE id = ?").run(ts, id);
        audit.write({ ...reqCtx, action: kind === 'reject' ? 'EVIDENCE_TRANSFER_REJECT' : 'EVIDENCE_TRANSFER_CANCEL', ...res(e), details: { reason } });
        if (kind === 'reject') {
          ctx.notify?.toUsers([t.from_user_id], { type: 'EVIDENCE_TRANSFER_REJECTED', title: `Handover rejected: ${e.evidence_no}`, body: reason,
            link: `/app/evidence/${id}`, subjectType: 'evidence', subjectId: id, level: e.security_level, compartments: res(e).resourceCompartments });
        }
      });
      // Wer ablehnt und die Akte nicht sieht, verliert mit der Ablehnung die Sicht auf das Beweismittel
      try { return detail(p, loadVisible(p, null, id)); } catch { return { declined: true }; }
    },

    /** Lagerort ändern (nur Gewahrsamsperson). */
    move(p, reqCtx, id, input) {
      const d = schemas.location.parse(input);
      const e = loadVisible(p, reqCtx, id);
      requireCap(p, reqCtx, 'move', e);
      transaction(db, () => {
        const ts = now();
        append(id, { kind: 'LOCATION_CHANGE', from_user_id: p.user.id, to_user_id: p.user.id, location: d.location, reason: d.reason,
          initiated_at: ts, confirmed_at: ts, recorded_by: p.user.id });
        db.prepare('UPDATE evidence SET current_location = ?, updated_at = ? WHERE id = ?').run(d.location, ts, id);
        audit.write({ ...reqCtx, action: 'EVIDENCE_LOCATION_CHANGE', ...res(e), details: { from: e.current_location, to: d.location, reason: d.reason } });
      });
      return detail(p, loadVisible(p, reqCtx, id));
    },

    /** Herausgabe oder Vernichtung – endgültig, mit Begründung. */
    close(p, reqCtx, id, kind, input) {
      const { reason } = schemas.reason.parse(input);
      const e = loadVisible(p, reqCtx, id);
      requireCap(p, reqCtx, 'dispose', e);
      const status = kind === 'release' ? 'RELEASED' : 'DISPOSED';
      transaction(db, () => {
        const ts = now();
        append(id, { kind: status, from_user_id: p.user.id, to_user_id: null, location: e.current_location, reason, initiated_at: ts, confirmed_at: ts, recorded_by: p.user.id });
        db.prepare('UPDATE evidence SET status = ?, updated_at = ? WHERE id = ?').run(status, ts, id);
        caseEvent(e.case_id, `EVIDENCE_${status}`, p.user.id, `Evidence ${e.evidence_no} ${status.toLowerCase()}`, { evidenceId: id, reason });
        audit.write({ ...reqCtx, action: `EVIDENCE_${status}`, ...res(e), details: { reason } });
      });
      return detail(p, loadVisible(p, reqCtx, id));
    },

    addFile(p, reqCtx, id, input) {
      const d = schemas.file.parse(input);
      const e = loadVisible(p, reqCtx, id);
      requireCap(p, reqCtx, 'addFile', e);
      const f = db.prepare(`SELECT 1 FROM files f WHERE f.id = ? AND f.uploaded_by = ?
        AND NOT EXISTS (SELECT 1 FROM document_versions v WHERE v.file_id = f.id) AND NOT EXISTS (SELECT 1 FROM evidence_files ef WHERE ef.file_id = f.id)`).get(d.fileId, p.user.id);
      if (!f) throw badRequest('The uploaded file was not found or is already in use.');
      transaction(db, () => {
        db.prepare('INSERT INTO evidence_files (evidence_id, file_id, caption, added_by, added_at) VALUES (?,?,?,?,?)').run(id, d.fileId, d.caption, p.user.id, now());
        db.prepare('UPDATE evidence SET updated_at = ? WHERE id = ?').run(now(), id);
        audit.write({ ...reqCtx, action: 'EVIDENCE_FILE_ADD', ...res(e), details: { fileId: d.fileId } });
      });
      return detail(p, loadVisible(p, reqCtx, id));
    },

    /** Dateizugriff für Beweismittelfotos: wer das Beweismittel sieht, darf die Datei laden. */
    fileAccess(p, reqCtx, fileId) {
      const v = visibility(p);
      const e = /** @type {any} */ (db.prepare(`SELECT e.* FROM evidence e JOIN evidence_files ef ON ef.evidence_id = e.id WHERE ef.file_id = ? AND ${v.sql}`)
        .get(fileId, ...v.params));
      if (!e) return false;
      audit.write({ ...reqCtx, action: 'EVIDENCE_FILE_DOWNLOAD', ...res(e), details: { fileId } });
      return true;
    },
  };
}

module.exports = { createEvidenceService, CATEGORIES };
