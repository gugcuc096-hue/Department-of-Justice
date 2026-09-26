// @ts-check
'use strict';
/**
 * Dashboard-Framework (prompt.txt 9.4).
 *
 * Das Dashboard richtet sich nach dem aktiven Bereich (Department Switcher): USMS, Prosecution, Judiciary, SID,
 * DCLI, Registry, US-SJA, Constitutional Court. Jede Kennzahl ist ein Widget, das
 *   - nur für bestimmte Bereiche gilt (kinds),
 *   - ausschließlich aus serverseitig autorisiert gefilterten Daten rechnet (Sichtbarkeitsprädikate der Module),
 *   - auf den aktiven Bereich (Teilbaum der aktiven Organisation) beschränkt ist.
 * Das US-SJA-Dashboard zeigt keine Informationen aus anderen Bereichen (auch keine globalen Zähler).
 * Fachmodule melden weitere Widgets über ctx.dashboardWidgets an.
 */
const { inList } = require('../../db');
const { caseVisibility } = require('../cases/visibility');
const { documentVisibility } = require('../documents/visibility');
const { createApplicationService } = require('../applications/service');
const { createWarrantService } = require('../applications/warrants');
const { createHearingService } = require('../schedule/hearings');
const { createDeadlineService } = require('../schedule/deadlines');
const { createRequestService } = require('../requests/service');
const { orgRef } = require('../users/me');

const KINDS = /** @type {const} */ (['USMS', 'PROSECUTION', 'JUDICIARY', 'SID', 'DCLI', 'REGISTRY', 'USSJA', 'CONSTITUTIONAL', 'GENERAL']);
const TITLES = {
  USMS: 'United States Marshals Service', PROSECUTION: 'Prosecution', JUDICIARY: 'Judiciary', SID: 'Special Investigations Division',
  DCLI: 'Commercial Licensing & Investigations', REGISTRY: 'Registry Office', USSJA: 'US-SJA', CONSTITUTIONAL: 'Constitutional Court', GENERAL: 'Overview',
};

/**
 * @typedef {{ p: any, scope: number[], kind: string, now: string }} WidgetContext
 * @typedef {{ id: string, label: string, kinds: string[]|'*', order?: number,
 *   compute: (c: WidgetContext) => ({ value: number, link?: string, tone?: 'warn'|'ok'|'info', hint?: string }|null) }} Widget
 */

/** Dashboard-Art aus der aktiven Organisation. @param {any} orgs @param {number|null} orgId */
function dashboardKind(orgs, orgId) {
  if (!orgId) return 'GENERAL';
  const codes = orgs.ancestorsOf(orgId).map((id) => orgs.byId.get(id)?.code);
  const map = [['USSJA', 'USSJA'], ['REG', 'REGISTRY'], ['DCLI', 'DCLI'], ['SID', 'SID'], ['CC', 'CONSTITUTIONAL'],
    ['PROSECUTION', 'PROSECUTION'], ['JUDICIARY', 'JUDICIARY'], ['USMS', 'USMS']];
  for (const [code, kind] of map) if (codes.includes(code)) return kind;
  return 'GENERAL';
}

/** @param {import('../../app').AppContext} ctx */
function createDashboardService(ctx) {
  const { db } = ctx;
  const apps = createApplicationService(ctx);
  const warrants = createWarrantService(ctx);
  const hearings = createHearingService(ctx);
  const deadlines = createDeadlineService(ctx);
  const requests = createRequestService(ctx);
  const count = (sql, params) => Number(/** @type {any} */ (db.prepare(sql).get(...params)).n);
  const ALL_BUT_SJA = KINDS.filter((k) => k !== 'USSJA');

  /** @type {Widget[]} */
  const core = [
    { id: 'cases-open', label: 'Open cases in this area', kinds: '*', order: 10, compute: ({ p, scope }) => {
      if (!p.hasAnywhere('CASE_VIEW') && !p.hasAnywhere('CASE_VIEW_ORG')) return null;
      const v = caseVisibility(db, p);
      return { value: count(`SELECT COUNT(*) n FROM cases c WHERE ${v.sql} AND c.status IN ('OPEN','ACTIVE') AND c.owning_org_id IN (${inList(scope)})`, [...v.params, ...scope]), link: '/app/cases?status=OPEN_OR_ACTIVE' };
    } },
    { id: 'cases-mine', label: 'My open cases', kinds: '*', order: 11, compute: ({ p, scope }) => {
      if (!p.hasAnywhere('CASE_VIEW')) return null;
      const v = caseVisibility(db, p);
      return { value: count(`SELECT COUNT(*) n FROM cases c WHERE ${v.sql} AND c.status IN ('OPEN','ACTIVE') AND c.owning_org_id IN (${inList(scope)})
        AND EXISTS (SELECT 1 FROM case_participants mp WHERE mp.case_id = c.id AND mp.user_id = ? AND mp.removed_at IS NULL)`, [...v.params, ...scope, p.user.id]), link: '/app/cases?mine=1&status=OPEN_OR_ACTIVE' };
    } },
    { id: 'hearings-upcoming', label: 'Hearings (next 7 days)', kinds: ['JUDICIARY', 'PROSECUTION', 'USMS', 'USSJA', 'CONSTITUTIONAL'], order: 20, compute: ({ p, scope, now }) => {
      if (!p.hasAnywhere('CASE_VIEW')) return null;
      const v = hearings.visibility(p, 'hr');
      const in7 = new Date(Date.parse(now) + 7 * 86_400_000).toISOString();
      const own = `(hr.court_org_id IN (${inList(scope)}) OR EXISTS (SELECT 1 FROM hearing_participants hp WHERE hp.hearing_id = hr.id AND hp.user_id = ? AND hp.removed_at IS NULL))`;
      return { value: count(`SELECT COUNT(*) n FROM hearings hr WHERE ${v.sql} AND hr.status = 'SCHEDULED' AND hr.starts_at BETWEEN ? AND ? AND ${own}`,
        [...v.params, now, in7, ...scope, p.user.id]), link: '/app/calendar' };
    } },
    { id: 'deadlines-mine', label: 'My open deadlines', kinds: '*', order: 30, compute: ({ p, scope, now }) => {
      if (!p.hasAnywhere('CASE_VIEW')) return null;
      const v = deadlines.visibility(p, 'dl');
      const base = `FROM deadlines dl JOIN cases c ON c.id = dl.case_id WHERE ${v.sql} AND dl.status = 'OPEN' AND dl.responsible_user_id = ? AND c.owning_org_id IN (${inList(scope)})`;
      const open = count(`SELECT COUNT(*) n ${base}`, [...v.params, p.user.id, ...scope]);
      const overdue = count(`SELECT COUNT(*) n ${base} AND dl.due_at < ?`, [...v.params, p.user.id, ...scope, now]);
      return { value: open, link: '/app/calendar', tone: overdue ? 'warn' : undefined, hint: overdue ? `${overdue} overdue` : undefined };
    } },
    { id: 'applications-awaiting', label: 'Applications awaiting my action', kinds: ['JUDICIARY', 'PROSECUTION', 'SID', 'USSJA'], order: 40, compute: ({ p, scope }) => {
      if (!p.hasAnywhere('APPLICATION_CREATE') && !p.hasAnywhere('APPLICATION_REVIEW') && !p.hasAnywhere('APPLICATION_DECIDE')) return null;
      const items = apps.list(p, { awaiting: '1', limit: 100 }).items.filter((a) => scope.includes(a.targetCourt?.id) || scope.includes(a.applicant?.org?.id));
      return { value: items.length, link: '/app/applications?awaiting=1', tone: items.length ? 'info' : undefined };
    } },
    { id: 'warrants-open', label: 'Open warrants', kinds: ['USMS', 'JUDICIARY', 'PROSECUTION', 'SID'], order: 50, compute: ({ p, scope }) => {
      if (!p.hasAnywhere('WARRANT_VIEW')) return null;
      const v = warrants.visibility(p, 'w');
      return { value: count(`SELECT COUNT(*) n FROM warrants w JOIN cases s ON s.id = w.source_case_id WHERE ${v.sql} AND w.status IN ('ISSUED','IN_EXECUTION')
        AND (w.issuing_org_id IN (${inList(scope)}) OR w.executing_org_id IN (${inList(scope)}) OR s.owning_org_id IN (${inList(scope)}))`, [...v.params, ...scope, ...scope, ...scope]), link: '/app/warrants?status=OPEN' };
    } },
    { id: 'documents-review', label: 'Documents awaiting approval', kinds: ALL_BUT_SJA, order: 60, compute: ({ p, scope }) => {
      const orgs = [...p.orgsWith('DOCUMENT_APPROVE')].filter((o) => scope.includes(o));
      if (!orgs.length) return null;
      const v = documentVisibility(db, p);
      return { value: count(`SELECT COUNT(*) n FROM documents d WHERE ${v.sql} AND d.status = 'IN_REVIEW' AND d.owning_org_id IN (${inList(orgs)})`, [...v.params, ...orgs]), link: '/app/documents?status=IN_REVIEW' };
    } },
    { id: 'requests-inbox', label: 'Open official requests received', kinds: ALL_BUT_SJA, order: 70, compute: ({ p, scope }) => {
      if (!p.hasAnywhere('REQUEST_RESPOND') && !p.hasAnywhere('REQUEST_ASSIGN')) return null;
      const v = requests.visibility(p, 'rq');
      return { value: count(`SELECT COUNT(*) n FROM official_requests rq WHERE ${v.sql} AND rq.status IN ('OPEN','ASSIGNED','IN_PROGRESS') AND rq.receiver_org_id IN (${inList(scope)})`, [...v.params, ...scope]), link: '/app/requests?box=inbox' };
    } },
    { id: 'evidence-pending', label: 'Evidence handovers awaiting my confirmation', kinds: ALL_BUT_SJA, order: 80, compute: ({ p }) => {
      if (!p.hasAnywhere('EVIDENCE_VIEW') && !p.hasAnywhere('EVIDENCE_TRANSFER')) return null;
      return { value: count("SELECT COUNT(*) n FROM evidence_transfers WHERE to_user_id = ? AND status = 'PENDING'", [p.user.id]), link: '/app/evidence' };
    } },
  ];

  return {
    KINDS,

    /** Dashboard für den aktiven Bereich. @param {import('../authz/principal').Principal} p */
    get(p) {
      const kind = dashboardKind(p.orgs, p.activeOrgId);
      const scope = p.activeOrgId ? p.orgs.subtree(p.activeOrgId) : [];
      const now = new Date().toISOString();
      const widgets = [];
      if (scope.length) {
        for (const w of [...core, ...(ctx.dashboardWidgets ?? [])].sort((a, b) => (a.order ?? 100) - (b.order ?? 100))) {
          if (w.kinds !== '*' && !w.kinds.includes(kind)) continue;
          const r = w.compute({ p, scope, kind, now });
          if (r) widgets.push({ id: w.id, label: w.label, ...r });
        }
      }
      return { kind, title: TITLES[kind], org: p.activeOrgId ? orgRef(p.orgs, p.activeOrgId) : null, widgets };
    },
  };
}

module.exports = { createDashboardService, dashboardKind, KINDS };
