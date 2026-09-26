// @ts-check
'use strict';
/**
 * Audit-Ansicht, Integritätsprüfung und Export (prompt.txt 6.11, SECURITY_MODEL.md 8, Testfall A17).
 *
 * Wer sieht welchen Eintrag?
 *   - AUDIT_VIEW im Scope der betroffenen Organisation (resource_org_id, sonst aktive Organisation des Handelnden).
 *     Einträge ohne Organisationsbezug nur mit globalem AUDIT_VIEW.
 *   - Clearance ≥ Stufe des Eintrags (resource_level) und alle Compartments des Eintrags gehalten.
 *     Ein Auditor ohne USSJA sieht keine US-SJA-Einträge – auch nicht in Zahlen.
 * Das Lesen des Audit Logs wird selbst auditiert (AUDIT_VIEW / AUDIT_EXPORT).
 */
const { z } = require('zod');
const { inList, parseJson } = require('../../db');
const { forbidden } = require('../../http/errors');
const { orgRef } = require('../users/me');

const iso = z.string().datetime({ offset: true });
const schemas = {
  list: z.object({
    userId: z.coerce.number().int().positive().optional(),
    orgId: z.coerce.number().int().positive().optional(),
    action: z.string().trim().max(60).regex(/^[A-Z0-9_]*$/).optional(),
    resourceType: z.string().trim().max(40).regex(/^[a-z_]*$/).optional(),
    resourceId: z.string().trim().max(40).optional(),
    caseId: z.coerce.number().int().positive().optional(),
    outcome: z.enum(['SUCCESS', 'DENIED', 'FAILURE']).optional(),
    level: z.string().max(20).optional(),
    ip: z.string().trim().max(60).optional(),
    from: iso.optional(),
    to: iso.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }),
};

/** @param {import('../../app').AppContext} ctx */
function createAuditService(ctx) {
  const { db, audit } = ctx;

  /** SQL-Prädikat: welche Audit-Einträge darf p sehen? */
  function visibility(p, alias = 'al', code = 'AUDIT_VIEW') {
    if (!p.hasAnywhere(code)) return { sql: '0', params: [] };
    const params = [];
    let orgClause;
    if (p.has(code, null)) {
      orgClause = '1';
    } else {
      const orgs = [...p.orgsWith(code)];
      orgClause = `COALESCE(${alias}.resource_org_id, ${alias}.active_org_id) IN (${inList(orgs)})`;
      params.push(...orgs);
    }
    const comps = [...p.compartments];
    const compClause = comps.length
      ? `NOT EXISTS (SELECT 1 FROM json_each(${alias}.resource_compartments) j WHERE j.value NOT IN (${inList(comps)}))`
      : `json_array_length(${alias}.resource_compartments) = 0`;
    return {
      sql: `(${orgClause} AND (${alias}.resource_level IS NULL OR (SELECT rank FROM security_levels WHERE code = ${alias}.resource_level) <= ?) AND ${compClause})`,
      params: [...params, p.clearanceRank, ...comps],
    };
  }

  function where(p, f, code) {
    const v = visibility(p, 'al', code);
    const w = [v.sql];
    const params = [...v.params];
    if (f.userId) { w.push('al.actor_user_id = ?'); params.push(f.userId); }
    if (f.orgId) {
      const sub = p.orgs.subtree(f.orgId);
      w.push(`COALESCE(al.resource_org_id, al.active_org_id) IN (${inList(sub)})`);
      params.push(...sub);
    }
    if (f.action) { w.push("al.action LIKE ? ESCAPE '\\'"); params.push(`${f.action.replace(/_/g, '\\_')}%`); }
    if (f.resourceType) { w.push('al.resource_type = ?'); params.push(f.resourceType); }
    if (f.resourceId) { w.push('al.resource_id = ?'); params.push(f.resourceId); }
    if (f.caseId) { w.push("al.resource_type = 'case' AND al.resource_id = ?"); params.push(String(f.caseId)); }
    if (f.outcome) { w.push('al.outcome = ?'); params.push(f.outcome); }
    if (f.level) { w.push('al.resource_level = ?'); params.push(f.level); }
    if (f.ip) { w.push('al.ip = ?'); params.push(f.ip); }
    if (f.from) { w.push('al.ts >= ?'); params.push(new Date(f.from).toISOString()); }
    if (f.to) { w.push('al.ts <= ?'); params.push(new Date(f.to).toISOString()); }
    return { sql: w.join(' AND '), params };
  }

  const users = new Map();
  const nameOf = (id) => {
    if (id == null) return null;
    if (!users.has(id)) users.set(id, /** @type {any} */ (db.prepare('SELECT display_name, username FROM users WHERE id = ?').get(id)) ?? null);
    const u = users.get(id);
    return u ? `${u.display_name} (${u.username})` : `#${id}`;
  };

  const row = (p, r) => ({
    id: r.id, ts: r.ts, action: r.action, outcome: r.outcome,
    actor: r.actor_user_id ? { id: r.actor_user_id, name: nameOf(r.actor_user_id) } : null,
    activeOrg: r.active_org_id ? orgRef(p.orgs, Number(r.active_org_id))?.shortName ?? null : null,
    resource: r.resource_type ? { type: r.resource_type, id: r.resource_id } : null,
    resourceOrg: r.resource_org_id ? orgRef(p.orgs, Number(r.resource_org_id))?.shortName ?? null : null,
    level: r.resource_level, compartments: parseJson(r.resource_compartments, []),
    ip: r.ip, userAgent: r.user_agent, details: parseJson(r.details, {}), hash: r.hash,
  });

  return {
    schemas,
    visibility,

    list(p, reqCtx, query) {
      if (!p.hasAnywhere('AUDIT_VIEW')) throw forbidden();
      const f = schemas.list.parse(query);
      const w = where(p, f, 'AUDIT_VIEW');
      const total = Number(/** @type {any} */ (db.prepare(`SELECT COUNT(*) n FROM audit_log al WHERE ${w.sql}`).get(...w.params)).n);
      const rows = db.prepare(`SELECT al.* FROM audit_log al WHERE ${w.sql} ORDER BY al.id DESC LIMIT ? OFFSET ?`).all(...w.params, f.limit, f.offset);
      audit.write({ ...reqCtx, action: 'AUDIT_VIEW', details: { filters: { ...f, limit: undefined, offset: undefined } } });
      return { total, items: rows.map((r) => row(p, r)) };
    },

    /** Integrität der Hash-Kette. Gibt keine Zahlen über Einträge preis, die der Auditor nicht sehen darf. */
    verify(p, reqCtx) {
      if (!p.hasAnywhere('AUDIT_VIEW')) throw forbidden();
      const r = audit.verify();
      audit.write({ ...reqCtx, action: 'AUDIT_VERIFY', details: { ok: r.ok } });
      if (r.ok) return { ok: true };
      const v = visibility(p);
      const visible = Boolean(db.prepare(`SELECT 1 FROM audit_log al WHERE al.id = ? AND ${v.sql}`).get(r.brokenAtId, ...v.params));
      return { ok: false, brokenAtId: visible ? r.brokenAtId : null };
    },

    /** CSV-Export (AUDIT_EXPORT; dieselbe Sichtbarkeitsregel, höchstens 5000 Einträge). */
    exportCsv(p, reqCtx, query) {
      if (!p.hasAnywhere('AUDIT_EXPORT')) throw forbidden();
      const f = schemas.list.parse({ ...query, limit: 200, offset: 0 });
      // Export nur, was auch angesehen werden darf: beide Permissions im jeweiligen Scope
      const exp = where(p, f, 'AUDIT_EXPORT');
      const view = visibility(p, 'al', 'AUDIT_VIEW');
      const rows = db.prepare(`SELECT al.* FROM audit_log al WHERE ${exp.sql} AND ${view.sql} ORDER BY al.id DESC LIMIT 5000`).all(...exp.params, ...view.params);
      audit.write({ ...reqCtx, action: 'AUDIT_EXPORT', details: { rows: rows.length, filters: { ...f, limit: undefined, offset: undefined } } });
      const header = ['id', 'timestamp', 'action', 'outcome', 'actor', 'active_org', 'resource_type', 'resource_id', 'resource_org', 'level', 'compartments', 'ip', 'details', 'hash'];
      const lines = rows.map((r) => {
        const x = row(p, r);
        return [x.id, x.ts, x.action, x.outcome, x.actor?.name ?? 'SYSTEM', x.activeOrg ?? '', x.resource?.type ?? '', x.resource?.id ?? '', x.resourceOrg ?? '',
          x.level ?? '', x.compartments.join(' '), x.ip, JSON.stringify(x.details), x.hash];
      });
      return toCsv(header, lines);
    },
  };
}

/** CSV nach RFC 4180; Formeln werden neutralisiert (CSV-Injection). */
function toCsv(header, lines) {
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...lines].map((l) => l.map(cell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { createAuditService, toCsv };
