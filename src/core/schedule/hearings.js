// @ts-check
'use strict';
/**
 * Anhörungen / Sitzungstermine (prompt.txt 6.6).
 *
 * - Termine gehören zu einer Gerichtsakte (Gericht oder US-SJA) und erben deren Sicherheitsstufe.
 * - Sichtbar über die Akte – oder als eingeladener Beteiligter (z. B. Staatsanwalt, Zeuge): dieser sieht den Termin,
 *   aber nicht die Gerichtsakte.
 * - Konfliktprüfung (Raum, beteiligte Personen) verrät keine Termine, die der Planende nicht sehen darf.
 * - Das Protokoll ist ein Dokument (Vorlage „Sitzungsprotokoll“) in der Gerichtsakte.
 */
const { z } = require('zod');
const { transaction, now, inList } = require('../../db');
const { forbidden, notFound, badRequest, conflict, HttpError } = require('../../http/errors');
const { caseVisibility, canViewCase } = require('../cases/visibility');
const { createCaseService } = require('../cases/service');
const { createDocumentService } = require('../documents/service');
const { loadPrincipal } = require('../authz/principal');
const { nextNumber } = require('../numbers');
const { orgRef } = require('../users/me');

const KINDS = ['HEARING', 'TRIAL_SESSION', 'STATUS_CONFERENCE', 'OTHER'];
const ROLES = ['JUDGE', 'PROSECUTOR', 'COUNSEL', 'DEFENDANT', 'PLAINTIFF', 'WITNESS', 'CLERK', 'SECURITY', 'OBSERVER'];
const iso = z.string().datetime({ offset: true });
const reason = z.string().trim().min(3).max(1000);
const participant = z.object({
  userId: z.number().int().positive().optional(),
  partyName: z.string().trim().min(2).max(200).optional(),
  role: z.enum(/** @type {[string, ...string[]]} */ (ROLES)),
  isPresiding: z.boolean().default(false),
}).refine((d) => Boolean(d.userId) !== Boolean(d.partyName), { message: 'Specify either a user or a party name.' });

const schemas = {
  create: z.object({
    caseId: z.number().int().positive(),
    title: z.string().trim().min(3).max(200),
    kind: z.enum(/** @type {[string, ...string[]]} */ (KINDS)).default('HEARING'),
    room: z.string().trim().min(1).max(120),
    startsAt: iso,
    endsAt: iso,
    notes: z.string().trim().max(5000).default(''),
    participants: z.array(participant).max(50).default([]),
  }),
  update: z.object({ title: z.string().trim().min(3).max(200).optional(), notes: z.string().trim().max(5000).optional() }),
  reschedule: z.object({ startsAt: iso, endsAt: iso, room: z.string().trim().min(1).max(120).optional(), reason }),
  reason: z.object({ reason }),
  participant,
  list: z.object({
    from: iso.optional(), to: iso.optional(), caseId: z.coerce.number().int().positive().optional(),
    mine: z.enum(['0', '1']).optional(), status: z.enum(['SCHEDULED', 'HELD', 'POSTPONED', 'CANCELLED']).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  }),
  protocol: z.object({ fields: z.record(z.string().max(60), z.string().max(20_000)) }),
};

/** @param {import('../../app').AppContext} ctx */
function createHearingService(ctx) {
  const { db, audit } = ctx;
  const cases = createCaseService(ctx);
  const docs = createDocumentService(ctx);

  const caseRow = (id) => /** @type {any} */ (db.prepare('SELECT * FROM cases WHERE id = ?').get(id));
  const comps = (caseId) => db.prepare('SELECT compartment_code c FROM case_compartments WHERE case_id = ?').all(caseId).map((r) => String(r.c));
  const res = (hr) => ({ resourceType: 'hearing', resourceId: hr.id, resourceOrgId: hr.court_org_id, resourceLevel: hr.security_level, resourceCompartments: comps(hr.case_id) });
  const event = (caseId, type, actorId, summary, payload = {}) => {
    db.prepare('INSERT INTO case_events (case_id, type, actor_user_id, summary, payload, created_at) VALUES (?,?,?,?,?,?)')
      .run(caseId, type, actorId, summary, JSON.stringify(payload), now());
    db.prepare('UPDATE cases SET updated_at = ? WHERE id = ?').run(now(), caseId);
  };
  const participantsOf = (id) => db.prepare(`SELECT hp.*, u.display_name AS user_name FROM hearing_participants hp LEFT JOIN users u ON u.id = hp.user_id
    WHERE hp.hearing_id = ? AND hp.removed_at IS NULL ORDER BY hp.is_presiding DESC, hp.id`).all(id);
  const isCourt = (p, orgId) => ['COURT', 'AUTHORITY'].includes(String(p.orgs.byId.get(orgId)?.kind)) && p.orgs.ancestorsOf(orgId).includes(p.orgs.byCode.get('JUDICIARY')?.id);

  function visibility(p, alias = 'hr') {
    const v = caseVisibility(db, p, { alias: 'hc' });
    return {
      sql: `((SELECT rank FROM security_levels WHERE code = ${alias}.security_level) <= ? AND (
        EXISTS (SELECT 1 FROM cases hc WHERE hc.id = ${alias}.case_id AND ${v.sql})
        OR EXISTS (SELECT 1 FROM hearing_participants hpv WHERE hpv.hearing_id = ${alias}.id AND hpv.user_id = ? AND hpv.removed_at IS NULL)))`,
      params: [p.clearanceRank, ...v.params, p.user.id],
    };
  }

  function loadVisible(p, reqCtx, id) {
    const v = visibility(p);
    const hr = /** @type {any} */ (db.prepare(`SELECT hr.* FROM hearings hr WHERE hr.id = ? AND ${v.sql}`).get(id, ...v.params));
    if (hr) return hr;
    const hidden = /** @type {any} */ (db.prepare('SELECT * FROM hearings WHERE id = ?').get(id));
    if (hidden && reqCtx) audit.write({ ...reqCtx, action: 'HEARING_ACCESS', outcome: 'DENIED', ...res(hidden) });
    throw notFound();
  }

  /** Planende Stelle: sieht die Akte und arbeitet an ihr (Beteiligung) oder verwaltet das Gericht (CASE_ASSIGN). */
  function planner(p, c) {
    if (!canViewCase(db, p, c.id)) return false;
    return cases.capabilities(p, c).addDocument || p.has('CASE_ASSIGN', c.owning_org_id);
  }

  function capabilities(p, hr) {
    const c = caseRow(hr.case_id);
    const plan = planner(p, c);
    const org = hr.court_org_id;
    const open = ['SCHEDULED', 'POSTPONED'].includes(hr.status);
    return {
      edit: plan && open && p.has('HEARING_EDIT', org),
      reschedule: plan && open && p.has('HEARING_SCHEDULE', org),
      postpone: plan && hr.status === 'SCHEDULED' && p.has('HEARING_EDIT', org),
      cancel: plan && open && p.has('HEARING_CANCEL', org),
      held: plan && hr.status === 'SCHEDULED' && Date.parse(hr.starts_at) <= Date.now() && p.has('HEARING_EDIT', org),
      participants: plan && open && p.has('HEARING_EDIT', org),
      protocol: plan && !hr.protocol_document_id && ['SCHEDULED', 'HELD'].includes(hr.status) && Date.parse(hr.starts_at) <= Date.now()
        && (p.has('HEARING_PROTOCOL', org) || p.has('DECISION_CREATE', org)) && cases.capabilities(p, c).addDocument,
    };
  }
  function requireCap(p, reqCtx, cap, hr) {
    if (capabilities(p, hr)[cap]) return;
    audit.write({ ...reqCtx, action: `HEARING_${cap.toUpperCase()}`, outcome: 'DENIED', ...res(hr) });
    if (['CANCELLED', 'HELD'].includes(hr.status) && cap !== 'protocol') throw conflict('This hearing can no longer be changed.', 'HEARING_CLOSED');
    throw forbidden();
  }

  /**
   * Überschneidungen: gleicher Raum am gleichen Gericht oder gleiche beteiligte Person.
   * Termine, die p nicht sehen darf, werden nur anonym gemeldet. room = null: Raum nicht prüfen.
   * @param {any} p @param {{ courtOrgId: number, room: string|null, startsAt: string, endsAt: string, userIds: number[], excludeId: number|null }} o
   */
  function conflicts(p, { courtOrgId, room, startsAt, endsAt, userIds, excludeId }) {
    const found = [];
    const overlap = `hr.status = 'SCHEDULED' AND hr.starts_at < ? AND hr.ends_at > ? AND hr.id <> ?`;
    if (room != null) {
      const byRoom = db.prepare(`SELECT hr.* FROM hearings hr WHERE hr.court_org_id = ? AND lower(trim(hr.room)) = lower(trim(?)) AND ${overlap}`)
        .all(courtOrgId, room, endsAt, startsAt, excludeId ?? 0);
      for (const r of byRoom) found.push({ reason: 'ROOM', hearing: r });
    }
    if (userIds.length) {
      const byPerson = db.prepare(`SELECT DISTINCT hr.*, hp.user_id AS busy_user FROM hearings hr JOIN hearing_participants hp ON hp.hearing_id = hr.id AND hp.removed_at IS NULL
        WHERE hp.user_id IN (${inList(userIds)}) AND ${overlap}`).all(...userIds, endsAt, startsAt, excludeId ?? 0);
      for (const r of byPerson) found.push({ reason: 'PERSON', hearing: r, userId: Number(r.busy_user) });
    }
    if (!found.length) return;
    const v = visibility(p);
    const visible = new Set(db.prepare(`SELECT hr.id FROM hearings hr WHERE hr.id IN (${inList(found.map((f) => f.hearing.id))}) AND ${v.sql}`)
      .all(...found.map((f) => f.hearing.id), ...v.params).map((r) => Number(r.id)));
    const details = found.map((f) => {
      const who = f.userId ? String(/** @type {any} */ (db.prepare('SELECT display_name FROM users WHERE id = ?').get(f.userId))?.display_name) : null;
      const what = f.reason === 'ROOM' ? `Room "${room}"` : `${who}`;
      return visible.has(Number(f.hearing.id))
        ? { field: f.reason === 'ROOM' ? 'room' : 'participants', message: `${what} is already booked (${f.hearing.hearing_no}, ${f.hearing.starts_at}).` }
        : { field: f.reason === 'ROOM' ? 'room' : 'participants', message: `${what} is not available at this time.` };
    });
    throw new HttpError(409, 'SCHEDULE_CONFLICT', 'The hearing conflicts with another booking.', details);
  }

  /** Kann dieser Benutzer an einem Termin dieser Akte teilnehmen (Freigabe + Compartments)? */
  function assertEligible(p, c, userId) {
    const u = /** @type {any} */ (db.prepare("SELECT * FROM users WHERE id = ? AND status = 'ACTIVE'").get(userId));
    if (!u) throw badRequest('Unknown or inactive user.', [{ field: 'participants', message: 'Unknown user.' }]);
    const up = loadPrincipal(db, u, { orgs: p.orgs });
    if (!up.clearedFor(c.security_level) || !up.holdsCompartments(comps(c.id))) {
      throw badRequest(`${u.display_name} is not cleared for this case.`, [{ field: 'participants', message: 'Participant not cleared for this case.' }]);
    }
  }

  function insertParticipant(p, hearingId, d) {
    db.prepare(`INSERT INTO hearing_participants (hearing_id, user_id, party_name, role, is_presiding, added_by, added_at) VALUES (?,?,?,?,?,?,?)`)
      .run(hearingId, d.userId ?? null, d.partyName ?? null, d.role, d.isPresiding ? 1 : 0, p.user.id, now());
  }

  function detail(p, hr) {
    const caseVisible = canViewCase(db, p, hr.case_id);
    const c = caseRow(hr.case_id);
    const protocolVisible = hr.protocol_document_id ? docs.visibleIds(p, [hr.protocol_document_id]).length > 0 : false;
    return {
      id: hr.id, hearingNo: hr.hearing_no, title: hr.title, kind: hr.kind, room: hr.room, startsAt: hr.starts_at, endsAt: hr.ends_at,
      status: hr.status, statusReason: hr.status_reason, notes: caseVisible ? hr.notes : '', securityLevel: hr.security_level,
      court: orgRef(p.orgs, hr.court_org_id),
      case: caseVisible ? { id: c.id, caseNumber: c.case_number, title: c.title } : null,
      participants: participantsOf(hr.id).map((x) => ({ id: x.id, role: x.role, isPresiding: Boolean(x.is_presiding),
        user: x.user_id ? { id: x.user_id, name: x.user_name } : null, partyName: x.party_name })),
      protocolDocumentId: protocolVisible ? hr.protocol_document_id : null,
      hasProtocol: Boolean(hr.protocol_document_id),
      capabilities: capabilities(p, hr),
    };
  }

  /** Benutzer-Teilnehmer eines Termins benachrichtigen. */
  const notifyHearing = (hearingId, type, title, actorId) => {
    const hr = /** @type {any} */ (db.prepare('SELECT * FROM hearings WHERE id = ?').get(hearingId));
    const c = caseRow(hr.case_id);
    const users = participantsOf(hearingId).filter((x) => x.user_id).map((x) => Number(x.user_id));
    ctx.notify?.toUsers(users, { type, title, body: `${String(hr.starts_at).slice(0, 16).replace('T', ' ')} UTC · ${hr.room}`, link: `/app/hearings/${hr.id}`,
      subjectType: 'hearing', subjectId: hr.id, level: hr.security_level, compartments: comps(hr.case_id), sealed: Boolean(c.is_sealed) }, { exceptUserId: actorId });
  };

  const validWindow = (s, e) => {
    if (Date.parse(e) <= Date.parse(s)) throw badRequest('The hearing must end after it starts.', [{ field: 'endsAt', message: 'Must be after the start.' }]);
    if (Date.parse(e) - Date.parse(s) > 24 * 3_600_000) throw badRequest('A hearing cannot last longer than 24 hours.', [{ field: 'endsAt', message: 'Too long.' }]);
  };

  return {
    schemas, KINDS, ROLES, visibility,

    create(p, reqCtx, input) {
      const d = schemas.create.parse(input);
      const c = cases.loadVisible(p, reqCtx, d.caseId);
      if (!isCourt(p, c.owning_org_id)) throw badRequest('Hearings are scheduled in court cases.');
      if (!planner(p, c) || !p.has('HEARING_CREATE', c.owning_org_id) || !p.has('HEARING_SCHEDULE', c.owning_org_id)) throw forbidden();
      if (!['OPEN', 'ACTIVE'].includes(c.status)) throw conflict('The case is closed.', 'CASE_CLOSED');
      const startsAt = new Date(d.startsAt).toISOString();
      const endsAt = new Date(d.endsAt).toISOString();
      validWindow(startsAt, endsAt);
      if (Date.parse(startsAt) < Date.now() - 3_600_000) throw badRequest('Hearings cannot be scheduled in the past.', [{ field: 'startsAt', message: 'In the past.' }]);
      for (const x of d.participants) if (x.userId) assertEligible(p, c, x.userId);
      const userIds = d.participants.filter((x) => x.userId).map((x) => /** @type {number} */ (x.userId));
      conflicts(p, { courtOrgId: c.owning_org_id, room: d.room, startsAt, endsAt, userIds, excludeId: null });
      const id = transaction(db, () => {
        const ts = now();
        const no = nextNumber(db, `${p.orgs.byId.get(c.owning_org_id).code}-T`);
        const { lastInsertRowid } = db.prepare(`INSERT INTO hearings (hearing_no, case_id, court_org_id, title, kind, room, starts_at, ends_at, notes, security_level, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(no, c.id, c.owning_org_id, d.title, d.kind, d.room, startsAt, endsAt, d.notes, c.security_level, p.user.id, ts, ts);
        const hid = Number(lastInsertRowid);
        for (const x of d.participants) insertParticipant(p, hid, x);
        event(c.id, 'HEARING_SCHEDULED', p.user.id, `${d.title} scheduled (${no}, ${d.room})`, { hearingId: hid, startsAt });
        audit.write({ ...reqCtx, action: 'HEARING_CREATE', resourceType: 'hearing', resourceId: hid, resourceOrgId: c.owning_org_id,
          resourceLevel: c.security_level, resourceCompartments: comps(c.id), details: { hearingNo: no, startsAt, room: d.room } });
        notifyHearing(hid, 'HEARING_SCHEDULED', `Hearing scheduled: ${d.title}`, p.user.id);
        return hid;
      });
      return detail(p, db.prepare('SELECT * FROM hearings WHERE id = ?').get(id));
    },

    list(p, query) {
      const f = schemas.list.parse(query);
      const v = visibility(p);
      const where = [v.sql];
      const params = [...v.params];
      if (f.from) { where.push('hr.ends_at >= ?'); params.push(new Date(f.from).toISOString()); }
      if (f.to) { where.push('hr.starts_at < ?'); params.push(new Date(f.to).toISOString()); }
      if (f.caseId) { where.push('hr.case_id = ?'); params.push(f.caseId); }
      if (f.status) { where.push('hr.status = ?'); params.push(f.status); }
      if (f.mine === '1') {
        // Meine Termine: eingeladen – oder der Gerichtsakte zugewiesen (z. B. vorsitzende Richterin)
        where.push(`(EXISTS (SELECT 1 FROM hearing_participants hm WHERE hm.hearing_id = hr.id AND hm.user_id = ? AND hm.removed_at IS NULL)
          OR EXISTS (SELECT 1 FROM case_participants cm WHERE cm.case_id = hr.case_id AND cm.user_id = ? AND cm.removed_at IS NULL AND cm.grants_access = 1))`);
        params.push(p.user.id, p.user.id);
      }
      const rows = db.prepare(`SELECT hr.* FROM hearings hr WHERE ${where.join(' AND ')} ORDER BY hr.starts_at LIMIT ?`).all(...params, f.limit);
      return { items: rows.map((hr) => { const x = detail(p, hr); delete x.capabilities; return x; }) };
    },

    get(p, reqCtx, id) {
      const hr = loadVisible(p, reqCtx, id);
      audit.write({ ...reqCtx, action: 'HEARING_VIEW', ...res(hr) });
      return detail(p, hr);
    },

    update(p, reqCtx, id, input) {
      const d = schemas.update.parse(input);
      const hr = loadVisible(p, reqCtx, id);
      requireCap(p, reqCtx, 'edit', hr);
      transaction(db, () => {
        db.prepare('UPDATE hearings SET title = COALESCE(?, title), notes = COALESCE(?, notes), updated_at = ? WHERE id = ?').run(d.title ?? null, d.notes ?? null, now(), id);
        audit.write({ ...reqCtx, action: 'HEARING_EDIT', ...res(hr), details: { fields: Object.keys(d) } });
      });
      return detail(p, loadVisible(p, reqCtx, id));
    },

    reschedule(p, reqCtx, id, input) {
      const d = schemas.reschedule.parse(input);
      const hr = loadVisible(p, reqCtx, id);
      requireCap(p, reqCtx, 'reschedule', hr);
      const startsAt = new Date(d.startsAt).toISOString();
      const endsAt = new Date(d.endsAt).toISOString();
      validWindow(startsAt, endsAt);
      const room = d.room ?? hr.room;
      const userIds = participantsOf(id).filter((x) => x.user_id).map((x) => Number(x.user_id));
      conflicts(p, { courtOrgId: hr.court_org_id, room, startsAt, endsAt, userIds, excludeId: id });
      transaction(db, () => {
        db.prepare("UPDATE hearings SET starts_at = ?, ends_at = ?, room = ?, status = 'SCHEDULED', status_reason = ?, updated_at = ? WHERE id = ?")
          .run(startsAt, endsAt, room, d.reason, now(), id);
        event(hr.case_id, 'HEARING_RESCHEDULED', p.user.id, `${hr.title} rescheduled`, { hearingId: id, from: hr.starts_at, to: startsAt, reason: d.reason });
        audit.write({ ...reqCtx, action: 'HEARING_RESCHEDULE', ...res(hr), details: { from: hr.starts_at, to: startsAt, room, reason: d.reason } });
        notifyHearing(id, 'HEARING_RESCHEDULED', `Hearing rescheduled: ${hr.title}`, p.user.id);
      });
      return detail(p, loadVisible(p, reqCtx, id));
    },

    /** postpone | cancel | held */
    setStatus(p, reqCtx, id, action, input) {
      const hr = loadVisible(p, reqCtx, id);
      requireCap(p, reqCtx, action, hr);
      const why = action === 'held' ? '' : schemas.reason.parse(input).reason;
      const status = { postpone: 'POSTPONED', cancel: 'CANCELLED', held: 'HELD' }[action];
      transaction(db, () => {
        db.prepare('UPDATE hearings SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?').run(status, why, now(), id);
        event(hr.case_id, `HEARING_${status}`, p.user.id, `${hr.title}: ${status.toLowerCase()}`, { hearingId: id, reason: why || undefined });
        audit.write({ ...reqCtx, action: `HEARING_${status}`, ...res(hr), details: { reason: why || undefined } });
        if (status !== 'HELD') notifyHearing(id, `HEARING_${status}`, `Hearing ${status.toLowerCase()}: ${hr.title}`, p.user.id);
      });
      return detail(p, loadVisible(p, reqCtx, id));
    },

    addParticipant(p, reqCtx, id, input) {
      const d = schemas.participant.parse(input);
      const hr = loadVisible(p, reqCtx, id);
      requireCap(p, reqCtx, 'participants', hr);
      if (d.userId) {
        assertEligible(p, caseRow(hr.case_id), d.userId);
        if (participantsOf(id).some((x) => x.user_id === d.userId)) throw conflict('This person already takes part.');
        if (hr.status === 'SCHEDULED') conflicts(p, { courtOrgId: hr.court_org_id, room: null, startsAt: hr.starts_at, endsAt: hr.ends_at, userIds: [d.userId], excludeId: id });
      }
      transaction(db, () => {
        insertParticipant(p, id, d);
        audit.write({ ...reqCtx, action: 'HEARING_PARTICIPANT_ADD', ...res(hr), details: { role: d.role, userId: d.userId ?? null, partyName: d.partyName ?? null } });
        if (d.userId) {
          ctx.notify?.toUsers([d.userId], { type: 'HEARING_INVITED', title: `You are invited to a hearing: ${hr.title}`, body: `${String(hr.starts_at).slice(0, 16).replace('T', ' ')} UTC · ${hr.room}`,
            link: `/app/hearings/${id}`, subjectType: 'hearing', subjectId: id, level: hr.security_level, compartments: comps(hr.case_id), sealed: Boolean(caseRow(hr.case_id).is_sealed) }, { exceptUserId: p.user.id });
        }
      });
      return detail(p, loadVisible(p, reqCtx, id));
    },

    removeParticipant(p, reqCtx, id, participantId) {
      const hr = loadVisible(p, reqCtx, id);
      requireCap(p, reqCtx, 'participants', hr);
      const x = /** @type {any} */ (db.prepare('SELECT * FROM hearing_participants WHERE id = ? AND hearing_id = ? AND removed_at IS NULL').get(participantId, id));
      if (!x) throw notFound();
      transaction(db, () => {
        db.prepare('UPDATE hearing_participants SET removed_at = ? WHERE id = ?').run(now(), participantId);
        audit.write({ ...reqCtx, action: 'HEARING_PARTICIPANT_REMOVE', ...res(hr), details: { participantId, userId: x.user_id } });
      });
      return detail(p, loadVisible(p, reqCtx, id));
    },

    /** Sitzungsprotokoll als Dokument in der Gerichtsakte anlegen und verknüpfen. */
    protocol(p, reqCtx, id, input) {
      const d = schemas.protocol.parse(input);
      const hr = loadVisible(p, reqCtx, id);
      requireCap(p, reqCtx, 'protocol', hr);
      const doc = transaction(db, () => {
        const created = docs.create(p, reqCtx, { typeCode: 'HEARING_PROTOCOL', caseId: hr.case_id, title: `Protocol – ${hr.title} (${hr.hearing_no})`,
          content: { termin: `${hr.starts_at.slice(0, 16).replace('T', ' ')} UTC, ${hr.room}`, ...d.fields } });
        db.prepare("UPDATE hearings SET protocol_document_id = ?, status = CASE WHEN status = 'SCHEDULED' THEN 'HELD' ELSE status END, updated_at = ? WHERE id = ?")
          .run(created.id, now(), id);
        audit.write({ ...reqCtx, action: 'HEARING_PROTOCOL', ...res(hr), details: { documentId: created.id } });
        return created;
      });
      return { hearing: detail(p, loadVisible(p, reqCtx, id)), documentId: doc.id };
    },
  };
}

module.exports = { createHearingService, KINDS, ROLES };
