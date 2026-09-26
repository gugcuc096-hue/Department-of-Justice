// @ts-check
'use strict';
/**
 * Delegation / Vertretung (prompt.txt 5.8, SECURITY_MODEL.md 11).
 * Ablauf: Delegierender beantragt → Genehmiger mit DELEGATION_APPROVE (nicht Beteiligter) genehmigt → aktiv im Zeitfenster.
 * Compartments und Clearance sind nicht delegierbar; die Delegation wirkt nur, solange der Delegierende
 * die Permission selbst besitzt (geprüft bei jeder Nutzung in principal.js).
 */
const { z } = require('zod');
const { transaction, now } = require('../../db');
const { forbidden, notFound, badRequest, conflict } = require('../../http/errors');
const { canViewCase } = require('../cases/visibility');

const NON_DELEGABLE = new Set(['CLEARANCE_ASSIGN', 'COMPARTMENT_ASSIGN', 'ROLE_ASSIGN', 'PERMISSION_ASSIGN', 'DELEGATION_APPROVE',
  'ROLE_MANAGE', 'ORG_MANAGE', 'FEATURE_TOGGLE', 'CONFIG_MANAGE']);

const schema = z.object({
  toUserId: z.number().int().positive(),
  permission: z.string().min(2).max(64),
  scopeOrgId: z.number().int().positive().nullable(),
  caseId: z.number().int().positive().nullable().default(null),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  reason: z.string().trim().min(3).max(500),
});
const decision = z.object({ reason: z.string().trim().min(3).max(500) });

/** @param {import('../../app').AppContext} ctx */
function createDelegations(ctx) {
  const { db, audit } = ctx;

  const row = (d) => ({
    id: d.id, fromUser: { id: d.from_user_id, name: d.from_name }, toUser: { id: d.to_user_id, name: d.to_name },
    permission: d.permission_code, scopeOrgId: d.scope_org_id, caseId: d.case_id, startsAt: d.starts_at, endsAt: d.ends_at,
    reason: d.reason, status: d.status, approvedBy: d.approved_by, approvedAt: d.approved_at, revokedAt: d.revoked_at,
  });
  const select = `SELECT d.*, f.display_name AS from_name, t.display_name AS to_name
    FROM delegations d JOIN users f ON f.id = d.from_user_id JOIN users t ON t.id = d.to_user_id`;

  /** Darf p über diese Delegation entscheiden? Nie Beteiligte; Scope muss passen. */
  function canApprove(p, d) {
    if (p.user.id === d.from_user_id || p.user.id === d.to_user_id) return false;
    return p.has('DELEGATION_APPROVE', d.scope_org_id);
  }

  return {
    /** @param {import('../authz/principal').Principal} p */
    list(p) {
      const all = db.prepare(`${select} ORDER BY d.created_at DESC LIMIT 500`).all();
      return {
        mine: all.filter((d) => d.from_user_id === p.user.id || d.to_user_id === p.user.id).map(row),
        toApprove: all.filter((d) => d.status === 'PENDING' && canApprove(p, d)).map(row),
      };
    },

    request(p, reqCtx, input) {
      const d = schema.parse(input);
      if (NON_DELEGABLE.has(d.permission)) throw badRequest('This permission cannot be delegated.');
      if (d.toUserId === p.user.id) throw badRequest('You cannot delegate to yourself.');
      if (Date.parse(d.endsAt) <= Date.parse(d.startsAt)) throw badRequest('The end must be after the start.');
      if (Date.parse(d.endsAt) <= Date.now()) throw badRequest('The delegation period has already ended.');
      if (d.scopeOrgId != null && !p.orgs.byId.has(d.scopeOrgId)) throw badRequest('Unknown organization.');
      if (d.caseId != null) {
        // Case-gebunden: nur Akteneinsicht, nur für Akten, die der Delegierende selbst sehen darf
        if (d.permission !== 'CASE_VIEW') throw badRequest('Only CASE_VIEW can be delegated for a single case.');
        if (!p.hasAnywhere('CASE_VIEW') || !canViewCase(db, p, d.caseId)) throw badRequest('The case was not found.');
      } else if (!p.has(d.permission, d.scopeOrgId)) {
        throw forbidden('You can only delegate permissions you hold yourself in this scope.', 'ESCALATION_DENIED');
      }
      const to = /** @type {any} */ (db.prepare("SELECT id, status FROM users WHERE id = ?").get(d.toUserId));
      if (!to || to.status !== 'ACTIVE') throw badRequest('Unknown or inactive user.');
      // Case-gebunden: Genehmigung im Scope des besitzenden Office
      const caseOrg = d.caseId == null ? null : Number(/** @type {any} */ (db.prepare('SELECT owning_org_id FROM cases WHERE id = ?').get(d.caseId)).owning_org_id);
      return transaction(db, () => {
        const { lastInsertRowid } = db.prepare(`INSERT INTO delegations (from_user_id, to_user_id, permission_code, scope_org_id, case_id, starts_at, ends_at, reason)
          VALUES (?,?,?,?,?,?,?,?)`).run(p.user.id, d.toUserId, d.permission, d.caseId == null ? d.scopeOrgId : caseOrg, d.caseId, new Date(d.startsAt).toISOString(), new Date(d.endsAt).toISOString(), d.reason);
        audit.write({ ...reqCtx, action: 'DELEGATION_REQUEST', resourceType: 'delegation', resourceId: Number(lastInsertRowid), resourceOrgId: d.scopeOrgId, details: d });
        return row(db.prepare(`${select} WHERE d.id = ?`).get(lastInsertRowid));
      });
    },

    decide(p, reqCtx, delegationId, approve, input) {
      const { reason } = decision.parse(input);
      const d = /** @type {any} */ (db.prepare('SELECT * FROM delegations WHERE id = ?').get(delegationId));
      if (!d) throw notFound();
      if (!canApprove(p, d)) throw forbidden();
      if (d.status !== 'PENDING') throw conflict('This delegation has already been decided.');
      transaction(db, () => {
        db.prepare('UPDATE delegations SET status = ?, approved_by = ?, approved_at = ? WHERE id = ?').run(approve ? 'ACTIVE' : 'REJECTED', p.user.id, now(), delegationId);
        audit.write({ ...reqCtx, action: approve ? 'DELEGATION_APPROVE' : 'DELEGATION_REJECT', resourceType: 'delegation', resourceId: delegationId,
          resourceOrgId: d.scope_org_id, details: { reason } });
      });
      return row(db.prepare(`${select} WHERE d.id = ?`).get(delegationId));
    },

    revoke(p, reqCtx, delegationId, input) {
      const { reason } = decision.parse(input);
      const d = /** @type {any} */ (db.prepare('SELECT * FROM delegations WHERE id = ?').get(delegationId));
      if (!d) throw notFound();
      const allowed = d.from_user_id === p.user.id || d.to_user_id === p.user.id || canApprove(p, d);
      if (!allowed) throw notFound();
      if (d.status === 'REVOKED' || d.status === 'REJECTED') throw conflict('This delegation is no longer active.');
      transaction(db, () => {
        db.prepare("UPDATE delegations SET status = 'REVOKED', revoked_at = ? WHERE id = ?").run(now(), delegationId);
        audit.write({ ...reqCtx, action: 'DELEGATION_REVOKE', resourceType: 'delegation', resourceId: delegationId, resourceOrgId: d.scope_org_id, details: { reason } });
      });
      return row(db.prepare(`${select} WHERE d.id = ?`).get(delegationId));
    },
  };
}

module.exports = { createDelegations, NON_DELEGABLE };
