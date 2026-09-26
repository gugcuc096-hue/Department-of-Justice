// @ts-check
'use strict';
/**
 * Sichtbarkeit von Dokumenten (SECURITY_MODEL.md Abschnitt 4):
 *   - DOCUMENT_VIEW irgendwo
 *   - Clearance ≥ Level des Dokuments, alle Compartments des Dokuments gehalten
 *   - Dokument in einer Akte: Akte sichtbar (gleiches Prädikat wie bei Akten – versiegelt = unsichtbar)
 *   - Dokument ohne Akte: Ersteller
 *   - zusätzlich (mit oder ohne Akte): ausdrückliche Freigabe an Person oder Organisation – so sieht z. B. das Gericht
 *     nur die einem Antrag beigefügten Dokumente und der USMS nur den ausgefertigten Haftbefehl, nicht die Akte
 *   - gelöschte Entwürfe sind für niemanden sichtbar
 * Ein Dokument ist nie lockerer geschützt als seine Akte (erzwungen beim Anlegen).
 */
const { inList } = require('../../db');
const { caseVisibility } = require('../cases/visibility');

/**
 * @param {import('../../db').Database} db
 * @param {import('../authz/principal').Principal} p
 * @param {{ alias?: string }} [opts]
 */
function documentVisibility(db, p, opts = {}) {
  const d = opts.alias ?? 'd';
  if (!p.hasAnywhere('DOCUMENT_VIEW')) return { sql: '0', params: [] };
  const ts = new Date().toISOString();
  const cv = caseVisibility(db, p, { alias: 'vdc' });

  const orgIds = new Set();
  for (const m of p.memberships) {
    if (!p.has('DOCUMENT_VIEW', m.orgId)) continue;
    for (const a of p.orgs.ancestorsOf(m.orgId)) orgIds.add(a);
  }
  const comps = [...p.compartments];
  const compClause = comps.length
    ? `NOT EXISTS (SELECT 1 FROM document_compartments vx WHERE vx.document_id = ${d}.id AND vx.compartment_code NOT IN (${inList(comps)}))`
    : `NOT EXISTS (SELECT 1 FROM document_compartments vx WHERE vx.document_id = ${d}.id)`;

  const grants = [
    `EXISTS (SELECT 1 FROM document_access vu WHERE vu.document_id = ${d}.id AND vu.subject_type = 'USER' AND vu.subject_id = ?
      AND vu.revoked_at IS NULL AND (vu.expires_at IS NULL OR vu.expires_at > ?))`,
  ];
  const grantParams = [p.user.id, ts];
  if (orgIds.size) {
    grants.push(`EXISTS (SELECT 1 FROM document_access vo WHERE vo.document_id = ${d}.id AND vo.subject_type = 'ORG'
      AND vo.subject_id IN (${inList([...orgIds])}) AND vo.revoked_at IS NULL AND (vo.expires_at IS NULL OR vo.expires_at > ?))`);
    grantParams.push(...orgIds, ts);
  }

  const sql = `(${d}.status <> 'DELETED'
    AND (SELECT rank FROM security_levels WHERE code = ${d}.security_level) <= ?
    AND ${compClause}
    AND ((${d}.case_id IS NOT NULL AND EXISTS (SELECT 1 FROM cases vdc WHERE vdc.id = ${d}.case_id AND ${cv.sql}))
      OR (${d}.case_id IS NULL AND ${d}.created_by = ?)
      OR ${grants.join(' OR ')}))`;
  return { sql, params: [p.clearanceRank, ...comps, ...cv.params, p.user.id, ...grantParams] };
}

module.exports = { documentVisibility };
