// @ts-check
'use strict';
/**
 * Haft- und Durchsuchungsbefehle nach der Ausfertigung (WORKFLOWS.md Abschnitt 4).
 *
 *   ISSUED ── start ──► IN_EXECUTION ── report ──► EXECUTED ── acknowledge (Gericht) ──► RETURNED
 *     └──────────────── recall* (Richter, Begründung) ──► RECALLED
 *
 * Sichtbarkeit: Gerichtsakte sichtbar ODER Ausgangsakte sichtbar ODER Mitglied der vollstreckenden Behörde mit
 * WARRANT_VIEW. Die vollstreckende Behörde sieht nur den Haftbefehl und das ausgefertigte Dokument – nie die Akten.
 */
const { z } = require('zod');
const { transaction, now, inList } = require('../../db');
const { forbidden, notFound, conflict } = require('../../http/errors');
const { caseVisibility, canViewCase } = require('../cases/visibility');
const { createDocumentService } = require('../documents/service');
const { createWorkflowEngine } = require('../workflows/engine');
const { orgRef } = require('../users/me');
const { personVisibility } = require('../persons/visibility');

const schemas = {
  report: z.object({
    outcome: z.string().trim().min(3).max(2000),
    details: z.string().trim().min(3).max(20_000),
    measures: z.string().trim().max(10_000).default(''),
  }),
  reason: z.object({ reason: z.string().trim().min(3).max(2000) }),
  list: z.object({
    status: z.enum(['ISSUED', 'IN_EXECUTION', 'EXECUTED', 'RETURNED', 'RECALLED', 'OPEN']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  }),
};

/** @param {import('../../app').AppContext} ctx */
function createWarrantService(ctx) {
  const { db, audit } = ctx;
  const docs = createDocumentService(ctx);
  const wf = createWorkflowEngine(db);

  const flagOn = (code) => Boolean(/** @type {any} */ (db.prepare('SELECT enabled FROM feature_flags WHERE code = ?').get(code))?.enabled);
  const res = (w) => ({ resourceType: 'warrant', resourceId: w.id, resourceOrgId: w.issuing_org_id, resourceLevel: w.security_level, resourceCompartments: [] });
  const event = (caseId, type, actorId, summary, payload = {}) => {
    db.prepare('INSERT INTO case_events (case_id, type, actor_user_id, summary, payload, created_at) VALUES (?,?,?,?,?,?)')
      .run(caseId, type, actorId, summary, JSON.stringify(payload), now());
    db.prepare('UPDATE cases SET updated_at = ? WHERE id = ?').run(now(), caseId);
  };

  function visibility(p, alias = 'w') {
    const court = caseVisibility(db, p, { alias: 'wc' });
    const src = caseVisibility(db, p, { alias: 'ws' });
    const exec = [...p.orgsWith('WARRANT_VIEW')];
    const parts = [
      `EXISTS (SELECT 1 FROM cases wc WHERE wc.id = ${alias}.court_case_id AND ${court.sql})`,
      `EXISTS (SELECT 1 FROM cases ws WHERE ws.id = ${alias}.source_case_id AND ${src.sql})`,
    ];
    const params = [...court.params, ...src.params];
    if (exec.length) { parts.push(`${alias}.executing_org_id IN (${inList(exec)})`); params.push(...exec); }
    return { sql: `((SELECT rank FROM security_levels WHERE code = ${alias}.security_level) <= ? AND (${parts.join(' OR ')}))`, params: [p.clearanceRank, ...params] };
  }

  function loadVisible(p, reqCtx, id) {
    const v = visibility(p);
    const w = /** @type {any} */ (db.prepare(`SELECT w.* FROM warrants w WHERE w.id = ? AND ${v.sql}`).get(id, ...v.params));
    if (w) return w;
    const hidden = /** @type {any} */ (db.prepare('SELECT * FROM warrants WHERE id = ?').get(id));
    if (hidden && reqCtx) audit.write({ ...reqCtx, action: 'WARRANT_ACCESS', outcome: 'DENIED', ...res(hidden) });
    throw notFound();
  }

  function capabilities(p, w) {
    const execOn = flagOn('USMS_WARRANT_EXECUTION');
    const executor = execOn && p.has('WARRANT_EXECUTE', w.executing_org_id);
    const courtSide = canViewCase(db, p, w.court_case_id);
    const app = /** @type {any} */ (db.prepare('SELECT assigned_judge_id FROM applications WHERE id = ?').get(w.application_id));
    return {
      start: executor && w.status === 'ISSUED',
      report: executor && ['ISSUED', 'IN_EXECUTION'].includes(w.status),
      acknowledge: courtSide && w.status === 'EXECUTED' && (p.has('CASE_ASSIGN', w.issuing_org_id) || app?.assigned_judge_id === p.user.id),
      recall: courtSide && ['ISSUED', 'IN_EXECUTION'].includes(w.status) && p.has('WARRANT_RECALL', w.issuing_org_id),
    };
  }

  function detail(p, w) {
    const court = canViewCase(db, p, w.court_case_id);
    const source = canViewCase(db, p, w.source_case_id);
    const visibleDocs = new Set(docs.visibleIds(p, [w.document_id, w.execution_report_document_id].filter(Boolean)));
    const caseRef = (id) => { const c = /** @type {any} */ (db.prepare('SELECT id, case_number FROM cases WHERE id = ?').get(id)); return { id: c.id, caseNumber: c.case_number }; };
    const name = (uid) => (uid ? /** @type {any} */ (db.prepare('SELECT display_name FROM users WHERE id = ?').get(uid))?.display_name : null);
    return {
      id: w.id, warrantNo: w.warrant_no, kind: w.kind, status: w.status, securityLevel: w.security_level,
      subjectName: w.subject_name, offense: w.offense, measure: w.measure,
      subjectPerson: (() => {
        if (!w.subject_person_id) return null;
        const pv = personVisibility(db, p);
        const x = /** @type {any} */ (db.prepare(`SELECT pe.id, pe.full_name, pe.person_no FROM persons pe WHERE pe.id = ? AND ${pv.sql}`).get(w.subject_person_id, ...pv.params));
        return x ? { id: x.id, fullName: x.full_name, personNo: x.person_no } : null;
      })(),
      issuingCourt: orgRef(p.orgs, w.issuing_org_id), executingOrg: orgRef(p.orgs, w.executing_org_id),
      issuedAt: w.issued_at, issuedBy: name(w.issued_by),
      executionStartedAt: w.execution_started_at, executedAt: w.executed_at, executedBy: name(w.executed_by),
      returnedAt: w.returned_at, recalledAt: w.recalled_at, recallReason: w.recall_reason,
      documentId: visibleDocs.has(w.document_id) ? w.document_id : null,
      executionReportDocumentId: w.execution_report_document_id && visibleDocs.has(w.execution_report_document_id) ? w.execution_report_document_id : null,
      courtCase: court ? caseRef(w.court_case_id) : null,
      sourceCase: source ? caseRef(w.source_case_id) : null,
      applicationId: court || source ? w.application_id : null,
      capabilities: capabilities(p, w),
    };
  }

  function requireCap(p, cap, w, reqCtx) {
    if (capabilities(p, w)[cap]) return;
    audit.write({ ...reqCtx, action: `WARRANT_${cap.toUpperCase()}`, outcome: 'DENIED', ...res(w) });
    if (cap !== 'acknowledge' && cap !== 'recall' && !flagOn('USMS_WARRANT_EXECUTION')) {
      throw forbidden('Warrant execution is disabled: its legal basis has not been verified.', 'FEATURE_DISABLED');
    }
    throw w.status === 'RECALLED' ? conflict('This warrant has been recalled.', 'WARRANT_RECALLED') : forbidden();
  }

  const notifyW = (w, userIds, type, title, actorId) => ctx.notify?.toUsers(userIds, { type, title, body: `${w.warrant_no} · ${w.subject_name}`,
    link: `/app/warrants/${w.id}`, subjectType: 'warrant', subjectId: w.id, level: w.security_level }, { exceptUserId: actorId });

  const both = (w, type, actorId, summary, payload) => {
    event(w.court_case_id, type, actorId, summary, payload);
    event(w.source_case_id, type, actorId, summary, payload);
  };

  return {
    schemas,
    visibility,

    list(p, query) {
      const f = schemas.list.parse(query);
      const v = visibility(p);
      const where = [v.sql];
      const params = [...v.params];
      if (f.status === 'OPEN') where.push("w.status IN ('ISSUED','IN_EXECUTION')");
      else if (f.status) { where.push('w.status = ?'); params.push(f.status); }
      const w = where.join(' AND ');
      const total = Number(/** @type {any} */ (db.prepare(`SELECT COUNT(*) n FROM warrants w WHERE ${w}`).get(...params)).n);
      const rows = db.prepare(`SELECT w.* FROM warrants w WHERE ${w} ORDER BY w.issued_at DESC, w.id DESC LIMIT ? OFFSET ?`).all(...params, f.limit, f.offset);
      return { total, items: rows.map((r) => detail(p, r)) };
    },

    get(p, reqCtx, id) {
      const w = loadVisible(p, reqCtx, id);
      audit.write({ ...reqCtx, action: 'WARRANT_VIEW', ...res(w) });
      return detail(p, w);
    },

    start(p, reqCtx, id) {
      const w = loadVisible(p, reqCtx, id);
      requireCap(p, 'start', w, reqCtx);
      transaction(db, () => {
        db.prepare("UPDATE warrants SET status = 'IN_EXECUTION', execution_started_at = ? WHERE id = ?").run(now(), id);
        both(w, 'WARRANT_EXECUTION_STARTED', p.user.id, `Execution of warrant ${w.warrant_no} started`, { warrantId: id });
        audit.write({ ...reqCtx, action: 'WARRANT_EXECUTION_START', ...res(w) });
      });
      return detail(p, loadVisible(p, reqCtx, id));
    },

    /** Vollstreckung melden: Vollstreckungsbericht als Dokument der vollstreckenden Behörde, freigegeben für Gericht und Antragsteller. */
    report(p, reqCtx, id, input) {
      const d = schemas.report.parse(input);
      const w = loadVisible(p, reqCtx, id);
      requireCap(p, 'report', w, reqCtx);
      transaction(db, () => {
        const report = docs.create(p, reqCtx, {
          typeCode: 'REPORT', orgId: w.executing_org_id, title: `Execution report – warrant ${w.warrant_no}`,
          content: { sachverhalt: d.details, massnahmen: d.measures, ergebnis: d.outcome }, securityLevel: w.security_level,
        });
        docs.shareWithOrg(p, reqCtx, report.id, w.issuing_org_id, `Execution report for warrant ${w.warrant_no}`);
        const app = /** @type {any} */ (db.prepare('SELECT applicant_org_id FROM applications WHERE id = ?').get(w.application_id));
        docs.shareWithOrg(p, reqCtx, report.id, app.applicant_org_id, `Execution report for warrant ${w.warrant_no}`);
        const ts = now();
        db.prepare(`UPDATE warrants SET status = 'EXECUTED', executed_at = ?, executed_by = ?, execution_report_document_id = ?,
          execution_started_at = COALESCE(execution_started_at, ?) WHERE id = ?`).run(ts, p.user.id, report.id, ts, id);
        both(w, 'WARRANT_EXECUTED', p.user.id, `Warrant ${w.warrant_no} executed – report ${report.docNumber}`, { warrantId: id, documentId: report.id });
        audit.write({ ...reqCtx, action: 'WARRANT_EXECUTE', ...res(w), details: { reportDocumentId: report.id } });
        const a = /** @type {any} */ (db.prepare('SELECT applicant_user_id, assigned_judge_id FROM applications WHERE id = ?').get(w.application_id));
        notifyW(w, [a.assigned_judge_id, a.applicant_user_id, ...(ctx.notify?.usersWith(w.issuing_org_id, 'CASE_ASSIGN') ?? [])], 'WARRANT_EXECUTED', `Warrant executed: ${w.warrant_no}`, p.user.id);
      });
      return detail(p, loadVisible(p, reqCtx, id));
    },

    acknowledge(p, reqCtx, id) {
      const w = loadVisible(p, reqCtx, id);
      requireCap(p, 'acknowledge', w, reqCtx);
      transaction(db, () => {
        db.prepare("UPDATE warrants SET status = 'RETURNED', returned_at = ? WHERE id = ?").run(now(), id);
        const inst = wf.instanceFor('application', w.application_id);
        if (inst?.state === 'ISSUED') {
          wf.apply(inst, 'close', { actorUserId: null, bySystem: true });
          db.prepare("UPDATE applications SET status = 'CLOSED', updated_at = ? WHERE id = ?").run(now(), w.application_id);
        }
        both(w, 'WARRANT_RETURNED', p.user.id, `Warrant ${w.warrant_no} returned to the court`, { warrantId: id });
        audit.write({ ...reqCtx, action: 'WARRANT_RETURN', ...res(w) });
      });
      return detail(p, loadVisible(p, reqCtx, id));
    },

    recall(p, reqCtx, id, input) {
      const { reason } = schemas.reason.parse(input);
      const w = loadVisible(p, reqCtx, id);
      if (!['ISSUED', 'IN_EXECUTION'].includes(w.status)) throw conflict('Only active warrants can be recalled.', 'INVALID_TRANSITION');
      requireCap(p, 'recall', w, reqCtx);
      transaction(db, () => {
        db.prepare("UPDATE warrants SET status = 'RECALLED', recalled_at = ?, recall_reason = ? WHERE id = ?").run(now(), reason, id);
        both(w, 'WARRANT_RECALLED', p.user.id, `Warrant ${w.warrant_no} recalled`, { warrantId: id, reason });
        audit.write({ ...reqCtx, action: 'WARRANT_RECALL', ...res(w), details: { reason } });
        notifyW(w, ctx.notify?.usersWith(w.executing_org_id, 'WARRANT_EXECUTE') ?? [], 'WARRANT_RECALLED', `Warrant recalled – do not execute: ${w.warrant_no}`, p.user.id);
      });
      return detail(p, loadVisible(p, reqCtx, id));
    },
  };
}

module.exports = { createWarrantService };
