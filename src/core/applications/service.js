// @ts-check
'use strict';
/**
 * Anträge an Gerichte – Haftbefehl, Durchsuchungsbeschluss, Vorladung (WORKFLOWS.md 3 und 4).
 *
 *   Prosecution (Ausgangsakte)          District Court                               USMS
 *   Antrag DRAFT ── submit ─────────►   SUBMITTED ── accept (Richter zuweisen,
 *                                       Gerichtsakte anlegen) ──► UNDER_REVIEW
 *   ◄── request_revision ── Richter     approve* / deny* ; Beschluss-Entwurf aus Vorlage
 *                                       Signatur (Dokumentmodul) ── issue* ──► Haftbefehl ──► Vollstreckung
 *   (* = Entscheidung ausschließlich durch den zugewiesenen Richter; die Software entscheidet nie)
 *
 * Sichtbarkeit (SECURITY_MODEL.md 4, 7):
 *   - Antragstellerseite: über die Ausgangsakte (Office-Sichtbarkeit wie bei Akten)
 *   - Gericht: ab Einreichung für Mitglieder des Zielgerichts mit APPLICATION_REVIEW; der zugewiesene Richter
 *   - Das Gericht sieht NICHT die Ausgangsakte, sondern nur die ausdrücklich beigefügten Dokumente;
 *     die Staatsanwaltschaft sieht NICHT die Gerichtsakte, sondern Antrag, Status und den ausgefertigten Beschluss.
 */
const { z } = require('zod');
const { transaction, now, parseJson, inList } = require('../../db');
const { forbidden, notFound, badRequest, conflict } = require('../../http/errors');
const { caseVisibility, canViewCase } = require('../cases/visibility');
const { createCaseService } = require('../cases/service');
const { createDocumentService } = require('../documents/service');
const { createWorkflowEngine } = require('../workflows/engine');
const { loadPrincipal } = require('../authz/principal');
const { nextNumber } = require('../numbers');
const { orgRef } = require('../users/me');
const { personVisibility } = require('../persons/visibility');

const KINDS = {
  ARREST_WARRANT: { label: 'Arrest warrant', caseType: 'WARRANT', docType: 'ARREST_WARRANT', flag: 'WARRANTS', warrant: 'ARREST', minLevel: 'CONFIDENTIAL' },
  SEARCH_WARRANT: { label: 'Search warrant', caseType: 'WARRANT', docType: 'SEARCH_WARRANT', flag: 'WARRANTS', warrant: 'SEARCH', minLevel: 'CONFIDENTIAL' },
  SUBPOENA: { label: 'Subpoena', caseType: 'SUBPOENA', docType: 'SUBPOENA', flag: 'SUBPOENAS', warrant: null, minLevel: 'INTERNAL' },
};
/** Organisationen, die Haftbefehle vollstrecken dürfen (prompt.txt 6.5: USMS / Authorized Agency). */
const EXECUTING_ORGS = ['USMS'];

const text = (max) => z.string().trim().max(max);
const schemas = {
  content: z.object({
    subjectName: text(200).default(''),
    offense: text(500).default(''),
    requestedMeasure: text(5000).default(''),
    grounds: text(10_000).default(''),
  }),
};
schemas.create = z.object({
  sourceCaseId: z.number().int().positive(),
  kind: z.enum(['ARREST_WARRANT', 'SEARCH_WARRANT', 'SUBPOENA']),
  title: z.string().trim().min(3).max(200),
  targetOrgId: z.number().int().positive().nullable().default(null),
  content: schemas.content,
  documentIds: z.array(z.number().int().positive()).max(50).default([]),
  subjectPersonId: z.number().int().positive().nullable().default(null),
});
schemas.update = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  content: schemas.content.optional(),
  documentIds: z.array(z.number().int().positive()).max(50).optional(),
  subjectPersonId: z.number().int().positive().nullable().optional(),
});
schemas.action = z.object({
  reason: z.string().trim().max(2000).default(''),
  judgeId: z.number().int().positive().optional(),
  fields: z.record(z.string().max(60), z.string().max(20_000)).optional(),
  executingOrgId: z.number().int().positive().optional(),
});

/** @param {import('../../app').AppContext} ctx */
function createApplicationService(ctx) {
  const { db, audit } = ctx;
  const cases = createCaseService(ctx);
  const docs = createDocumentService(ctx);
  const wf = createWorkflowEngine(db);

  const flagOn = (code) => Boolean(/** @type {any} */ (db.prepare('SELECT enabled FROM feature_flags WHERE code = ?').get(code))?.enabled);
  const caseRow = (id) => /** @type {any} */ (db.prepare('SELECT * FROM cases WHERE id = ?').get(id));
  const res = (a) => ({ resourceType: 'application', resourceId: a.id, resourceOrgId: a.target_org_id, resourceLevel: a.security_level, resourceCompartments: [] });
  const event = (caseId, type, actorId, summary, payload = {}) => {
    if (!caseId) return;
    db.prepare('INSERT INTO case_events (case_id, type, actor_user_id, summary, payload, created_at) VALUES (?,?,?,?,?,?)')
      .run(caseId, type, actorId, summary, JSON.stringify(payload), now());
    db.prepare('UPDATE cases SET updated_at = ? WHERE id = ?').run(now(), caseId);
  };

  /** SQL-Prädikat: welche Anträge sieht p? */
  function visibility(p, alias = 'a') {
    const v = caseVisibility(db, p, { alias: 'vsc' });
    const courts = [...p.orgsWith('APPLICATION_REVIEW')];
    const parts = [`EXISTS (SELECT 1 FROM cases vsc WHERE vsc.id = ${alias}.source_case_id AND ${v.sql})`, `${alias}.assigned_judge_id = ?`];
    const params = [...v.params, p.user.id];
    if (courts.length) {
      parts.push(`(${alias}.status <> 'DRAFT' AND ${alias}.target_org_id IN (${inList(courts)}))`);
      params.push(...courts);
    }
    return {
      sql: `((SELECT rank FROM security_levels WHERE code = ${alias}.security_level) <= ? AND (${parts.join(' OR ')}))`,
      params: [p.clearanceRank, ...params],
    };
  }

  function loadVisible(p, reqCtx, id) {
    const v = visibility(p);
    const a = /** @type {any} */ (db.prepare(`SELECT a.* FROM applications a WHERE a.id = ? AND ${v.sql}`).get(id, ...v.params));
    if (a) return a;
    const hidden = /** @type {any} */ (db.prepare('SELECT * FROM applications WHERE id = ?').get(id));
    if (hidden && reqCtx) audit.write({ ...reqCtx, action: 'APPLICATION_ACCESS', outcome: 'DENIED', ...res(hidden) });
    throw notFound();
  }

  /** Antragstellerseite: sieht die Ausgangsakte und darf in ihr arbeiten. */
  function isApplicantSide(p, a) {
    const src = caseRow(a.source_case_id);
    if (!canViewCase(db, p, src.id)) return false;
    const caps = cases.capabilities(p, src);
    return caps.edit || caps.addDocument;
  }

  /** Darf p diesen Übergang ausführen? (Akteur, Permission im richtigen Scope, Feature Flag, keine Selbstentscheidung) */
  function allowed(p, a, t) {
    const kind = KINDS[a.kind];
    if (!flagOn(kind.flag)) return false;
    const scopeOrg = t.actor === 'applicant' ? caseRow(a.source_case_id).owning_org_id : a.target_org_id;
    if (t.actor === 'system') return false;
    if (t.actor === 'applicant' && !isApplicantSide(p, a)) return false;
    if (t.actor === 'court' && !p.has('APPLICATION_REVIEW', a.target_org_id)) return false;
    if (t.actor === 'assignedJudge' && a.assigned_judge_id !== p.user.id) return false;
    if (t.permission && !p.has(t.permission, scopeOrg)) return false;
    if (kind.warrant && t.warrantPermission && !p.has(t.warrantPermission, scopeOrg)) return false;
    if ((t.forbidSameActorAs ?? []).includes('applicant') && a.applicant_user_id === p.user.id) return false;
    return true;
  }

  const visiblePerson = (p, personId) => {
    const pv = personVisibility(db, p);
    const x = /** @type {any} */ (db.prepare(`SELECT pe.id, pe.full_name, pe.person_no FROM persons pe WHERE pe.id = ? AND ${pv.sql}`).get(personId, ...pv.params));
    return x ? { id: x.id, fullName: x.full_name, personNo: x.person_no } : null;
  };

  function detail(p, a) {
    const inst = wf.instanceFor('application', a.id);
    const def = wf.definition(inst.definition_code, inst.definition_version);
    const actions = wf.available(inst).filter((t) => allowed(p, a, t)).map((t) => ({ action: t.action, requireComment: Boolean(t.requireComment), humanDecision: Boolean(t.humanDecision) }));
    const applicantSide = isApplicantSide(p, a);
    const courtCaseVisible = a.court_case_id ? canViewCase(db, p, a.court_case_id) : false;
    const sourceVisible = canViewCase(db, p, a.source_case_id);
    const src = caseRow(a.source_case_id);
    const judge = a.assigned_judge_id ? /** @type {any} */ (db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(a.assigned_judge_id)) : null;
    const applicant = /** @type {any} */ (db.prepare('SELECT display_name FROM users WHERE id = ?').get(a.applicant_user_id));
    const attached = db.prepare(`SELECT d.id, d.doc_number, d.title FROM application_documents ad JOIN documents d ON d.id = ad.document_id
      WHERE ad.application_id = ? ORDER BY d.id`).all(a.id);
    const visibleDocs = new Set(attached.length ? docs.visibleIds(p, attached.map((x) => Number(x.id))) : []);
    const decisionDoc = a.decision_document_id ? docs.visibleIds(p, [a.decision_document_id]) : [];
    const warrant = /** @type {any} */ (db.prepare('SELECT id, warrant_no, status FROM warrants WHERE application_id = ?').get(a.id));
    let issueReady = null;
    if (a.status === 'APPROVED' && a.decision_document_id && courtCaseVisible) {
      const d = /** @type {any} */ (db.prepare('SELECT * FROM documents WHERE id = ?').get(a.decision_document_id));
      issueReady = docs.signatures(d).some((s) => s.status === 'VALID');
    }
    return {
      id: a.id, applicationNo: a.application_no, kind: a.kind, kindLabel: KINDS[a.kind].label, title: a.title,
      status: a.status, statusLabel: def.states[a.status]?.label ?? a.status, securityLevel: a.security_level,
      content: parseJson(a.content, {}), decisionReason: a.decision_reason,
      subjectPerson: a.subject_person_id ? visiblePerson(p, a.subject_person_id) : null,
      applicant: { id: a.applicant_user_id, name: applicant?.display_name, org: orgRef(p.orgs, a.applicant_org_id) },
      targetCourt: orgRef(p.orgs, a.target_org_id),
      assignedJudge: judge ? { id: judge.id, name: judge.display_name } : null,
      // Aktenbezüge nur, wenn die jeweilige Akte sichtbar ist
      sourceCase: sourceVisible ? { id: src.id, caseNumber: src.case_number, title: src.title } : null,
      courtCase: courtCaseVisible ? { id: a.court_case_id, caseNumber: caseRow(a.court_case_id).case_number } : null,
      documents: attached.filter((x) => visibleDocs.has(Number(x.id))).map((x) => ({ id: x.id, docNumber: x.doc_number, title: x.title })),
      decisionDocumentId: decisionDoc.length ? a.decision_document_id : null,
      warrant: warrant ? { id: warrant.id, warrantNo: warrant.warrant_no, status: warrant.status } : null,
      issueReady,
      createdAt: a.created_at, submittedAt: a.submitted_at, decidedAt: a.decided_at, updatedAt: a.updated_at,
      history: wf.history(inst.id),
      actions,
      canEdit: applicantSide && ['DRAFT', 'REVISION_REQUESTED'].includes(a.status),
      legalStatus: /** @type {any} */ (db.prepare('SELECT legal_status FROM feature_flags WHERE code = ?').get(KINDS[a.kind].flag))?.legal_status,
    };
  }

  /** Beigefügte Dokumente: müssen zur Ausgangsakte gehören und für p sichtbar sein. */
  function checkDocuments(p, sourceCaseId, ids) {
    if (!ids.length) return [];
    const ok = new Set(docs.visibleIds(p, ids));
    const inCase = new Set(db.prepare(`SELECT id FROM documents WHERE case_id = ? AND id IN (${inList(ids)})`).all(sourceCaseId, ...ids).map((r) => Number(r.id)));
    const bad = ids.filter((id) => !ok.has(id) || !inCase.has(id));
    if (bad.length) throw badRequest('Only documents of the originating case can be attached.', [{ field: 'documentIds', message: 'Invalid document selection.' }]);
    return [...new Set(ids)];
  }

  /** Betroffene Person: muss für den Antragsteller sichtbar sein. Liefert die Personenzeile. */
  function checkPerson(p, personId) {
    const pv = personVisibility(db, p);
    const x = /** @type {any} */ (db.prepare(`SELECT pe.* FROM persons pe WHERE pe.id = ? AND ${pv.sql}`).get(personId, ...pv.params));
    if (!x) throw badRequest('The person was not found.', [{ field: 'subjectPersonId', message: 'Unknown person.' }]);
    return x;
  }
  const linkPerson = (p, personId, type, id, relation) => {
    if (db.prepare('SELECT 1 FROM person_links WHERE person_id = ? AND subject_type = ? AND subject_id = ? AND relation = ? AND removed_at IS NULL').get(personId, type, id, relation)) return;
    db.prepare('INSERT INTO person_links (person_id, subject_type, subject_id, relation, created_by, created_at) VALUES (?,?,?,?,?,?)').run(personId, type, id, relation, p.user.id, now());
  };

  /** Benachrichtigung zu einem Antrag (Empfänger müssen den Antrag sehen dürfen – prüft der Notifier). */
  const notifyApp = (a, userIds, type, title, actorId) => ctx.notify?.toUsers(userIds, {
    type, title, body: `${a.application_no} · ${a.title}`, link: `/app/applications/${a.id}`, subjectType: 'application', subjectId: a.id, level: a.security_level,
  }, { exceptUserId: actorId });

  const setStatus = (id, status, extra = {}) => {
    const sets = ['status = ?', 'updated_at = ?'];
    const vals = [status, now()];
    for (const [k, v] of Object.entries(extra)) { sets.push(`${k} = ?`); vals.push(v); }
    db.prepare(`UPDATE applications SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  };

  /** Beschluss-Entwurf aus der Vorlage, vorbefüllt aus dem Antrag (der Richter bearbeitet ihn vor der Signatur). */
  function prefill(a, fields = {}) {
    const c = parseJson(a.content, {});
    const base = {
      SEARCH_WARRANT: { delikt: c.offense, beschluss: c.requestedMeasure, begruendung: c.grounds },
      ARREST_WARRANT: { beschuldigtePerson: c.subjectName, delikt: c.offense, beschluss: c.requestedMeasure, begruendung: c.grounds },
      SUBPOENA: { geladenePerson: c.subjectName, gegenstand: c.requestedMeasure || c.offense },
    }[a.kind];
    return { ...base, ...fields };
  }

  return {
    schemas,
    KINDS,
    visibility,
    loadVisible,

    /** Welche Antragsarten darf p aus dieser Akte stellen? Und an welche Gerichte? */
    options(p, reqCtx, sourceCaseId) {
      const c = cases.loadVisible(p, reqCtx, sourceCaseId);
      const caps = cases.capabilities(p, c);
      if (!(caps.edit || caps.addDocument) || !p.has('APPLICATION_CREATE', c.owning_org_id)) return { kinds: [], courts: [], documents: [] };
      const kinds = Object.entries(KINDS)
        .filter(([, k]) => !k.warrant || p.has('WARRANT_CREATE', c.owning_org_id))
        .map(([code, k]) => ({ code, label: k.label, enabled: flagOn(k.flag) }));
      const courts = db.prepare("SELECT DISTINCT org_id FROM case_type_orgs WHERE type_code IN ('WARRANT','SUBPOENA')").all().map((r) => orgRef(p.orgs, Number(r.org_id)));
      const list = docs.list(p, { caseId: c.id, limit: 100 }).items.map((d) => ({ id: d.id, docNumber: d.docNumber, title: d.title }));
      return { kinds, courts, documents: list };
    },

    create(p, reqCtx, input) {
      const d = schemas.create.parse(input);
      const kind = KINDS[d.kind];
      const src = cases.loadVisible(p, reqCtx, d.sourceCaseId);
      const caps = cases.capabilities(p, src);
      if (!(caps.edit || caps.addDocument)) throw forbidden('You must be working on the case to file an application.');
      if (!p.has('APPLICATION_CREATE', src.owning_org_id)) throw forbidden();
      if (kind.warrant && !p.has('WARRANT_CREATE', src.owning_org_id)) throw forbidden();
      if (!flagOn(kind.flag)) throw forbidden(`${kind.label} applications are disabled: their legal basis has not been verified.`, 'FEATURE_DISABLED');
      const courts = db.prepare('SELECT org_id FROM case_type_orgs WHERE type_code = ?').all(kind.caseType).map((r) => Number(r.org_id));
      const target = d.targetOrgId ?? courts[0];
      if (!courts.includes(target)) throw badRequest('This court does not handle this kind of application.');
      const documentIds = checkDocuments(p, src.id, d.documentIds);
      const person = d.subjectPersonId ? checkPerson(p, d.subjectPersonId) : null;
      if (person && !d.content.subjectName) d.content.subjectName = person.full_name;
      const level = (p.levels.get(src.security_level) ?? 0) >= (p.levels.get(kind.minLevel) ?? 0) ? src.security_level : kind.minLevel;

      const id = transaction(db, () => {
        const ts = now();
        const number = nextNumber(db, 'APP');
        const { lastInsertRowid } = db.prepare(`INSERT INTO applications (application_no, kind, title, source_case_id, applicant_user_id, applicant_org_id,
          target_org_id, content, security_level, status, subject_person_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,'DRAFT',?,?,?)`)
          .run(number, d.kind, d.title, src.id, p.user.id, src.owning_org_id, target, JSON.stringify(d.content), level, person?.id ?? null, ts, ts);
        const appId = Number(lastInsertRowid);
        if (person) linkPerson(p, person.id, 'application', appId, 'SUBJECT');
        for (const docId of documentIds) db.prepare('INSERT INTO application_documents (application_id, document_id) VALUES (?,?)').run(appId, docId);
        wf.start('COURT_APPLICATION', 'application', appId, p.user.id);
        event(src.id, 'APPLICATION_CREATED', p.user.id, `${kind.label} application ${number} drafted`, { applicationId: appId });
        audit.write({ ...reqCtx, action: 'APPLICATION_CREATE', resourceType: 'application', resourceId: appId, resourceOrgId: target, resourceLevel: level,
          details: { applicationNo: number, kind: d.kind, sourceCaseId: src.id } });
        return appId;
      });
      return detail(p, db.prepare('SELECT * FROM applications WHERE id = ?').get(id));
    },

    list(p, query) {
      const f = z.object({
        status: z.string().max(30).optional(), sourceCaseId: z.coerce.number().int().positive().optional(),
        courtCaseId: z.coerce.number().int().positive().optional(), awaiting: z.enum(['0', '1']).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).default(0),
      }).parse(query);
      const v = visibility(p);
      const where = [v.sql];
      const params = [...v.params];
      if (f.status) { where.push('a.status = ?'); params.push(f.status); }
      if (f.sourceCaseId) { where.push('a.source_case_id = ?'); params.push(f.sourceCaseId); }
      if (f.courtCaseId) { where.push('a.court_case_id = ?'); params.push(f.courtCaseId); }
      const rows = db.prepare(`SELECT a.* FROM applications a WHERE ${where.join(' AND ')} ORDER BY a.updated_at DESC, a.id DESC`).all(...params);
      let items = rows.map((a) => detail(p, a));
      if (f.awaiting === '1') items = items.filter((x) => x.actions.length > 0);
      return {
        total: items.length,
        items: items.slice(f.offset, f.offset + f.limit).map(({ history: _h, content: _c, ...rest }) => rest),
      };
    },

    get(p, reqCtx, id) {
      const a = loadVisible(p, reqCtx, id);
      audit.write({ ...reqCtx, action: 'APPLICATION_VIEW', ...res(a) });
      return detail(p, a);
    },

    update(p, reqCtx, id, input) {
      const d = schemas.update.parse(input);
      const a = loadVisible(p, reqCtx, id);
      if (!isApplicantSide(p, a) || !['DRAFT', 'REVISION_REQUESTED'].includes(a.status)) throw forbidden();
      const documentIds = d.documentIds ? checkDocuments(p, a.source_case_id, d.documentIds) : null;
      const person = d.subjectPersonId ? checkPerson(p, d.subjectPersonId) : null;
      transaction(db, () => {
        if (d.subjectPersonId !== undefined) {
          db.prepare("UPDATE person_links SET removed_at = ?, removed_by = ? WHERE subject_type = 'application' AND subject_id = ? AND relation = 'SUBJECT' AND removed_at IS NULL").run(now(), p.user.id, id);
          db.prepare('UPDATE applications SET subject_person_id = ? WHERE id = ?').run(person?.id ?? null, id);
          if (person) linkPerson(p, person.id, 'application', id, 'SUBJECT');
        }
        db.prepare('UPDATE applications SET title = COALESCE(?, title), content = COALESCE(?, content), updated_at = ? WHERE id = ?')
          .run(d.title ?? null, d.content ? JSON.stringify(d.content) : null, now(), id);
        if (documentIds) {
          db.prepare('DELETE FROM application_documents WHERE application_id = ?').run(id);
          for (const docId of documentIds) db.prepare('INSERT INTO application_documents (application_id, document_id) VALUES (?,?)').run(id, docId);
        }
        audit.write({ ...reqCtx, action: 'APPLICATION_EDIT', ...res(a), details: { fields: Object.keys(d) } });
      });
      return detail(p, loadVisible(p, reqCtx, id));
    },

    /** Workflow-Aktion ausführen (submit, withdraw, accept, request_revision, approve, deny, issue). */
    act(p, reqCtx, id, action, input) {
      const body = schemas.action.parse(input ?? {});
      const a = loadVisible(p, reqCtx, id);
      const inst = wf.instanceFor('application', id);
      const t = wf.transitionFor(inst, action);
      if (!allowed(p, a, t)) {
        audit.write({ ...reqCtx, action: `APPLICATION_${action.toUpperCase()}`, outcome: 'DENIED', ...res(a) });
        throw forbidden();
      }
      const kind = KINDS[a.kind];
      const src = caseRow(a.source_case_id);

      transaction(db, () => {
        const ts = now();
        switch (action) {
          case 'submit': {
            const c = parseJson(a.content, {});
            const missing = ['offense', 'requestedMeasure', 'grounds'].filter((k) => !String(c[k] ?? '').trim());
            if (kind.warrant === 'ARREST' && !String(c.subjectName ?? '').trim()) missing.unshift('subjectName');
            if (missing.length) throw badRequest('The application is incomplete.', missing.map((k) => ({ field: `content.${k}`, message: 'Required before submission.' })));
            wf.apply(inst, 'submit', { actorUserId: p.user.id, comment: body.reason });
            setStatus(id, 'SUBMITTED', { submitted_at: ts });
            for (const r of db.prepare('SELECT document_id FROM application_documents WHERE application_id = ?').all(id)) {
              docs.shareWithOrg(p, reqCtx, Number(r.document_id), a.target_org_id, `Attached to application ${a.application_no}`);
            }
            event(src.id, 'APPLICATION_SUBMITTED', p.user.id, `Application ${a.application_no} submitted to ${p.orgs.byId.get(a.target_org_id)?.name}`, { applicationId: id });
            // Nach Überarbeitung: zurück zum bereits zugewiesenen Richter
            if (a.court_case_id) {
              wf.apply(wf.instanceFor('application', id), 'resubmit_review', { actorUserId: null, bySystem: true });
              setStatus(id, 'UNDER_REVIEW');
              event(a.court_case_id, 'APPLICATION_RESUBMITTED', p.user.id, `Revised application ${a.application_no} received`, { applicationId: id });
            }
            break;
          }
          case 'withdraw':
            wf.apply(inst, 'withdraw', { actorUserId: p.user.id, comment: body.reason });
            setStatus(id, 'WITHDRAWN');
            event(src.id, 'APPLICATION_WITHDRAWN', p.user.id, `Application ${a.application_no} withdrawn`, { applicationId: id, reason: body.reason });
            event(a.court_case_id, 'APPLICATION_WITHDRAWN', p.user.id, `Application ${a.application_no} withdrawn by the applicant`, { applicationId: id });
            break;
          case 'accept': {
            if (!body.judgeId) throw badRequest('Assign a judge.', [{ field: 'judgeId', message: 'Choose a judge.' }]);
            const judgeRow = /** @type {any} */ (db.prepare("SELECT * FROM users WHERE id = ? AND status = 'ACTIVE'").get(body.judgeId));
            const jp = judgeRow ? loadPrincipal(db, judgeRow, { orgs: p.orgs }) : null;
            if (!jp || !jp.isMemberWithin(a.target_org_id) || !jp.has('APPLICATION_DECIDE', a.target_org_id)
              || (kind.warrant && !jp.has('WARRANT_APPROVE', a.target_org_id)) || judgeRow.id === a.applicant_user_id) {
              throw badRequest('This person cannot decide on this application.', [{ field: 'judgeId', message: 'Choose a judge of this court.' }]);
            }
            const courtCase = cases.create(p, reqCtx, { typeCode: kind.caseType, orgId: a.target_org_id, title: `${kind.label}: ${a.title}`,
              summary: `Application ${a.application_no} (${p.orgs.byId.get(a.applicant_org_id)?.name})` });
            cases.addParticipant(p, reqCtx, courtCase.id, { userId: judgeRow.id, role: 'JUDGE', isPresiding: true });
            db.prepare(`INSERT INTO case_links (from_case_id, to_case_id, link_type, created_by, created_at) VALUES (?, ?, 'ORIGINATED_FROM', ?, ?)`)
              .run(courtCase.id, src.id, p.user.id, ts);
            wf.apply(inst, 'accept', { actorUserId: p.user.id, comment: body.reason });
            setStatus(id, 'UNDER_REVIEW', { court_case_id: courtCase.id, assigned_judge_id: judgeRow.id });
            event(courtCase.id, 'APPLICATION_RECEIVED', p.user.id, `Application ${a.application_no} received, assigned to ${judgeRow.display_name}`, { applicationId: id });
            event(src.id, 'APPLICATION_ACCEPTED', p.user.id, `Application ${a.application_no} accepted by the court for review`, { applicationId: id });
            break;
          }
          case 'request_revision':
            wf.apply(inst, 'request_revision', { actorUserId: p.user.id, comment: body.reason });
            setStatus(id, 'REVISION_REQUESTED', { decision_reason: body.reason });
            event(src.id, 'APPLICATION_REVISION_REQUESTED', p.user.id, `Court requested a revision of ${a.application_no}`, { applicationId: id, reason: body.reason });
            event(a.court_case_id, 'APPLICATION_REVISION_REQUESTED', p.user.id, `Revision requested`, { applicationId: id, reason: body.reason });
            break;
          case 'approve': {
            wf.apply(inst, 'approve', { actorUserId: p.user.id, comment: body.reason });
            const doc = docs.create(p, reqCtx, {
              typeCode: kind.docType, caseId: a.court_case_id, title: `${kind.label} – ${a.title}`, content: prefill(a, body.fields),
            }, { viaWorkflow: true });
            setStatus(id, 'APPROVED', { decision_document_id: doc.id, decided_at: ts, decision_reason: body.reason });
            event(a.court_case_id, 'APPLICATION_APPROVED', p.user.id, `Application approved; decision ${doc.docNumber} drafted`, { applicationId: id, documentId: doc.id });
            event(src.id, 'APPLICATION_APPROVED', p.user.id, `Application ${a.application_no} approved by the court (awaiting signature and issue)`, { applicationId: id });
            break;
          }
          case 'deny':
            wf.apply(inst, 'deny', { actorUserId: p.user.id, comment: body.reason });
            setStatus(id, 'DENIED', { decided_at: ts, decision_reason: body.reason });
            event(a.court_case_id, 'APPLICATION_DENIED', p.user.id, 'Application denied', { applicationId: id, reason: body.reason });
            event(src.id, 'APPLICATION_DENIED', p.user.id, `Application ${a.application_no} denied by the court`, { applicationId: id, reason: body.reason });
            break;
          case 'issue': {
            const d = /** @type {any} */ (db.prepare('SELECT * FROM documents WHERE id = ?').get(a.decision_document_id));
            if (!d || !docs.signatures(d).some((s) => s.status === 'VALID')) {
              throw conflict('Sign the decision document before issuing it.', 'SIGNATURE_REQUIRED');
            }
            if (d.status !== 'ISSUED') docs.issue(p, reqCtx, d.id);
            wf.apply(inst, 'issue', { actorUserId: p.user.id, comment: body.reason });
            setStatus(id, 'ISSUED');
            // Antragsteller erhält den ausgefertigten Beschluss (nicht die Gerichtsakte)
            docs.shareWithOrg(p, reqCtx, d.id, a.applicant_org_id, `Issued decision on application ${a.application_no}`);
            let warrantNo = null;
            if (kind.warrant) {
              const execCode = body.executingOrgId ? p.orgs.byId.get(body.executingOrgId)?.code : EXECUTING_ORGS[0];
              if (!EXECUTING_ORGS.includes(String(execCode))) throw badRequest('This organization cannot execute warrants.');
              const execOrg = p.orgs.byCode.get(String(execCode));
              const c = parseJson(a.content, {});
              warrantNo = nextNumber(db, 'W');
              const { lastInsertRowid: wid } = db.prepare(`INSERT INTO warrants (warrant_no, kind, application_id, court_case_id, source_case_id, document_id, subject_name, offense, measure,
                issuing_org_id, issued_by, issued_at, executing_org_id, security_level, subject_person_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
                .run(warrantNo, kind.warrant, id, a.court_case_id, a.source_case_id, d.id, c.subjectName || '—', c.offense || '—', c.requestedMeasure || '',
                  a.target_org_id, p.user.id, ts, execOrg.id, a.security_level, a.subject_person_id ?? null);
              if (a.subject_person_id) linkPerson(p, a.subject_person_id, 'warrant', Number(wid), 'SUBJECT');
              docs.shareWithOrg(p, reqCtx, d.id, execOrg.id, `Warrant ${warrantNo} for execution`);
            }
            event(a.court_case_id, 'APPLICATION_ISSUED', p.user.id, warrantNo ? `Warrant ${warrantNo} issued` : `${d.doc_number} issued`, { applicationId: id, warrantNo });
            event(src.id, 'APPLICATION_ISSUED', p.user.id, warrantNo ? `Warrant ${warrantNo} issued on application ${a.application_no}` : `Decision on ${a.application_no} issued`, { applicationId: id, warrantNo });
            break;
          }
          default:
            throw conflict('Unknown action.', 'INVALID_TRANSITION');
        }
        audit.write({ ...reqCtx, action: `APPLICATION_${action.toUpperCase()}`, ...res(a), details: { from: a.status, reason: body.reason || undefined, judgeId: body.judgeId } });
        const cur = /** @type {any} */ (db.prepare('SELECT * FROM applications WHERE id = ?').get(id));
        const label = KINDS[a.kind].label;
        if (action === 'submit') {
          const resub = Boolean(cur.assigned_judge_id);
          notifyApp(cur, resub ? [cur.assigned_judge_id] : ctx.notify?.usersWith(cur.target_org_id, 'CASE_ASSIGN') ?? [],
            resub ? 'APPLICATION_RESUBMITTED' : 'APPLICATION_SUBMITTED', resub ? `Revised application: ${label}` : `New application: ${label}`, p.user.id);
        } else if (action === 'accept') {
          notifyApp(cur, [cur.assigned_judge_id], 'APPLICATION_ASSIGNED', `Application assigned to you: ${label}`, p.user.id);
        } else if (['request_revision', 'approve', 'deny', 'issue'].includes(action)) {
          const verb = { request_revision: 'Revision requested', approve: 'Approved', deny: 'Denied', issue: 'Issued' }[action];
          notifyApp(cur, [cur.applicant_user_id], `APPLICATION_${action.toUpperCase()}`, `${verb}: ${label} application ${cur.application_no}`, p.user.id);
        }
        if (action === 'issue' && kind.warrant) {
          const w = /** @type {any} */ (db.prepare('SELECT * FROM warrants WHERE application_id = ?').get(id));
          ctx.notify?.toUsers(ctx.notify.usersWith(w.executing_org_id, 'WARRANT_EXECUTE'), { type: 'WARRANT_ISSUED', title: `New ${label.toLowerCase()} for execution: ${w.warrant_no}`,
            body: `${w.subject_name} · ${p.orgs.byId.get(w.issuing_org_id)?.name}`, link: `/app/warrants/${w.id}`, subjectType: 'warrant', subjectId: w.id, level: w.security_level }, { exceptUserId: p.user.id });
        }
      });
      return detail(p, loadVisible(p, reqCtx, id));
    },

    /** Richter des Zielgerichts für die Zuweisung (nur für Gerichtsverwaltung). */
    judges(p, reqCtx, id) {
      const a = loadVisible(p, reqCtx, id);
      if (!p.has('CASE_ASSIGN', a.target_org_id)) throw forbidden();
      const kind = KINDS[a.kind];
      const sub = p.orgs.subtree(a.target_org_id);
      const users = db.prepare(`SELECT DISTINCT u.* FROM users u JOIN memberships m ON m.user_id = u.id
        WHERE u.status = 'ACTIVE' AND m.org_id IN (${inList(sub)}) ORDER BY u.display_name`).all(...sub);
      return users.map((u) => ({ user: u, jp: loadPrincipal(db, u, { orgs: p.orgs }) }))
        .filter(({ user, jp }) => user.id !== a.applicant_user_id && jp.has('APPLICATION_DECIDE', a.target_org_id) && (!kind.warrant || jp.has('WARRANT_APPROVE', a.target_org_id)))
        .map(({ user, jp }) => ({ id: user.id, name: user.display_name, rank: jp.memberships.find((m) => sub.includes(m.orgId))?.rankName ?? null,
          cleared: jp.clearedFor(a.security_level) }));
    },
  };
}

module.exports = { createApplicationService, KINDS, EXECUTING_ORGS };
