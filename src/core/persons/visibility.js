// @ts-check
'use strict';
/**
 * Sichtbarkeit von Personen- und Unternehmensstammdaten (prompt.txt 6.10).
 *
 * Stammdaten (Name, Geburtsdatum, Aliasse) sind für alle mit PERSON_VIEW bzw. COMPANY_VIEW sichtbar, sofern
 * Clearance und Compartments passen. Personen, die z. B. nur aus dem Personenstandsregister bekannt sind, tragen das
 * Compartment REGISTRY und bleiben damit für alle anderen unsichtbar – auch in Suche und Zählern.
 *
 * Die BEZIEHUNGEN einer Person (Akten, Haftbefehle, Lizenzen …) sind nicht Teil dieser Regel: jede einzelne
 * Beziehung wird gegen die Sichtbarkeit ihres Gegenstands geprüft (persons/service.js).
 */
const { inList } = require('../../db');

/**
 * @param {import('../../db').Database} _db
 * @param {import('../authz/principal').Principal} p
 * @param {string} [alias]
 */
function personVisibility(_db, p, alias = 'pe') {
  if (!p.hasAnywhere('PERSON_VIEW')) return { sql: '0', params: [] };
  const comps = [...p.compartments];
  const compClause = comps.length
    ? `NOT EXISTS (SELECT 1 FROM person_compartments pvc WHERE pvc.person_id = ${alias}.id AND pvc.compartment_code NOT IN (${inList(comps)}))`
    : `NOT EXISTS (SELECT 1 FROM person_compartments pvc WHERE pvc.person_id = ${alias}.id)`;
  return {
    sql: `((SELECT rank FROM security_levels WHERE code = ${alias}.security_level) <= ? AND ${compClause})`,
    params: [p.clearanceRank, ...comps],
  };
}

/**
 * @param {import('../../db').Database} _db
 * @param {import('../authz/principal').Principal} p
 * @param {string} [alias]
 */
function companyVisibility(_db, p, alias = 'co') {
  if (!p.hasAnywhere('COMPANY_VIEW')) return { sql: '0', params: [] };
  return { sql: `((SELECT rank FROM security_levels WHERE code = ${alias}.security_level) <= ?)`, params: [p.clearanceRank] };
}

module.exports = { personVisibility, companyVisibility };
