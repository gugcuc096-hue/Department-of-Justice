// @ts-check
'use strict';
/**
 * Globale Suche (prompt.txt 6.9, SECURITY_MODEL.md 7).
 *
 * - Volltext über den FTS5-Index `search_index` (Trigger halten ihn aktuell, Migration 008 ff.).
 * - Jeder Treffertyp hat einen Provider mit dem Sichtbarkeitsprädikat seines Moduls. Treffer, Trefferzahlen und
 *   Ranking entstehen in EINER SQL-Abfrage: FTS-Treffer ⋈ Quelltabelle ∧ Sichtbarkeit. Unsichtbare Objekte
 *   erscheinen weder als Treffer noch in einer Zahl – ihre Existenz bleibt verborgen.
 * - Die Eingabe wird in Token zerlegt und als Präfix-Suche formuliert; FTS-Syntax des Benutzers wird nie
 *   ungeprüft an SQLite weitergegeben.
 *
 * Provider melden sich über ctx.searchProviders an: { type, label, table, alias, visibility(p) → {sql, params}, map(row) }.
 */
const { z } = require('zod');

const schemas = {
  query: z.object({
    q: z.string().trim().min(2).max(120),
    type: z.string().max(40).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(8),
  }),
};

/** Benutzereingabe → sichere FTS5-Abfrage (alle Token müssen vorkommen, jeweils als Präfix). */
function ftsQuery(input) {
  const tokens = String(input).split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 8);
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

/** @param {import('../../app').AppContext} ctx */
function createSearchService(ctx) {
  const { db, audit } = ctx;

  function searchType(p, prov, match, limit) {
    const v = prov.visibility(p);
    if (v.sql === '0') return { total: 0, items: [] };
    const a = prov.alias;
    const from = `FROM search_index si JOIN ${prov.table} ${a} ON ${a}.id = si.resource_id
      WHERE search_index MATCH ? AND si.resource_type = ? AND ${v.sql}`;
    const params = [match, prov.type, ...v.params];
    const total = Number(/** @type {any} */ (db.prepare(`SELECT COUNT(*) n ${from}`).get(...params)).n);
    if (!total) return { total: 0, items: [] };
    const rows = db.prepare(`SELECT ${a}.* ${from} ORDER BY bm25(search_index) LIMIT ?`).all(...params, limit);
    return { total, items: rows.map((r) => prov.map(p, r)) };
  }

  return {
    schemas,

    /** Welche Treffertypen stehen p überhaupt zur Verfügung? (für Filter in der Oberfläche) */
    types(p) {
      return (ctx.searchProviders ?? []).filter((prov) => prov.visibility(p).sql !== '0').map((prov) => ({ type: prov.type, label: prov.label }));
    },

    search(p, reqCtx, query) {
      const f = schemas.query.parse(query);
      const match = ftsQuery(f.q);
      const providers = (ctx.searchProviders ?? []).filter((prov) => !f.type || prov.type === f.type);
      if (!match) return { query: f.q, total: 0, groups: [] };
      const groups = [];
      let total = 0;
      for (const prov of providers) {
        const r = searchType(p, prov, match, f.type ? Math.max(f.limit, 25) : f.limit);
        if (!r.total) continue;
        total += r.total;
        groups.push({ type: prov.type, label: prov.label, total: r.total, items: r.items });
      }
      audit.write({ ...reqCtx, action: 'SEARCH', details: { q: f.q, type: f.type ?? null, results: total } });
      return { query: f.q, total, groups };
    },
  };
}

module.exports = { createSearchService, ftsQuery };
