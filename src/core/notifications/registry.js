// @ts-check
'use strict';
/**
 * Gegenstandsregister: für jeden Gegenstandstyp (Akte, Dokument, Antrag, …)
 *   ctx.subjectVisible[type](p, id)  – Sichtbarkeit (Benachrichtigungen, Personenakte, Verknüpfungen)
 *   ctx.subjectDescribe[type](id)    – Kurzbeschreibung mit Link (nur NACH erfolgreicher Sichtbarkeitsprüfung aufrufen)
 *   ctx.searchProviders[]            – Treffertypen der globalen Suche
 * Jeder Prüfer nutzt das SQL-Prädikat des jeweiligen Moduls – dieselbe Regel wie in Listen und Detailansichten.
 * Fachmodule (USMS, Judiciary, DCLI, Registry …) melden ihre Typen über registerSubject() an.
 */
const { canViewCase, caseVisibility } = require('../cases/visibility');
const { documentVisibility } = require('../documents/visibility');
const { personVisibility, companyVisibility } = require('../persons/visibility');
const { createDocumentService } = require('../documents/service');
const { createApplicationService } = require('../applications/service');
const { createWarrantService } = require('../applications/warrants');
const { createEvidenceService } = require('../evidence/service');
const { createHearingService } = require('../schedule/hearings');
const { createDeadlineService } = require('../schedule/deadlines');
const { createMessagingService } = require('../messaging/service');
const { createRequestService } = require('../requests/service');

/**
 * @typedef {{ label: string, title?: string, link: string, status?: string }} SubjectDescription
 * @typedef {{ type: string, label: string, table: string, alias: string,
 *   visibility: (p: any) => { sql: string, params: any[] }, map: (p: any, row: any) => any }} SearchProvider
 */

/** @param {import('../../app').AppContext} ctx */
function registerSubjectCheckers(ctx) {
  const { db } = ctx;
  const one = (sql, id) => /** @type {any} */ (db.prepare(sql).get(id));
  /** Prüfer aus einem Sichtbarkeitsprädikat bauen. */
  const bySql = (visibility, table, alias) => (p, id) => {
    const v = visibility(p, alias);
    return Boolean(db.prepare(`SELECT 1 FROM ${table} ${alias} WHERE ${alias}.id = ? AND ${v.sql}`).get(id, ...v.params));
  };
  const docs = createDocumentService(ctx);
  const apps = createApplicationService(ctx);
  const warrants = createWarrantService(ctx);
  const evidence = createEvidenceService(ctx);
  const hearings = createHearingService(ctx);
  const deadlines = createDeadlineService(ctx);
  const messaging = createMessagingService(ctx);
  const requests = createRequestService(ctx);

  ctx.subjectVisible = {
    case: (p, id) => canViewCase(db, p, id),
    document: (p, id) => docs.visibleIds(p, [id]).length > 0,
    application: bySql(apps.visibility, 'applications', 'a'),
    warrant: bySql(warrants.visibility, 'warrants', 'w'),
    evidence: bySql(evidence.visibility, 'evidence', 'e'),
    hearing: bySql(hearings.visibility, 'hearings', 'hr'),
    deadline: bySql(deadlines.visibility, 'deadlines', 'dl'),
    conversation: (p, id) => messaging.canView(p, id),
    official_request: (p, id) => requests.canView(p, id),
    person: bySql((p, a) => personVisibility(db, p, a), 'persons', 'pe'),
    company: bySql((p, a) => companyVisibility(db, p, a), 'companies', 'co'),
  };

  ctx.subjectDescribe = {
    case: (id) => { const c = one('SELECT case_number, title, status FROM cases WHERE id = ?', id); return c && { label: c.case_number, title: c.title, status: c.status, link: `/app/cases/${id}` }; },
    document: (id) => { const d = one('SELECT doc_number, title, status FROM documents WHERE id = ?', id); return d && { label: d.doc_number, title: d.title, status: d.status, link: `/app/documents/${id}` }; },
    application: (id) => { const a = one('SELECT application_no, title, status FROM applications WHERE id = ?', id); return a && { label: a.application_no, title: a.title, status: a.status, link: `/app/applications/${id}` }; },
    warrant: (id) => { const w = one('SELECT warrant_no, subject_name, kind, status FROM warrants WHERE id = ?', id); return w && { label: w.warrant_no, title: `${w.kind === 'ARREST' ? 'Arrest' : 'Search'} warrant – ${w.subject_name}`, status: w.status, link: `/app/warrants/${id}` }; },
    evidence: (id) => { const e = one('SELECT evidence_no, description, status FROM evidence WHERE id = ?', id); return e && { label: e.evidence_no, title: e.description, status: e.status, link: `/app/evidence/${id}` }; },
    hearing: (id) => { const h = one('SELECT hearing_no, title, status FROM hearings WHERE id = ?', id); return h && { label: h.hearing_no, title: h.title, status: h.status, link: `/app/hearings/${id}` }; },
    official_request: (id) => { const r = one('SELECT request_no, subject, status FROM official_requests WHERE id = ?', id); return r && { label: r.request_no, title: r.subject, status: r.status, link: `/app/requests/${id}` }; },
    person: (id) => { const x = one('SELECT person_no, full_name FROM persons WHERE id = ?', id); return x && { label: x.person_no, title: x.full_name, link: `/app/persons/${id}` }; },
    company: (id) => { const x = one('SELECT company_no, name, status FROM companies WHERE id = ?', id); return x && { label: x.company_no, title: x.name, status: x.status, link: `/app/companies/${id}` }; },
  };

  /** @type {SearchProvider[]} */
  ctx.searchProviders = [
    { type: 'person', label: 'Persons', table: 'persons', alias: 'pe', visibility: (p) => personVisibility(db, p, 'pe'),
      map: (_p, r) => ({ id: r.id, title: r.full_name, subtitle: [r.person_no, r.date_of_birth ? `born ${r.date_of_birth}` : '', r.aliases].filter(Boolean).join(' · '), link: `/app/persons/${r.id}`, level: r.security_level }) },
    { type: 'case', label: 'Cases', table: 'cases', alias: 'c', visibility: (p) => caseVisibility(db, p, { alias: 'c' }),
      map: (p, r) => ({ id: r.id, title: `${r.case_number} – ${r.title}`, subtitle: `${p.orgs.byId.get(r.owning_org_id)?.short_name ?? ''} · ${r.status.toLowerCase()}`, link: `/app/cases/${r.id}`, level: r.security_level }) },
    { type: 'document', label: 'Documents', table: 'documents', alias: 'd', visibility: (p) => documentVisibility(db, p, { alias: 'd' }),
      map: (_p, r) => ({ id: r.id, title: `${r.doc_number} – ${r.title}`, subtitle: r.status.toLowerCase(), link: `/app/documents/${r.id}`, level: r.security_level }) },
    { type: 'company', label: 'Companies', table: 'companies', alias: 'co', visibility: (p) => companyVisibility(db, p, 'co'),
      map: (_p, r) => ({ id: r.id, title: r.name, subtitle: [r.company_no, r.registration_no, r.status.toLowerCase()].filter(Boolean).join(' · '), link: `/app/companies/${r.id}` }) },
    { type: 'application', label: 'Court applications', table: 'applications', alias: 'a', visibility: (p) => apps.visibility(p, 'a'),
      map: (_p, r) => ({ id: r.id, title: `${r.application_no} – ${r.title}`, subtitle: r.status.toLowerCase().replace(/_/g, ' '), link: `/app/applications/${r.id}`, level: r.security_level }) },
    { type: 'warrant', label: 'Warrants', table: 'warrants', alias: 'w', visibility: (p) => warrants.visibility(p, 'w'),
      map: (_p, r) => ({ id: r.id, title: `${r.warrant_no} – ${r.subject_name}`, subtitle: `${r.kind === 'ARREST' ? 'Arrest' : 'Search'} warrant · ${r.status.toLowerCase().replace(/_/g, ' ')}`, link: `/app/warrants/${r.id}`, level: r.security_level }) },
    { type: 'hearing', label: 'Court hearings', table: 'hearings', alias: 'hr', visibility: (p) => hearings.visibility(p, 'hr'),
      map: (_p, r) => ({ id: r.id, title: `${r.hearing_no} – ${r.title}`, subtitle: `${String(r.starts_at).slice(0, 16).replace('T', ' ')} UTC · ${r.room} · ${r.status.toLowerCase()}`, link: `/app/hearings/${r.id}`, level: r.security_level }) },
    { type: 'evidence', label: 'Evidence', table: 'evidence', alias: 'e', visibility: (p) => evidence.visibility(p, 'e'),
      map: (_p, r) => ({ id: r.id, title: `${r.evidence_no} – ${r.description}`, subtitle: r.status.toLowerCase().replace(/_/g, ' '), link: `/app/evidence/${r.id}`, level: r.security_level }) },
    { type: 'official_request', label: 'Official requests', table: 'official_requests', alias: 'rq', visibility: (p) => requests.visibility(p, 'rq'),
      map: (_p, r) => ({ id: r.id, title: `${r.request_no} – ${r.subject}`, subtitle: r.status.toLowerCase().replace(/_/g, ' '), link: `/app/requests/${r.id}`, level: r.security_level }) },
    { type: 'message', label: 'Messages', table: 'messages', alias: 'm',
      visibility: (p) => {
        const v = messaging.visibility(p, 'mcv');
        return { sql: `EXISTS (SELECT 1 FROM conversations mcv WHERE mcv.id = m.conversation_id AND ${v.sql})`, params: v.params };
      },
      map: (_p, r) => {
        const cv = one('SELECT subject FROM conversations WHERE id = ?', r.conversation_id);
        return { id: r.id, title: cv?.subject ?? 'Message', subtitle: String(r.body).slice(0, 140), link: `/app/messages/${r.conversation_id}` };
      } },
  ];
}

/**
 * Fachmodule melden zusätzliche Gegenstandstypen an.
 * @param {import('../../app').AppContext} ctx
 * @param {string} type
 * @param {{ visible: (p: any, id: number) => boolean, describe?: (id: number) => SubjectDescription|null, search?: SearchProvider }} def
 */
function registerSubject(ctx, type, def) {
  if (!ctx.subjectVisible) throw new Error('registerSubjectCheckers must run first');
  ctx.subjectVisible[type] = def.visible;
  if (def.describe) /** @type {any} */ (ctx.subjectDescribe)[type] = def.describe;
  if (def.search) /** @type {any} */ (ctx.searchProviders).push(def.search);
}

module.exports = { registerSubjectCheckers, registerSubject };
