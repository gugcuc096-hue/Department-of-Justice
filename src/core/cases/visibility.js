// @ts-check
'use strict';
/**
 * Sichtbarkeit von Akten – EINZIGE Quelle der Wahrheit (SECURITY_MODEL.md Abschnitte 4 und 9).
 *
 * Das Prädikat wird als SQL-Fragment erzeugt und für alles verwendet: Detailansicht (… AND c.id = ?),
 * Listen, Zähler, Suche, Verknüpfungen, Notifications. Damit können Einzel- und Listenprüfung nicht
 * auseinanderlaufen.
 *
 * Sichtbar, wenn ALLE gelten:
 *   1. Clearance ≥ Level der Akte
 *   2. Benutzer hält alle Compartments der Akte
 *   3. mindestens ein Zugang:
 *      a. Beteiligter mit Zugang (bei versiegelten Akten nur mit sealed_access)
 *      b. persönlicher Zugang (case_access USER; bei versiegelten Akten nur mit sealed_access)
 *      c. Rollen-Zugang            ┐
 *      d. Organisations-Zugang     ├ nur wenn weder versiegelt noch "explicit access"
 *      e. Supervisor (CASE_VIEW_ORG)┘
 *      f. Case-gebundene Delegation (nur solange der Delegierende die Akte selbst sehen darf)
 *   a–d setzen CASE_VIEW voraus (d: im Scope der Mitgliedschaft, über die der Zugang besteht).
 */
const { inList } = require('../../db');

/**
 * @param {import('../../db').Database} db
 * @param {import('../authz/principal').Principal} p
 * @param {{ alias?: string, includeDelegations?: boolean }} [opts]
 * @returns {{ sql: string, params: any[] }}
 */
function caseVisibility(db, p, opts = {}) {
  const c = opts.alias ?? 'c';
  const ts = new Date().toISOString();
  const params = [];
  const access = [];

  const canView = p.hasAnywhere('CASE_VIEW');
  const openCase = `(${c}.is_sealed = 0 AND ${c}.requires_explicit_access = 0)`;

  if (canView) {
    // a. Beteiligung
    access.push(`EXISTS (SELECT 1 FROM case_participants vp WHERE vp.case_id = ${c}.id AND vp.user_id = ?
      AND vp.removed_at IS NULL AND vp.grants_access = 1 AND (${c}.is_sealed = 0 OR vp.sealed_access = 1))`);
    params.push(p.user.id);

    // b. persönlicher Zugang
    access.push(`EXISTS (SELECT 1 FROM case_access va WHERE va.case_id = ${c}.id AND va.subject_type = 'USER' AND va.subject_id = ?
      AND va.revoked_at IS NULL AND (va.expires_at IS NULL OR va.expires_at > ?) AND (${c}.is_sealed = 0 OR va.sealed_access = 1))`);
    params.push(p.user.id, ts);

    // c. Rollen-Zugang: Rolle muss im Scope der besitzenden Organisation gelten
    // Rollencode → Organisationen, in denen die Rolle gilt (null = global)
    const roleScopes = /** @type {Map<string, Set<number>|null>} */ (new Map());
    for (const g of p.grants) {
      if (g.source !== 'role' || g.code !== 'CASE_VIEW') continue;
      const key = String(g.roleCode);
      if (g.scopeOrgId == null) { roleScopes.set(key, null); continue; }
      if (roleScopes.get(key) === null) continue;
      const set = roleScopes.get(key) ?? new Set();
      p.orgs.subtree(g.scopeOrgId).forEach((o) => set.add(o));
      roleScopes.set(key, set);
    }
    const roleSql = [];
    const roleParams = [];
    for (const [roleCode, orgSet] of roleScopes) {
      if (orgSet === null) {
        roleSql.push('vr.subject_id = (SELECT id FROM roles WHERE code = ?)');
        roleParams.push(roleCode);
      } else {
        roleSql.push(`(vr.subject_id = (SELECT id FROM roles WHERE code = ?) AND ${c}.owning_org_id IN (${inList([...orgSet])}))`);
        roleParams.push(roleCode, ...orgSet);
      }
    }
    if (roleSql.length) {
      access.push(`(${openCase} AND EXISTS (SELECT 1 FROM case_access vr WHERE vr.case_id = ${c}.id AND vr.subject_type = 'ROLE'
        AND vr.revoked_at IS NULL AND (vr.expires_at IS NULL OR vr.expires_at > ?) AND (${roleSql.join(' OR ')})))`);
      params.push(ts, ...roleParams);
    }

    // d. Organisations-Zugang: Mitgliedschaft im Teilbaum der berechtigten Org, CASE_VIEW dort
    const orgIds = new Set();
    for (const m of p.memberships) {
      if (!p.has('CASE_VIEW', m.orgId)) continue;
      for (const a of p.orgs.ancestorsOf(m.orgId)) orgIds.add(a);
    }
    if (orgIds.size) {
      access.push(`(${openCase} AND EXISTS (SELECT 1 FROM case_access vo WHERE vo.case_id = ${c}.id AND vo.subject_type = 'ORG'
        AND vo.subject_id IN (${inList([...orgIds])}) AND vo.revoked_at IS NULL AND (vo.expires_at IS NULL OR vo.expires_at > ?)))`);
      params.push(...orgIds, ts);
    }
  }

  // e. Supervisor
  const supervised = [...p.orgsWith('CASE_VIEW_ORG')];
  if (supervised.length) {
    access.push(`(${openCase} AND ${c}.owning_org_id IN (${inList(supervised)}))`);
    params.push(...supervised);
  }

  // f. Case-gebundene Delegation – der Delegierende muss die Akte (ohne eigene Delegationen) sehen dürfen
  if (opts.includeDelegations !== false) {
    const delegated = p.delegatedCases('CASE_VIEW');
    if (delegated.length) {
      const { loadPrincipal } = require('../authz/principal');
      const allowed = [];
      for (const d of delegated) {
        const from = db.prepare("SELECT * FROM users WHERE id = ? AND status = 'ACTIVE'").get(d.fromUserId);
        if (!from) continue;
        const fp = loadPrincipal(db, from, { orgs: p.orgs });
        const v = caseVisibility(db, fp, { alias: 'x', includeDelegations: false });
        if (db.prepare(`SELECT 1 FROM cases x WHERE x.id = ? AND ${v.sql}`).get(d.caseId, ...v.params)) allowed.push(d.caseId);
      }
      if (allowed.length) {
        access.push(`${c}.id IN (${inList(allowed)})`);
        params.push(...allowed);
      }
    }
  }

  if (!access.length) return { sql: '0', params: [] };

  const compartments = [...p.compartments];
  const compartmentClause = compartments.length
    ? `NOT EXISTS (SELECT 1 FROM case_compartments vc WHERE vc.case_id = ${c}.id AND vc.compartment_code NOT IN (${inList(compartments)}))`
    : `NOT EXISTS (SELECT 1 FROM case_compartments vc WHERE vc.case_id = ${c}.id)`;

  const sql = `((SELECT rank FROM security_levels WHERE code = ${c}.security_level) <= ?
    AND ${compartmentClause}
    AND (${access.join('\n OR ')}))`;
  return { sql, params: [p.clearanceRank, ...compartments, ...params] };
}

/**
 * Darf p die Akte sehen?
 * @param {import('../../db').Database} db @param {import('../authz/principal').Principal} p @param {number} caseId
 */
function canViewCase(db, p, caseId) {
  const v = caseVisibility(db, p);
  return Boolean(db.prepare(`SELECT 1 FROM cases c WHERE c.id = ? AND ${v.sql}`).get(caseId, ...v.params));
}

module.exports = { caseVisibility, canViewCase };
