// @ts-check
'use strict';
/**
 * Principal: alles, was für Autorisierungsentscheidungen über einen Benutzer bekannt sein muss.
 * Wird pro Request frisch geladen – Rechteänderungen wirken sofort (SECURITY_MODEL.md, Abschnitt 10).
 *
 * Grants stammen aus drei Quellen:
 *   role       – Rolle mit Scope (user_roles)
 *   direct     – Direktgrant (user_permissions)
 *   delegation – aktive Delegation; gilt nur, solange der Delegierende die Permission zum
 *                Nutzungszeitpunkt selbst (ohne eigene Delegationen) besitzt (PERMISSIONS.md, SECURITY_MODEL.md 11)
 */
const { loadOrgTree } = require('./orgs');
const { parseJson } = require('../../db');

/**
 * @typedef {{ code: string, scopeOrgId: number|null, source: 'role'|'direct'|'delegation', caseId: number|null, roleCode?: string, fromUserId?: number }} Grant
 * @typedef {{ orgId: number, rankId: number|null, rankLevel: number|null, rankName: string|null, isPrimary: boolean, supervisorUserId: number|null }} Membership
 */

/**
 * Nicht-delegierte Grants eines Benutzers.
 * @param {import('../../db').Database} db @param {number} userId @param {string} ts
 * @returns {Grant[]}
 */
function ownGrants(db, userId, ts) {
  const fromRoles = db.prepare(`SELECT rp.permission_code AS code, ur.scope_org_id AS scope, r.code AS role_code
    FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN role_permissions rp ON rp.role_id = r.id
    WHERE ur.user_id = ?`).all(userId);
  const direct = db.prepare(`SELECT permission_code AS code, scope_org_id AS scope FROM user_permissions
    WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)`).all(userId, ts);
  return [
    ...fromRoles.map((r) => ({ code: String(r.code), scopeOrgId: /** @type {number|null} */ (r.scope), source: /** @type {const} */ ('role'), caseId: null, roleCode: String(r.role_code) })),
    ...direct.map((r) => ({ code: String(r.code), scopeOrgId: /** @type {number|null} */ (r.scope), source: /** @type {const} */ ('direct'), caseId: null })),
  ];
}

/**
 * @param {import('../../db').Database} db
 * @param {any} user  Zeile aus users
 * @param {{ orgs?: import('./orgs').OrgTree, activeOrgId?: number|null }} [opts]
 */
function loadPrincipal(db, user, opts = {}) {
  const ts = new Date().toISOString();
  const orgs = opts.orgs ?? loadOrgTree(db);

  const memberships = /** @type {Membership[]} */ (db.prepare(`SELECT m.org_id, m.rank_id, m.is_primary, m.supervisor_user_id, r.level, r.name
      FROM memberships m LEFT JOIN ranks r ON r.id = m.rank_id
      WHERE m.user_id = ? AND (m.starts_at IS NULL OR m.starts_at <= ?) AND (m.ends_at IS NULL OR m.ends_at > ?)
      ORDER BY m.is_primary DESC, m.id`).all(user.id, ts, ts)
    .map((r) => ({
      orgId: Number(r.org_id), rankId: /** @type {number|null} */ (r.rank_id), rankLevel: /** @type {number|null} */ (r.level),
      rankName: /** @type {string|null} */ (r.name), isPrimary: Boolean(r.is_primary), supervisorUserId: /** @type {number|null} */ (r.supervisor_user_id),
    })));

  /** @type {Grant[]} */
  const grants = ownGrants(db, user.id, ts);

  // Delegationen: nur aktive, im Zeitfenster, und nur soweit der Delegierende die Permission jetzt selbst hat
  const delegations = db.prepare(`SELECT * FROM delegations
    WHERE to_user_id = ? AND status = 'ACTIVE' AND revoked_at IS NULL AND starts_at <= ? AND ends_at > ?`).all(user.id, ts, ts);
  for (const d of delegations) {
    const delegator = /** @type {any} */ (db.prepare("SELECT id, status FROM users WHERE id = ?").get(d.from_user_id));
    if (!delegator || delegator.status !== 'ACTIVE') continue;
    const theirs = ownGrants(db, delegator.id, ts);
    const scope = /** @type {number|null} */ (d.scope_org_id);
    // Case-gebundene Delegation: Delegierender braucht die Permission irgendwo; ob er die Akte sehen darf,
    // prüft die Sichtbarkeitsregel (cases/visibility.js) zum Nutzungszeitpunkt.
    const covered = d.case_id != null
      ? theirs.some((g) => g.code === d.permission_code)
      : theirs.some((g) => g.code === d.permission_code && (g.scopeOrgId == null || (scope != null && orgs.isWithin(scope, g.scopeOrgId))));
    if (covered) grants.push({ code: String(d.permission_code), scopeOrgId: scope, source: 'delegation', caseId: /** @type {number|null} */ (d.case_id), fromUserId: Number(d.from_user_id) });
  }

  const compartments = new Set(db.prepare(`SELECT compartment_code AS c FROM user_compartments
    WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)`).all(user.id, ts).map((r) => String(r.c)));

  const levels = new Map(db.prepare('SELECT code, rank FROM security_levels').all().map((r) => [String(r.code), Number(r.rank)]));
  const clearanceRank = levels.get(user.clearance_level) ?? 0;

  const rankRequirements = db.prepare('SELECT permission_code, org_id, min_rank_level FROM permission_rank_requirements').all();

  /** Erfüllt der Benutzer die (optionalen) Mindestrang-Anforderungen für code in orgId? */
  function meetsRankRequirements(code, orgId) {
    if (orgId == null) return true;
    const path = orgs.ancestorsOf(orgId);
    for (const req of rankRequirements) {
      if (req.permission_code !== code || !path.includes(Number(req.org_id))) continue;
      const m = memberships.find((x) => x.orgId === Number(req.org_id));
      if (!m || m.rankLevel == null || m.rankLevel < Number(req.min_rank_level)) return false;
    }
    return true;
  }

  const generalGrants = grants.filter((g) => g.caseId == null);

  const principal = {
    user,
    orgs,
    memberships,
    grants,
    compartments,
    clearanceRank,
    levels,
    activeOrgId: opts.activeOrgId ?? memberships[0]?.orgId ?? null,

    /**
     * Besitzt der Benutzer code für eine Ressource der Organisation orgId?
     * orgId null: nur globale Grants zählen.
     * @param {string} code @param {number|null|undefined} orgId
     */
    has(code, orgId) {
      const ok = generalGrants.some((g) => g.code === code && (g.scopeOrgId == null || orgs.isWithin(orgId, g.scopeOrgId)));
      return ok && meetsRankRequirements(code, orgId ?? null);
    },

    /** Besitzt der Benutzer code in irgendeinem Scope? (Navigation, Benutzerführung) @param {string} code */
    hasAnywhere(code) {
      return generalGrants.some((g) => g.code === code);
    },

    /** Alle Organisationen, in denen code gilt. Global → alle. @param {string} code @returns {Set<number>} */
    orgsWith(code) {
      const out = new Set();
      for (const g of generalGrants) {
        if (g.code !== code) continue;
        const ids = g.scopeOrgId == null ? [...orgs.byId.keys()] : orgs.subtree(g.scopeOrgId);
        for (const id of ids) if (meetsRankRequirements(code, id)) out.add(id);
      }
      return out;
    },

    /** Case-gebundene Delegationen für code. @param {string} code @returns {{ caseId: number, fromUserId: number }[]} */
    delegatedCases(code) {
      return grants.filter((g) => g.caseId != null && g.code === code).map((g) => ({ caseId: Number(g.caseId), fromUserId: Number(g.fromUserId) }));
    },

    /** @param {string} levelCode */
    clearedFor(levelCode) {
      return clearanceRank >= (levels.get(levelCode) ?? Number.POSITIVE_INFINITY);
    },

    /** @param {string[]|string} list  Array oder JSON-Text */
    holdsCompartments(list) {
      const arr = Array.isArray(list) ? list : parseJson(list, []);
      return arr.every((c) => compartments.has(c));
    },

    /** Ist der Benutzer Mitglied von orgId oder einer Unterorganisation davon? @param {number} orgId */
    isMemberWithin(orgId) {
      return memberships.some((m) => orgs.isWithin(m.orgId, orgId));
    },

    /** Organisationen, deren Teilbaum eine Mitgliedschaft enthält (Mitgliedschaften + Vorfahren). */
    memberAncestorOrgIds() {
      const out = new Set();
      for (const m of memberships) for (const a of orgs.ancestorsOf(m.orgId)) out.add(a);
      return out;
    },
  };
  return principal;
}

/** @typedef {ReturnType<typeof loadPrincipal>} Principal */

module.exports = { loadPrincipal, ownGrants };
