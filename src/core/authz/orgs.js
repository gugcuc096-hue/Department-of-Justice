// @ts-check
'use strict';
/**
 * Organisationsbaum (ADR-005). Klein (Dutzende Knoten) → pro Anfrage komplett geladen.
 */

/**
 * @typedef {{ id: number, parent_id: number|null, kind: string, code: string, name: string, short_name: string,
 *   subtitle: string, brand_code: string|null, sort_order: number, is_active: number }} OrgRow
 */

/** @param {import('../../db').Database} db */
function loadOrgTree(db) {
  const rows = /** @type {OrgRow[]} */ (/** @type {unknown} */ (db.prepare('SELECT * FROM organizations ORDER BY sort_order, id').all()));
  /** @type {Map<number, OrgRow>} */
  const byId = new Map(rows.map((r) => [r.id, r]));
  /** @type {Map<string, OrgRow>} */
  const byCode = new Map(rows.map((r) => [r.code, r]));
  /** @type {Map<number, number[]>} */
  const children = new Map();
  for (const r of rows) {
    if (r.parent_id == null) continue;
    if (!children.has(r.parent_id)) children.set(r.parent_id, []);
    children.get(r.parent_id).push(r.id);
  }

  /** Vorfahren inklusive des Knotens selbst, vom Knoten zur Wurzel. @param {number} id */
  function ancestorsOf(id) {
    const out = [];
    let cur = byId.get(id);
    const seen = new Set();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.push(cur.id);
      cur = cur.parent_id == null ? undefined : byId.get(cur.parent_id);
    }
    return out;
  }

  /** Teilbaum inklusive des Knotens selbst. @param {number} id */
  function subtree(id) {
    const out = [];
    const stack = [id];
    while (stack.length) {
      const n = stack.pop();
      if (!byId.has(n) || out.includes(n)) continue;
      out.push(n);
      stack.push(...(children.get(n) ?? []));
    }
    return out;
  }

  /**
   * Liegt orgId im Scope? scopeOrgId null = global.
   * @param {number|null|undefined} orgId @param {number|null} scopeOrgId
   */
  function isWithin(orgId, scopeOrgId) {
    if (scopeOrgId == null) return true;
    if (orgId == null) return false;
    return ancestorsOf(orgId).includes(scopeOrgId);
  }

  /** @param {number} id */
  function institutionOf(id) {
    return ancestorsOf(id).map((a) => byId.get(a)).find((o) => o.kind === 'INSTITUTION') ?? null;
  }

  return { rows, byId, byCode, children, ancestorsOf, subtree, isWithin, institutionOf };
}

/** @typedef {ReturnType<typeof loadOrgTree>} OrgTree */

module.exports = { loadOrgTree };
