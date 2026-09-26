// @ts-check
'use strict';
/**
 * Fristen (prompt.txt 6.6, LEGAL_AUTHORITY_MATRIX.md „Fristen“).
 *
 * - Die Fälligkeit wird immer manuell gesetzt: Fristdauern stammen aus Rechtsquellen, die noch nicht verifiziert
 *   sind, und werden nicht erfunden. Ein optionaler Freitext hält die Rechtsgrundlage fest, sobald sie geprüft ist.
 * - „Überfällig“ ist ein berechneter Zustand (offen und Fälligkeit überschritten), kein gespeicherter.
 * - Verlängerungen werden unveränderlich protokolliert (deadline_extensions, append-only).
 * - Sichtbarkeit über die Akte. Verantwortlich kann nur sein, wer die Akte sieht.
 */
const { z } = require('zod');
const { transaction, now } = require('../../db');
const { forbidden, notFound, badRequest, conflict } = require('../../http/errors');
const { caseVisibility, canViewCase } = require('../cases/visibility');
const { createCaseService } = require('../cases/service');
const { loadPrincipal } = require('../authz/principal');

const DUE_SOON_DAYS = 7;
const iso = z.string().datetime({ offset: true });
const reason = z.string().trim().min(3).max(1000);
const schemas = {
  create: z.object({
    caseId: z.number().int().positive(),
    title: z.string().trim().min(3).max(200),
    description: z.string().trim().max(5000).default(''),
    dueAt: iso,
    responsibleUserId: z.number().int().positive(),
    legalBasisRef: z.string().trim().max(300).default(''),
  }),
  extend: z.object({ dueAt: iso, reason }),
  reason: z.object({ reason }),
  list: z.object({
    caseId: z.coerce.number().int().positive().optional(),
    mine: z.enum(['0', '1']).optional(),
    state: z.enum(['open', 'overdue', 'due_soon', 'done', 'cancelled', 'all']).default('open'),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  }),
};

/** @param {import('../../app').AppContext} ctx */
function createDeadlineService(ctx) {
  const { db, audit } = ctx;
  const cases = createCaseService(ctx);

  const caseRow = (id) => /** @type {any} */ (db.prepare('SELECT * FROM cases WHERE id = ?').get(id));
  const comps = (caseId) => db.prepare('SELECT compartment_code c FROM case_compartments WHERE case_id = ?').all(caseId).map((r) => String(r.c));
  const res = (d) => {
    const c = caseRow(d.case_id);
    return { resourceType: 'deadline', resourceId: d.id, resourceOrgId: c.owning_org_id, resourceLevel: c.security_level, resourceCompartments: comps(c.id) };
  };
  const event = (caseId, type, actorId, summary, payload = {}) => {
    db.prepare('INSERT INTO case_events (case_id, type, actor_user_id, summary, payload, created_at) VALUES (?,?,?,?,?,?)')
      .run(caseId, type, actorId, summary, JSON.stringify(payload), now());
    db.prepare('UPDATE cases SET updated_at = ? WHERE id = ?').run(now(), caseId);
  };
  const nameOf = (uid) => String(/** @type {any} */ (db.prepare('SELECT display_name FROM users WHERE id = ?').get(uid))?.display_name ?? '');

  function visibility(p, alias = 'dl') {
    const v = caseVisibility(db, p, { alias: 'dlc' });
    return { sql: `EXISTS (SELECT 1 FROM cases dlc WHERE dlc.id = ${alias}.case_id AND ${v.sql})`, params: v.params };
  }

  function loadVisible(p, reqCtx, id) {
    const v = visibility(p);
    const d = /** @type {any} */ (db.prepare(`SELECT dl.* FROM deadlines dl WHERE dl.id = ? AND ${v.sql}`).get(id, ...v.params));
    if (d) return d;
    const hidden = /** @type {any} */ (db.prepare('SELECT * FROM deadlines WHERE id = ?').get(id));
    if (hidden && reqCtx) audit.write({ ...reqCtx, action: 'DEADLINE_ACCESS', outcome: 'DENIED', ...res(hidden) });
    throw notFound();
  }

  const state = (d) => (d.status !== 'OPEN' ? d.status
    : Date.parse(d.due_at) < Date.now() ? 'OVERDUE'
      : Date.parse(d.due_at) < Date.now() + DUE_SOON_DAYS * 86_400_000 ? 'DUE_SOON' : 'OPEN');

  function capabilities(p, d) {
    const c = caseRow(d.case_id);
    const involved = cases.capabilities(p, c).addDocument || p.has('CASE_ASSIGN', c.owning_org_id);
    const open = d.status === 'OPEN';
    return {
      complete: open && (d.responsible_user_id === p.user.id || (involved && p.has('DEADLINE_MANAGE', c.owning_org_id))),
      extend: open && involved && p.has('DEADLINE_EXTEND', c.owning_org_id),
      cancel: open && involved && p.has('DEADLINE_MANAGE', c.owning_org_id),
    };
  }
  function requireCap(p, reqCtx, cap, d) {
    if (capabilities(p, d)[cap]) return;
    audit.write({ ...reqCtx, action: `DEADLINE_${cap.toUpperCase()}`, outcome: 'DENIED', ...res(d) });
    if (d.status !== 'OPEN') throw conflict('This deadline is no longer open.', 'DEADLINE_CLOSED');
    throw forbidden();
  }

  function detail(p, d, withCaps = true) {
    const c = caseRow(d.case_id);
    return {
      id: d.id, title: d.title, description: d.description, dueAt: d.due_at, status: d.status, state: state(d),
      legalBasisRef: d.legal_basis_ref, statusReason: d.status_reason,
      responsible: { id: d.responsible_user_id, name: nameOf(d.responsible_user_id) },
      case: { id: c.id, caseNumber: c.case_number, title: c.title },
      completedAt: d.completed_at, completedBy: d.completed_by ? nameOf(d.completed_by) : null,
      createdAt: d.created_at, createdBy: nameOf(d.created_by),
      extensions: db.prepare('SELECT * FROM deadline_extensions WHERE deadline_id = ? ORDER BY id').all(d.id)
        .map((x) => ({ from: x.old_due_at, to: x.new_due_at, reason: x.reason, by: nameOf(x.extended_by), at: x.created_at })),
      ...(withCaps ? { capabilities: capabilities(p, d) } : {}),
    };
  }

  return {
    schemas, visibility, state,

    create(p, reqCtx, input) {
      const d = schemas.create.parse(input);
      const c = cases.loadVisible(p, reqCtx, d.caseId);
      const involved = cases.capabilities(p, c).addDocument || p.has('CASE_ASSIGN', c.owning_org_id);
      if (!involved || !p.has('DEADLINE_MANAGE', c.owning_org_id)) throw forbidden();
      if (!['OPEN', 'ACTIVE'].includes(c.status)) throw conflict('The case is closed.', 'CASE_CLOSED');
      const u = /** @type {any} */ (db.prepare("SELECT * FROM users WHERE id = ? AND status = 'ACTIVE'").get(d.responsibleUserId));
      if (!u || !canViewCase(db, loadPrincipal(db, u, { orgs: p.orgs }), c.id)) {
        throw badRequest('The responsible person must have access to the case.', [{ field: 'responsibleUserId', message: 'No access to the case.' }]);
      }
      const due = new Date(d.dueAt).toISOString();
      const id = transaction(db, () => {
        const ts = now();
        const { lastInsertRowid } = db.prepare(`INSERT INTO deadlines (case_id, title, description, due_at, responsible_user_id, legal_basis_ref, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(c.id, d.title, d.description, due, u.id, d.legalBasisRef, p.user.id, ts, ts);
        const did = Number(lastInsertRowid);
        event(c.id, 'DEADLINE_SET', p.user.id, `Deadline "${d.title}" set for ${due.slice(0, 10)} (${u.display_name})`, { deadlineId: did });
        audit.write({ ...reqCtx, action: 'DEADLINE_CREATE', resourceType: 'deadline', resourceId: did, resourceOrgId: c.owning_org_id,
          resourceLevel: c.security_level, resourceCompartments: comps(c.id), details: { dueAt: due, responsible: u.id } });
        ctx.notify?.toUsers([u.id], { type: 'DEADLINE_ASSIGNED', title: `Deadline assigned to you: ${d.title}`, body: `${c.case_number} · due ${due.slice(0, 16).replace('T', ' ')} UTC`,
          link: `/app/cases/${c.id}?tab=schedule`, subjectType: 'deadline', subjectId: did, level: c.security_level, compartments: comps(c.id), sealed: Boolean(c.is_sealed) }, { exceptUserId: p.user.id });
        return did;
      });
      return detail(p, db.prepare('SELECT * FROM deadlines WHERE id = ?').get(id));
    },

    list(p, query) {
      const f = schemas.list.parse(query);
      const v = visibility(p);
      const where = [v.sql];
      const params = [...v.params];
      const ts = now();
      if (f.caseId) { where.push('dl.case_id = ?'); params.push(f.caseId); }
      if (f.mine === '1') { where.push('dl.responsible_user_id = ?'); params.push(p.user.id); }
      if (f.state === 'open') where.push("dl.status = 'OPEN'");
      else if (f.state === 'overdue') { where.push("dl.status = 'OPEN' AND dl.due_at < ?"); params.push(ts); }
      else if (f.state === 'due_soon') {
        where.push("dl.status = 'OPEN' AND dl.due_at >= ? AND dl.due_at < ?");
        params.push(ts, new Date(Date.now() + DUE_SOON_DAYS * 86_400_000).toISOString());
      } else if (f.state === 'done') where.push("dl.status = 'DONE'");
      else if (f.state === 'cancelled') where.push("dl.status = 'CANCELLED'");
      const rows = db.prepare(`SELECT dl.* FROM deadlines dl WHERE ${where.join(' AND ')} ORDER BY dl.due_at LIMIT ?`).all(...params, f.limit);
      return { items: rows.map((d) => detail(p, d)) };
    },

    get(p, reqCtx, id) {
      return detail(p, loadVisible(p, reqCtx, id));
    },

    complete(p, reqCtx, id) {
      const d = loadVisible(p, reqCtx, id);
      requireCap(p, reqCtx, 'complete', d);
      transaction(db, () => {
        const ts = now();
        db.prepare("UPDATE deadlines SET status = 'DONE', completed_at = ?, completed_by = ?, updated_at = ? WHERE id = ?").run(ts, p.user.id, ts, id);
        event(d.case_id, 'DEADLINE_DONE', p.user.id, `Deadline "${d.title}" completed${Date.parse(d.due_at) < Date.now() ? ' (after the due date)' : ''}`, { deadlineId: id });
        audit.write({ ...reqCtx, action: 'DEADLINE_COMPLETE', ...res(d), details: { late: Date.parse(d.due_at) < Date.now() } });
      });
      return detail(p, loadVisible(p, reqCtx, id));
    },

    extend(p, reqCtx, id, input) {
      const x = schemas.extend.parse(input);
      const d = loadVisible(p, reqCtx, id);
      requireCap(p, reqCtx, 'extend', d);
      const due = new Date(x.dueAt).toISOString();
      if (Date.parse(due) <= Date.parse(d.due_at)) throw badRequest('The new due date must be later than the current one.', [{ field: 'dueAt', message: 'Must be later.' }]);
      transaction(db, () => {
        const ts = now();
        db.prepare('INSERT INTO deadline_extensions (deadline_id, old_due_at, new_due_at, reason, extended_by, created_at) VALUES (?,?,?,?,?,?)').run(id, d.due_at, due, x.reason, p.user.id, ts);
        db.prepare('UPDATE deadlines SET due_at = ?, updated_at = ? WHERE id = ?').run(due, ts, id);
        event(d.case_id, 'DEADLINE_EXTENDED', p.user.id, `Deadline "${d.title}" extended to ${due.slice(0, 10)}`, { deadlineId: id, from: d.due_at, to: due, reason: x.reason });
        audit.write({ ...reqCtx, action: 'DEADLINE_EXTEND', ...res(d), details: { from: d.due_at, to: due, reason: x.reason } });
      });
      return detail(p, loadVisible(p, reqCtx, id));
    },

    cancel(p, reqCtx, id, input) {
      const { reason: why } = schemas.reason.parse(input);
      const d = loadVisible(p, reqCtx, id);
      requireCap(p, reqCtx, 'cancel', d);
      transaction(db, () => {
        db.prepare("UPDATE deadlines SET status = 'CANCELLED', status_reason = ?, updated_at = ? WHERE id = ?").run(why, now(), id);
        event(d.case_id, 'DEADLINE_CANCELLED', p.user.id, `Deadline "${d.title}" cancelled`, { deadlineId: id, reason: why });
        audit.write({ ...reqCtx, action: 'DEADLINE_CANCEL', ...res(d), details: { reason: why } });
      });
      return detail(p, loadVisible(p, reqCtx, id));
    },
  };
}

module.exports = { createDeadlineService, DUE_SOON_DAYS };
