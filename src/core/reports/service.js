// @ts-check
'use strict';
/**
 * Reports und Exporte (prompt.txt 6.12).
 *
 * - Reports sind Auswertungen über dieselben Sichtbarkeitsprädikate wie Listen: jede Zahl entsteht nur aus Objekten,
 *   die der Benutzer sehen darf. Voraussetzung ist REPORT_VIEW; einzelne Reports verlangen zusätzlich die
 *   fachliche Permission (Personal: USER_VIEW, Audit: AUDIT_VIEW).
 * - Export (CSV) verlangt REPORT_EXPORT und wird auditiert. Aktenexporte verlangen CASE_EXPORT im Scope der Akte.
 * - Fachmodule melden eigene Reports über ctx.reportProviders an.
 */
const { z } = require('zod');
const { inList, parseJson } = require('../../db');
const { forbidden, notFound } = require('../../http/errors');
const { caseVisibility } = require('../cases/visibility');
const { createCaseService } = require('../cases/service');
const { createDocumentService } = require('../documents/service');
const { createApplicationService } = require('../applications/service');
const { createWarrantService } = require('../applications/warrants');
const { createHearingService } = require('../schedule/hearings');
const { createDeadlineService } = require('../schedule/deadlines');
const { createEvidenceService } = require('../evidence/service');
const { createAuditService, toCsv } = require('../audit/service');
const { orgRef } = require('../users/me');

const iso = z.string().datetime({ offset: true });
const schemas = {
  filter: z.object({ orgId: z.coerce.number().int().positive().optional(), from: iso.optional(), to: iso.optional() }),
};

/**
 * @typedef {{ orgId?: number, from?: string, to?: string }} ReportFilter
 * @typedef {{ kind: string, label: string, description: string, allowed: (p: any) => boolean,
 *   run: (p: any, f: ReportFilter) => { columns: { key: string, label: string }[], rows: any[] } }} ReportProvider
 */

/** @param {import('../../app').AppContext} ctx */
function createReportService(ctx) {
  const { db, audit } = ctx;
  const cases = createCaseService(ctx);
  const docs = createDocumentService(ctx);
  const apps = createApplicationService(ctx);
  const warrants = createWarrantService(ctx);
  const hearings = createHearingService(ctx);
  const deadlines = createDeadlineService(ctx);
  const evidence = createEvidenceService(ctx);
  const auditSvc = createAuditService(ctx);

  const orgName = (p, id) => (id ? orgRef(p.orgs, Number(id))?.shortName ?? String(id) : '—');
  /** Zusatzbedingungen Organisation/Zeitraum für eine Spalte. */
  const scope = (p, f, orgCol, timeCol) => {
    const w = [];
    const params = [];
    if (f.orgId && orgCol) { const sub = p.orgs.subtree(f.orgId); w.push(`${orgCol} IN (${inList(sub)})`); params.push(...sub); }
    if (f.from && timeCol) { w.push(`${timeCol} >= ?`); params.push(new Date(f.from).toISOString()); }
    if (f.to && timeCol) { w.push(`${timeCol} <= ?`); params.push(new Date(f.to).toISOString()); }
    return { sql: w.length ? ` AND ${w.join(' AND ')}` : '', params };
  };
  const reportView = (p) => p.hasAnywhere('REPORT_VIEW');

  /** @type {ReportProvider[]} */
  const core = [
    {
      kind: 'cases', label: 'Cases', description: 'Cases by office, type and status.', allowed: reportView,
      run(p, f) {
        const v = caseVisibility(db, p);
        const s = scope(p, f, 'c.owning_org_id', 'c.created_at');
        const rows = db.prepare(`SELECT c.owning_org_id AS org, t.name AS type, c.status, COUNT(*) AS n FROM cases c JOIN case_types t ON t.code = c.type_code
          WHERE ${v.sql}${s.sql} GROUP BY c.owning_org_id, t.name, c.status ORDER BY org, type, c.status`).all(...v.params, ...s.params);
        return { columns: [{ key: 'office', label: 'Office' }, { key: 'type', label: 'Type' }, { key: 'status', label: 'Status' }, { key: 'count', label: 'Cases' }],
          rows: rows.map((r) => ({ office: orgName(p, r.org), type: r.type, status: r.status, count: Number(r.n) })) };
      },
    },
    {
      kind: 'hearings', label: 'Hearings', description: 'Hearings by court and status (period = start time).', allowed: reportView,
      run(p, f) {
        const v = hearings.visibility(p, 'hr');
        const s = scope(p, f, 'hr.court_org_id', 'hr.starts_at');
        const rows = db.prepare(`SELECT hr.court_org_id AS org, hr.kind, hr.status, COUNT(*) n FROM hearings hr WHERE ${v.sql}${s.sql}
          GROUP BY hr.court_org_id, hr.kind, hr.status ORDER BY org`).all(...v.params, ...s.params);
        return { columns: [{ key: 'court', label: 'Court' }, { key: 'kind', label: 'Kind' }, { key: 'status', label: 'Status' }, { key: 'count', label: 'Hearings' }],
          rows: rows.map((r) => ({ court: orgName(p, r.org), kind: r.kind, status: r.status, count: Number(r.n) })) };
      },
    },
    {
      kind: 'warrants', label: 'Warrants', description: 'Issued warrants by kind and status (period = issue date).', allowed: reportView,
      run(p, f) {
        const v = warrants.visibility(p, 'w');
        const s = scope(p, f, 'w.issuing_org_id', 'w.issued_at');
        const rows = db.prepare(`SELECT w.issuing_org_id AS org, w.executing_org_id AS ex, w.kind, w.status, COUNT(*) n FROM warrants w WHERE ${v.sql}${s.sql}
          GROUP BY w.issuing_org_id, w.executing_org_id, w.kind, w.status`).all(...v.params, ...s.params);
        return { columns: [{ key: 'court', label: 'Issuing court' }, { key: 'executing', label: 'Executing agency' }, { key: 'kind', label: 'Kind' }, { key: 'status', label: 'Status' }, { key: 'count', label: 'Warrants' }],
          rows: rows.map((r) => ({ court: orgName(p, r.org), executing: orgName(p, r.ex), kind: r.kind, status: r.status, count: Number(r.n) })) };
      },
    },
    {
      kind: 'workflows', label: 'Court applications (workflows)', description: 'Applications by kind and workflow state.', allowed: reportView,
      run(p, f) {
        const v = apps.visibility(p, 'a');
        const s = scope(p, f, 'a.target_org_id', 'a.created_at');
        const rows = db.prepare(`SELECT a.applicant_org_id AS src, a.target_org_id AS dst, a.kind, a.status, COUNT(*) n FROM applications a WHERE ${v.sql}${s.sql}
          GROUP BY a.applicant_org_id, a.target_org_id, a.kind, a.status`).all(...v.params, ...s.params);
        return { columns: [{ key: 'applicant', label: 'Applicant office' }, { key: 'court', label: 'Court' }, { key: 'kind', label: 'Kind' }, { key: 'state', label: 'State' }, { key: 'count', label: 'Applications' }],
          rows: rows.map((r) => ({ applicant: orgName(p, r.src), court: orgName(p, r.dst), kind: r.kind, state: r.status, count: Number(r.n) })) };
      },
    },
    {
      kind: 'deadlines', label: 'Deadlines', description: 'Deadlines by office and state (overdue computed at report time).', allowed: reportView,
      run(p, f) {
        const v = deadlines.visibility(p, 'dl');
        const s = scope(p, f, 'c.owning_org_id', 'dl.due_at');
        const nowIso = new Date().toISOString();
        const rows = db.prepare(`SELECT c.owning_org_id AS org,
            CASE WHEN dl.status = 'OPEN' AND dl.due_at < ? THEN 'OVERDUE' ELSE dl.status END AS state, COUNT(*) n
          FROM deadlines dl JOIN cases c ON c.id = dl.case_id WHERE ${v.sql}${s.sql} GROUP BY org, state`).all(nowIso, ...v.params, ...s.params);
        return { columns: [{ key: 'office', label: 'Office' }, { key: 'state', label: 'State' }, { key: 'count', label: 'Deadlines' }],
          rows: rows.map((r) => ({ office: orgName(p, r.org), state: r.state, count: Number(r.n) })) };
      },
    },
    {
      kind: 'evidence', label: 'Evidence', description: 'Evidence items by category and status.', allowed: reportView,
      run(p, f) {
        const v = evidence.visibility(p, 'e');
        const s = scope(p, f, 'c.owning_org_id', 'e.collected_at');
        const rows = db.prepare(`SELECT c.owning_org_id AS org, e.category, e.status, COUNT(*) n FROM evidence e JOIN cases c ON c.id = e.case_id
          WHERE ${v.sql}${s.sql} GROUP BY org, e.category, e.status`).all(...v.params, ...s.params);
        return { columns: [{ key: 'office', label: 'Office' }, { key: 'category', label: 'Category' }, { key: 'status', label: 'Status' }, { key: 'count', label: 'Items' }],
          rows: rows.map((r) => ({ office: orgName(p, r.org), category: r.category, status: r.status, count: Number(r.n) })) };
      },
    },
    {
      kind: 'personnel', label: 'Personnel', description: 'Active members by organization and rank (organizations where you may view users).',
      allowed: (p) => reportView(p) && p.hasAnywhere('USER_VIEW'),
      run(p, f) {
        let orgs = [...p.orgsWith('USER_VIEW')];
        if (f.orgId) { const sub = new Set(p.orgs.subtree(f.orgId)); orgs = orgs.filter((o) => sub.has(o)); }
        // Mitgliedschaften in abgeschotteten Bereichen nur mit dem jeweiligen Compartment (wie im Personalverzeichnis)
        const hidden = new Set(db.prepare('SELECT code, owner_org_id FROM compartments').all()
          .filter((c) => c.owner_org_id && !p.compartments.has(String(c.code))).flatMap((c) => p.orgs.subtree(Number(c.owner_org_id))));
        orgs = orgs.filter((o) => !hidden.has(o));
        const rows = orgs.length ? db.prepare(`SELECT m.org_id AS org, r.name AS rank, r.level, COUNT(*) n FROM memberships m JOIN users u ON u.id = m.user_id
          LEFT JOIN ranks r ON r.id = m.rank_id WHERE u.status = 'ACTIVE' AND m.org_id IN (${inList(orgs)}) GROUP BY m.org_id, r.id ORDER BY m.org_id, r.level DESC`).all(...orgs) : [];
        return { columns: [{ key: 'organization', label: 'Organization' }, { key: 'rank', label: 'Rank' }, { key: 'count', label: 'Active members' }],
          rows: rows.map((r) => ({ organization: orgName(p, r.org), rank: r.rank ?? '(no rank)', count: Number(r.n) })) };
      },
    },
    {
      kind: 'audit', label: 'Audit events', description: 'Audit events by action and outcome (entries you may view).',
      allowed: (p) => reportView(p) && p.hasAnywhere('AUDIT_VIEW'),
      run(p, f) {
        const v = auditSvc.visibility(p, 'al');
        const s = scope(p, f, 'COALESCE(al.resource_org_id, al.active_org_id)', 'al.ts');
        const rows = db.prepare(`SELECT al.action, al.outcome, COUNT(*) n FROM audit_log al WHERE ${v.sql}${s.sql} GROUP BY al.action, al.outcome ORDER BY n DESC`)
          .all(...v.params, ...s.params);
        return { columns: [{ key: 'action', label: 'Action' }, { key: 'outcome', label: 'Outcome' }, { key: 'count', label: 'Events' }],
          rows: rows.map((r) => ({ action: r.action, outcome: r.outcome, count: Number(r.n) })) };
      },
    },
  ];

  const providers = () => [...core, ...(ctx.reportProviders ?? [])];
  const find = (p, kind) => {
    const prov = providers().find((x) => x.kind === kind);
    if (!prov) throw notFound();
    if (!prov.allowed(p)) throw forbidden();
    return prov;
  };

  return {
    list(p) {
      return providers().filter((x) => x.allowed(p)).map((x) => ({ kind: x.kind, label: x.label, description: x.description }));
    },

    run(p, reqCtx, kind, query) {
      const f = schemas.filter.parse(query);
      const prov = find(p, kind);
      const out = prov.run(p, f);
      audit.write({ ...reqCtx, action: 'REPORT_VIEW', details: { kind, filter: f } });
      return { kind, label: prov.label, filter: f, ...out, total: out.rows.reduce((n, r) => n + (Number(r.count) || 0), 0), generatedAt: new Date().toISOString(), canExport: p.hasAnywhere('REPORT_EXPORT') };
    },

    exportCsv(p, reqCtx, kind, query) {
      if (!p.hasAnywhere('REPORT_EXPORT')) throw forbidden();
      const f = schemas.filter.parse(query);
      const prov = find(p, kind);
      const out = prov.run(p, f);
      audit.write({ ...reqCtx, action: 'REPORT_EXPORT', details: { kind, filter: f, rows: out.rows.length } });
      return toCsv(out.columns.map((c) => c.label), out.rows.map((r) => out.columns.map((c) => r[c.key])));
    },

    /**
     * Aktenexport (JSON): Stammdaten, Beteiligte, Timeline, sichtbare Dokumente mit aktuellem Inhalt, Beweismittel,
     * Termine, Fristen, Anträge. Verlangt CASE_EXPORT im Scope der Akte; Stufe und Compartments gelten über die
     * Sichtbarkeitsprädikate der einzelnen Teile.
     */
    exportCase(p, reqCtx, caseId) {
      const c = cases.loadVisible(p, reqCtx, caseId);
      if (!p.has('CASE_EXPORT', c.owning_org_id)) {
        audit.write({ ...reqCtx, action: 'CASE_EXPORT', outcome: 'DENIED', resourceType: 'case', resourceId: c.id, resourceOrgId: c.owning_org_id, resourceLevel: c.security_level });
        throw forbidden();
      }
      const comps = db.prepare('SELECT compartment_code c FROM case_compartments WHERE case_id = ?').all(c.id).map((r) => String(r.c));
      const docList = docs.list(p, { caseId: c.id, limit: 100 }).items;
      const documents = docList.map((d) => {
        const row = /** @type {any} */ (db.prepare('SELECT * FROM documents WHERE id = ?').get(d.id));
        const v = /** @type {any} */ (db.prepare('SELECT * FROM document_versions WHERE document_id = ? AND version = ?').get(d.id, row.current_version));
        return { ...d, currentVersion: { version: v.version, sha256: v.sha256, content: parseJson(v.content, {}) },
          signatures: docs.signatures(row).map((s) => ({ signer: s.signer, signedAt: s.signedAt, version: s.version, status: s.status })) };
      });
      const bundle = {
        exportedAt: new Date().toISOString(), exportedBy: p.user.display_name,
        notice: 'Roleplay platform export. Contains only content visible to the exporting user.',
        case: (({ capabilities: _c, access: _a, transferTargets: _t, ...rest }) => rest)(/** @type {any} */ (cases.get(p, reqCtx, c.id))),
        timeline: cases.timeline(p, reqCtx, c.id),
        documents,
        evidence: evidence.list(p, { caseId: c.id, limit: 100 }).items,
        hearings: hearings.list(p, { caseId: c.id }).items,
        deadlines: deadlines.list(p, { caseId: c.id, state: 'all' }).items,
        applications: apps.list(p, { sourceCaseId: c.id, limit: 100 }).items.concat(apps.list(p, { courtCaseId: c.id, limit: 100 }).items),
      };
      audit.write({ ...reqCtx, action: 'CASE_EXPORT', resourceType: 'case', resourceId: c.id, resourceOrgId: c.owning_org_id, resourceLevel: c.security_level,
        resourceCompartments: comps, details: { documents: documents.length } });
      return { filename: `${c.case_number}-export.json`, bundle };
    },
  };
}

module.exports = { createReportService };
