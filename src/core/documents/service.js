// @ts-check
'use strict';
/**
 * Dokumentenverwaltung (prompt.txt 6.2, 6.3, 8): Versionen, Vorlagen, Freigabe, Signaturen, Ausfertigung.
 *
 * Status:  DRAFT → (IN_REVIEW → APPROVED | REJECTED) → SIGNED → ISSUED → ARCHIVED ;  DRAFT → DELETED
 * - Jede inhaltliche Änderung erzeugt eine neue, unveränderliche Version (Trigger in 003_documents.sql).
 * - Signaturen sind an Version + SHA-256 gebunden. Eine neue Version setzt den Status auf DRAFT; ältere
 *   Signaturen bleiben ihrer Version zugeordnet und werden als "superseded" angezeigt – nie als gültig
 *   für den neuen Inhalt.
 * - Die Gültigkeit wird serverseitig berechnet (ADR-010), nie aus einem UI-Zustand abgeleitet.
 * - Die Software entscheidet nichts: Freigabe, Signatur und Ausfertigung sind ausdrückliche Handlungen.
 */
const { z } = require('zod');
const { transaction, now, parseJson, inList } = require('../../db');
const { forbidden, notFound, badRequest, conflict } = require('../../http/errors');
const { documentVisibility } = require('./visibility');
const { renderTemplate, versionHash } = require('./render');
const { createCaseService } = require('../cases/service');
const { assertFeature } = require('../admin/config');
const { nextNumber } = require('../numbers');
const { orgRef } = require('../users/me');

const reason = z.string().trim().min(3).max(1000);
const content = z.record(z.string().max(60), z.string().max(20_000)).default({});

const schemas = {
  create: z.object({
    typeCode: z.string().min(2).max(40),
    caseId: z.number().int().positive().nullable().default(null),
    orgId: z.number().int().positive().nullable().default(null),
    title: z.string().trim().min(3).max(200),
    content,
    fileId: z.number().int().positive().nullable().default(null),
    securityLevel: z.string().min(2).max(40).nullable().default(null),
  }),
  update: z.object({
    title: z.string().trim().min(3).max(200).optional(),
    content: content.optional(),
    fileId: z.number().int().positive().nullable().optional(),
    changeNote: z.string().trim().max(500).default(''),
  }),
  list: z.object({
    caseId: z.coerce.number().int().positive().optional(),
    q: z.string().trim().max(100).optional(),
    type: z.string().max(40).optional(),
    status: z.string().max(20).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  }),
  sign: z.object({ capacity: z.string().trim().max(120).default('') }),
  reasonOnly: z.object({ reason }),
};

/** @param {import('../../app').AppContext} ctx */
function createDocumentService(ctx) {
  const { db, audit } = ctx;
  const cases = createCaseService(ctx);

  const typeOf = (code) => {
    const t = /** @type {any} */ (db.prepare('SELECT * FROM document_types WHERE code = ?').get(code));
    return t ? { ...t, allowed: parseJson(t.allowed_orgs, null) } : null;
  };
  const templateOf = (code) => /** @type {any} */ (db.prepare(`SELECT * FROM document_templates WHERE code = ? AND is_active = 1
    ORDER BY version DESC LIMIT 1`).get(code));
  const compartmentsOf = (docId) => db.prepare('SELECT compartment_code c FROM document_compartments WHERE document_id = ? ORDER BY c').all(docId).map((r) => String(r.c));
  const res = (d) => ({ resourceType: 'document', resourceId: d.id, resourceOrgId: d.owning_org_id, resourceLevel: d.security_level, resourceCompartments: compartmentsOf(d.id) });
  const caseEvent = (caseId, type, actorId, summary, payload = {}) => {
    if (!caseId) return;
    db.prepare('INSERT INTO case_events (case_id, type, actor_user_id, summary, payload, created_at) VALUES (?,?,?,?,?,?)')
      .run(caseId, type, actorId, summary, JSON.stringify(payload), now());
    db.prepare('UPDATE cases SET updated_at = ? WHERE id = ?').run(now(), caseId);
  };
  const flagEnabled = (code) => !code || Boolean(/** @type {any} */ (db.prepare('SELECT enabled FROM feature_flags WHERE code = ?').get(code))?.enabled);

  /** Darf dieser Typ in dieser Organisation geführt werden? */
  const typeAllowedIn = (p, type, orgId) => !type.allowed || type.allowed.some((code) => {
    const o = p.orgs.byCode.get(code);
    return o && p.orgs.isWithin(orgId, o.id);
  });

  function loadVisible(p, reqCtx, docId) {
    const v = documentVisibility(db, p);
    const d = /** @type {any} */ (db.prepare(`SELECT d.* FROM documents d WHERE d.id = ? AND ${v.sql}`).get(docId, ...v.params));
    if (d) return d;
    const hidden = /** @type {any} */ (db.prepare("SELECT * FROM documents WHERE id = ? AND status <> 'DELETED'").get(docId));
    if (hidden && reqCtx) audit.write({ ...reqCtx, action: 'DOCUMENT_ACCESS', outcome: 'DENIED', ...res(hidden) });
    throw notFound();
  }

  const versionRow = (docId, version) => /** @type {any} */ (db.prepare('SELECT * FROM document_versions WHERE document_id = ? AND version = ?').get(docId, version));

  /** Hash einer gespeicherten Version neu berechnen (erkennt Manipulation direkt in der Datei). */
  function recomputeHash(d, v) {
    const file = v.file_id ? /** @type {any} */ (db.prepare('SELECT sha256 FROM files WHERE id = ?').get(v.file_id)) : null;
    return versionHash({ documentId: d.id, version: v.version, typeCode: d.type_code, templateCode: v.template_code,
      templateVersion: v.template_version, content: parseJson(v.content, {}), renderedHtml: v.rendered_html, fileSha256: file?.sha256 ?? null });
  }

  /** Signaturen mit serverseitig berechnetem Status. */
  function signatures(d) {
    const rows = db.prepare(`SELECT s.*, r.reason AS revoke_reason, r.revoked_at, ru.display_name AS revoked_by_name
      FROM document_signatures s LEFT JOIN signature_revocations r ON r.signature_id = s.id LEFT JOIN users ru ON ru.id = r.revoked_by
      WHERE s.document_id = ? ORDER BY s.id`).all(d.id);
    const hashes = new Map();
    return rows.map((s) => {
      if (!hashes.has(s.version)) hashes.set(s.version, recomputeHash(d, versionRow(d.id, s.version)));
      let status = 'VALID';
      if (s.revoked_at) status = 'REVOKED';
      else if (hashes.get(s.version) !== s.sha256) status = 'INVALID';
      else if (s.version !== d.current_version) status = 'SUPERSEDED';
      return {
        id: s.id, version: s.version, sha256: s.sha256, status, signedAt: s.signed_at, capacity: s.capacity,
        signer: { id: s.signer_user_id, name: s.signer_name, rank: s.signer_rank, org: s.signer_org },
        revocation: s.revoked_at ? { reason: s.revoke_reason, at: s.revoked_at, by: s.revoked_by_name } : null,
      };
    });
  }
  const validOnCurrent = (d) => signatures(d).some((s) => s.status === 'VALID');

  /** Ist p an diesem Dokument beteiligt (Akte: darf Dokumente anlegen; sonst Ersteller oder persönlicher Zugang)? */
  function involved(p, d) {
    if (d.case_id) {
      const c = /** @type {any} */ (db.prepare('SELECT * FROM cases WHERE id = ?').get(d.case_id));
      return cases.capabilities(p, c).addDocument;
    }
    return d.created_by === p.user.id || Boolean(db.prepare(`SELECT 1 FROM document_access WHERE document_id = ? AND subject_type = 'USER'
      AND subject_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`).get(d.id, p.user.id, now()));
  }

  function capabilities(p, d) {
    const type = typeOf(d.type_code);
    const org = d.owning_org_id;
    const inv = involved(p, d);
    const cur = versionRow(d.id, d.current_version);
    const flagOk = flagEnabled(type.feature_flag);
    const signedByMe = Boolean(db.prepare(`SELECT 1 FROM document_signatures s WHERE s.document_id = ? AND s.version = ? AND s.signer_user_id = ?
      AND NOT EXISTS (SELECT 1 FROM signature_revocations r WHERE r.signature_id = s.id)`).get(d.id, d.current_version, p.user.id));
    const canSignPerm = Boolean(type.sign_permission) && p.has(type.sign_permission, org);
    return {
      edit: inv && flagOk && p.has('DOCUMENT_EDIT', org) && ['DRAFT', 'REJECTED', 'APPROVED', 'SIGNED'].includes(d.status),
      submit: inv && ['DRAFT', 'REJECTED'].includes(d.status),
      approve: d.status === 'IN_REVIEW' && p.has('DOCUMENT_APPROVE', org) && cur.created_by !== p.user.id,
      reject: d.status === 'IN_REVIEW' && p.has('DOCUMENT_REJECT', org) && cur.created_by !== p.user.id,
      sign: inv && flagOk && canSignPerm && !signedByMe
        && (type.requires_approval ? ['APPROVED', 'SIGNED'].includes(d.status) : ['DRAFT', 'APPROVED', 'SIGNED'].includes(d.status)),
      issue: inv && flagOk && canSignPerm && d.status === 'SIGNED' && validOnCurrent(d),
      archive: inv && p.has('DOCUMENT_EDIT', org) && ['SIGNED', 'ISSUED'].includes(d.status),
      delete: d.status === 'DRAFT' && d.created_by === p.user.id && p.has('DOCUMENT_DELETE', org)
        && !db.prepare('SELECT 1 FROM document_signatures WHERE document_id = ?').get(d.id),
      download: p.hasAnywhere('DOCUMENT_DOWNLOAD'),
      revokeAny: p.has('DOCUMENT_APPROVE', org),
    };
  }
  function requireCap(p, cap, d) {
    if (!capabilities(p, d)[cap]) throw forbidden();
  }

  /** Inhalt gegen die Vorlagenfelder prüfen und rendern. */
  function build(p, type, d, fields, title) {
    if (!type.template_code) return { template: null, html: '', fields: {} };
    const tpl = templateOf(type.template_code);
    if (!tpl) throw badRequest('No active template for this document type.');
    const defs = parseJson(tpl.fields, []);
    const clean = {};
    const errors = [];
    for (const f of defs) {
      const v = String(fields?.[f.key] ?? '').trim();
      if (f.required && !v) errors.push({ field: `content.${f.key}`, message: `${f.label} is required.` });
      if (v) clean[f.key] = v;
    }
    if (errors.length) throw badRequest('Some fields are missing.', errors);
    const org = p.orgs.byId.get(d.owning_org_id);
    const kase = d.case_id ? /** @type {any} */ (db.prepare('SELECT case_number, title FROM cases WHERE id = ?').get(d.case_id)) : null;
    const html = renderTemplate(tpl.body, {
      ...clean,
      issuer: { name: org.name, nameUpper: org.name.toUpperCase(), subtitle: org.subtitle },
      doc: { title, number: d.doc_number },
      case: kase ? { number: kase.case_number, title: kase.title } : {},
    });
    return { template: tpl, html, fields: clean };
  }

  function insertVersion(p, d, version, built, title, fileId, changeNote) {
    const file = fileId ? /** @type {any} */ (db.prepare('SELECT sha256 FROM files WHERE id = ?').get(fileId)) : null;
    const contentObj = { title, fields: built.fields };
    const sha = versionHash({ documentId: d.id, version, typeCode: d.type_code, templateCode: built.template?.code ?? null,
      templateVersion: built.template?.version ?? null, content: contentObj, renderedHtml: built.html, fileSha256: file?.sha256 ?? null });
    db.prepare(`INSERT INTO document_versions (document_id, version, template_code, template_version, content, rendered_html, file_id, sha256, change_note, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(d.id, version, built.template?.code ?? null, built.template?.version ?? null,
      JSON.stringify(contentObj), built.html, fileId ?? null, sha, changeNote ?? '', p.user.id, now());
    return sha;
  }

  function detail(p, d) {
    const type = typeOf(d.type_code);
    const cur = versionRow(d.id, d.current_version);
    const file = cur.file_id ? /** @type {any} */ (db.prepare('SELECT id, original_name, mime, size, sha256 FROM files WHERE id = ?').get(cur.file_id)) : null;
    const kase = d.case_id ? /** @type {any} */ (db.prepare('SELECT id, case_number, title, is_sealed FROM cases WHERE id = ?').get(d.case_id)) : null;
    const tpl = type.template_code ? templateOf(type.template_code) : null;
    const flag = type.feature_flag ? /** @type {any} */ (db.prepare('SELECT legal_status FROM feature_flags WHERE code = ?').get(type.feature_flag)) : null;
    const creator = /** @type {any} */ (db.prepare('SELECT display_name FROM users WHERE id = ?').get(d.created_by));
    return {
      id: d.id, docNumber: d.doc_number, title: d.title, status: d.status, isDemo: Boolean(d.is_demo),
      type: { code: type.code, name: type.name, signable: Boolean(type.sign_permission), requiresApproval: Boolean(type.requires_approval) },
      issuer: orgRef(p.orgs, d.owning_org_id),
      case: kase ? { id: kase.id, caseNumber: kase.case_number, title: kase.title, isSealed: Boolean(kase.is_sealed) } : null,
      securityLevel: d.security_level, compartments: compartmentsOf(d.id),
      legalStatus: flag ? flag.legal_status : type.legal_status,
      createdBy: creator?.display_name, createdAt: d.created_at, updatedAt: d.updated_at,
      currentVersion: {
        version: cur.version, sha256: cur.sha256, createdAt: cur.created_at, changeNote: cur.change_note,
        content: parseJson(cur.content, {}), renderedHtml: cur.rendered_html,
        file: file ? { id: file.id, name: file.original_name, mime: file.mime, size: file.size, sha256: file.sha256 } : null,
      },
      templateFields: tpl ? parseJson(tpl.fields, []) : [],
      versions: db.prepare(`SELECT v.version, v.sha256, v.change_note, v.created_at, u.display_name FROM document_versions v
        JOIN users u ON u.id = v.created_by WHERE v.document_id = ? ORDER BY v.version DESC`).all(d.id)
        .map((v) => ({ version: v.version, sha256: v.sha256, changeNote: v.change_note, createdAt: v.created_at, createdBy: v.display_name })),
      signatures: signatures(d),
      capabilities: capabilities(p, d),
    };
  }

  const setStatus = (id, status) => db.prepare('UPDATE documents SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);

  return {
    schemas,
    loadVisible,
    signatures,

    /**
     * Dokumenttypen, die im Kontext (Akte oder Organisation) angelegt werden dürfen – inkl. Vorlagenfelder.
     * @param {import('../authz/principal').Principal} p @param {any} reqCtx @param {{ caseId?: number, orgId?: number }} where
     */
    creatableTypes(p, reqCtx, { caseId, orgId }) {
      let org = orgId;
      if (caseId) {
        const c = cases.loadVisible(p, reqCtx, caseId);
        if (!cases.capabilities(p, c).addDocument) return [];
        org = c.owning_org_id;
      }
      if (!org || !p.has('DOCUMENT_CREATE', org)) return [];
      return db.prepare('SELECT * FROM document_types WHERE is_enabled = 1 ORDER BY sort_order').all()
        .map((t) => /** @type {any} */ ({ ...t, allowed: parseJson(t.allowed_orgs, null) }))
        .filter((t) => !t.workflow_only && typeAllowedIn(p, t, org))
        .map((t) => {
          const tpl = t.template_code ? templateOf(t.template_code) : null;
          const flag = t.feature_flag ? /** @type {any} */ (db.prepare('SELECT enabled, legal_status FROM feature_flags WHERE code = ?').get(t.feature_flag)) : null;
          return { code: t.code, name: t.name, isAttachment: !t.template_code, fields: tpl ? parseJson(tpl.fields, []) : [],
            templateName: tpl?.name ?? null, enabled: !flag || Boolean(flag.enabled), legalStatus: flag ? flag.legal_status : t.legal_status };
        });
    },

    /**
     * @param {import('../authz/principal').Principal} p @param {any} reqCtx @param {any} input
     * @param {{ viaWorkflow?: boolean }} [opts]  verfahrensgebundene Typen nur aus einem Workflow heraus
     */
    create(p, reqCtx, input, opts = {}) {
      const d = schemas.create.parse(input);
      const type = typeOf(d.typeCode);
      if (!type || !type.is_enabled) throw badRequest('Unknown or disabled document type.');
      if (type.workflow_only && !opts.viaWorkflow) {
        throw badRequest(`${type.name} documents are created through the court application procedure.`, [{ field: 'typeCode', message: 'Use an application instead.' }]);
      }
      if (type.feature_flag) assertFeature(db, type.feature_flag);

      let kase = null;
      let orgId = d.orgId;
      let level = 'INTERNAL';
      let comps = [];
      if (d.caseId) {
        kase = cases.loadVisible(p, reqCtx, d.caseId);
        if (!cases.capabilities(p, kase).addDocument) throw forbidden();
        orgId = kase.owning_org_id;
        level = kase.security_level;
        comps = db.prepare('SELECT compartment_code c FROM case_compartments WHERE case_id = ?').all(kase.id).map((r) => String(r.c));
      } else {
        if (!orgId || !p.orgs.byId.has(orgId)) throw badRequest('Choose the issuing organization.');
        if (!p.memberships.some((m) => p.orgs.isWithin(m.orgId, orgId) || p.orgs.isWithin(orgId, m.orgId))) {
          throw forbidden('You can only create documents for your own organization.');
        }
      }
      if (!p.has('DOCUMENT_CREATE', orgId)) throw forbidden();
      if (!typeAllowedIn(p, type, orgId)) throw badRequest('This organization cannot issue documents of this type.');
      // Nie lockerer als die Akte; strenger ist erlaubt, wenn der Ersteller dafür freigegeben ist
      if (d.securityLevel) {
        if (!p.levels.has(d.securityLevel)) throw badRequest('Unknown security level.');
        if ((p.levels.get(d.securityLevel) ?? 0) < (p.levels.get(level) ?? 0)) throw badRequest('A document cannot be less protected than its case.');
        if (!p.clearedFor(d.securityLevel)) throw forbidden('You are not cleared for this security level.');
        level = d.securityLevel;
      }

      let file = null;
      if (!type.template_code) {
        if (!d.fileId) throw badRequest('Upload a file for this document type.', [{ field: 'fileId', message: 'A file is required.' }]);
        // (Einfaches Lesen reicht: der Service hat keine eigene Instanz der Dateiablage)
        file = /** @type {any} */ (db.prepare(`SELECT * FROM files f WHERE f.id = ? AND f.uploaded_by = ?
          AND NOT EXISTS (SELECT 1 FROM document_versions v WHERE v.file_id = f.id) AND NOT EXISTS (SELECT 1 FROM evidence_files ef WHERE ef.file_id = f.id)`).get(d.fileId, p.user.id));
        if (!file) throw badRequest('The uploaded file was not found or is already in use.');
      } else if (d.fileId) {
        throw badRequest('This document type does not take a file.');
      }

      const org = p.orgs.byId.get(orgId);
      const docId = transaction(db, () => {
        const ts = now();
        const number = nextNumber(db, `${org.code}-${type.number_suffix}`);
        const { lastInsertRowid } = db.prepare(`INSERT INTO documents (doc_number, type_code, case_id, title, owning_org_id, security_level,
          created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(number, type.code, kase?.id ?? null, d.title, orgId, level, p.user.id, ts, ts);
        const id = Number(lastInsertRowid);
        for (const c of comps) db.prepare('INSERT INTO document_compartments (document_id, compartment_code) VALUES (?,?)').run(id, c);
        const row = /** @type {any} */ (db.prepare('SELECT * FROM documents WHERE id = ?').get(id));
        const built = build(p, type, row, d.content, d.title);
        insertVersion(p, row, 1, built, d.title, file?.id ?? null, 'Created');
        if (!kase) {
          db.prepare(`INSERT INTO document_access (document_id, subject_type, subject_id, is_default, granted_by, reason, created_at)
            VALUES (?, 'ORG', ?, 1, ?, 'Office visibility (default)', ?)`).run(id, orgId, p.user.id, ts);
        }
        caseEvent(kase?.id, 'DOCUMENT_ADDED', p.user.id, `${type.name} ${number} added`, { documentId: id });
        audit.write({ ...reqCtx, action: 'DOCUMENT_CREATE', ...res(row), details: { docNumber: number, typeCode: type.code, caseId: kase?.id ?? null } });
        return id;
      });
      return detail(p, db.prepare('SELECT * FROM documents WHERE id = ?').get(docId));
    },

    list(p, query) {
      const f = schemas.list.parse(query);
      const v = documentVisibility(db, p);
      const where = [v.sql];
      const params = [...v.params];
      if (f.caseId) { where.push('d.case_id = ?'); params.push(f.caseId); }
      if (f.type) { where.push('d.type_code = ?'); params.push(f.type); }
      if (f.status) { where.push('d.status = ?'); params.push(f.status); }
      if (f.q) {
        where.push("(d.doc_number LIKE ? ESCAPE '\\' OR d.title LIKE ? ESCAPE '\\')");
        const like = `%${f.q.replace(/[\\%_]/g, (x) => '\\' + x)}%`;
        params.push(like, like);
      }
      const w = where.join(' AND ');
      const total = Number(/** @type {any} */ (db.prepare(`SELECT COUNT(*) n FROM documents d WHERE ${w}`).get(...params)).n);
      const rows = db.prepare(`SELECT d.*, t.name AS type_name, c.case_number FROM documents d JOIN document_types t ON t.code = d.type_code
        LEFT JOIN cases c ON c.id = d.case_id WHERE ${w} ORDER BY d.updated_at DESC, d.id DESC LIMIT ? OFFSET ?`).all(...params, f.limit, f.offset);
      return {
        total,
        items: rows.map((d) => ({ id: d.id, docNumber: d.doc_number, title: d.title, status: d.status, type: { code: d.type_code, name: d.type_name },
          case: d.case_id ? { id: d.case_id, caseNumber: d.case_number } : null, issuer: orgRef(p.orgs, Number(d.owning_org_id)),
          securityLevel: d.security_level, version: d.current_version, isDemo: Boolean(d.is_demo), updatedAt: d.updated_at })),
      };
    },

    get(p, reqCtx, docId) {
      const d = loadVisible(p, reqCtx, docId);
      audit.write({ ...reqCtx, action: 'DOCUMENT_VIEW', ...res(d) });
      return detail(p, d);
    },

    /** Eine bestimmte (auch ältere) Version, z. B. für die Druckansicht. */
    version(p, reqCtx, docId, version) {
      const d = loadVisible(p, reqCtx, docId);
      const v = versionRow(docId, version);
      if (!v) throw notFound();
      audit.write({ ...reqCtx, action: 'DOCUMENT_VIEW', ...res(d), details: { version } });
      return {
        version: v.version, sha256: v.sha256, createdAt: v.created_at, content: parseJson(v.content, {}), renderedHtml: v.rendered_html,
        signatures: signatures(d).filter((s) => s.version === version),
      };
    },

    update(p, reqCtx, docId, input) {
      const d0 = schemas.update.parse(input);
      const d = loadVisible(p, reqCtx, docId);
      requireCap(p, 'edit', d);
      const type = typeOf(d.type_code);
      const cur = versionRow(docId, d.current_version);
      const prev = parseJson(cur.content, {});
      const title = d0.title ?? d.title;
      let fileId = cur.file_id;
      if (!type.template_code && d0.fileId && d0.fileId !== cur.file_id) {
        const f = db.prepare(`SELECT 1 FROM files f WHERE f.id = ? AND f.uploaded_by = ? AND NOT EXISTS (SELECT 1 FROM document_versions v WHERE v.file_id = f.id) AND NOT EXISTS (SELECT 1 FROM evidence_files ef WHERE ef.file_id = f.id)`)
          .get(d0.fileId, p.user.id);
        if (!f) throw badRequest('The uploaded file was not found or is already in use.');
        fileId = d0.fileId;
      }
      const version = d.current_version + 1;
      transaction(db, () => {
        const built = build(p, type, d, d0.content ?? prev.fields ?? {}, title);
        insertVersion(p, d, version, built, title, fileId, d0.changeNote);
        db.prepare("UPDATE documents SET title = ?, current_version = ?, status = 'DRAFT', updated_at = ? WHERE id = ?").run(title, version, now(), docId);
        caseEvent(d.case_id, 'DOCUMENT_VERSIONED', p.user.id, `${d.doc_number}: version ${version}`, { documentId: docId, version });
        audit.write({ ...reqCtx, action: 'DOCUMENT_EDIT', ...res(d), details: { version, previousStatus: d.status, changeNote: d0.changeNote } });
      });
      return detail(p, loadVisible(p, reqCtx, docId));
    },

    submit(p, reqCtx, docId) {
      const d = loadVisible(p, reqCtx, docId);
      requireCap(p, 'submit', d);
      transaction(db, () => {
        setStatus(docId, 'IN_REVIEW');
        caseEvent(d.case_id, 'DOCUMENT_SUBMITTED', p.user.id, `${d.doc_number} submitted for review`, { documentId: docId });
        audit.write({ ...reqCtx, action: 'DOCUMENT_SUBMIT', ...res(d), details: { version: d.current_version } });
        ctx.notify?.toUsers(ctx.notify.usersWith(d.owning_org_id, 'DOCUMENT_APPROVE'), { type: 'DOCUMENT_REVIEW_REQUESTED', title: `Review requested: ${d.doc_number}`,
          body: d.title, link: `/app/documents/${d.id}`, subjectType: 'document', subjectId: d.id, level: d.security_level, compartments: compartmentsOf(d.id) }, { exceptUserId: p.user.id });
      });
      return detail(p, loadVisible(p, reqCtx, docId));
    },

    decide(p, reqCtx, docId, approve, input) {
      const { reason: why } = schemas.reasonOnly.parse(input);
      const d = loadVisible(p, reqCtx, docId);
      requireCap(p, approve ? 'approve' : 'reject', d);
      transaction(db, () => {
        setStatus(docId, approve ? 'APPROVED' : 'REJECTED');
        caseEvent(d.case_id, approve ? 'DOCUMENT_APPROVED' : 'DOCUMENT_REJECTED', p.user.id, `${d.doc_number} ${approve ? 'approved' : 'rejected'}`, { documentId: docId, reason: why });
        audit.write({ ...reqCtx, action: approve ? 'DOCUMENT_APPROVE' : 'DOCUMENT_REJECT', ...res(d), details: { version: d.current_version, reason: why } });
        ctx.notify?.toUsers([versionRow(d.id, d.current_version).created_by], { type: approve ? 'DOCUMENT_APPROVED' : 'DOCUMENT_REJECTED',
          title: `${approve ? 'Approved' : 'Rejected'}: ${d.doc_number}`, body: why, link: `/app/documents/${d.id}`, subjectType: 'document', subjectId: d.id,
          level: d.security_level, compartments: compartmentsOf(d.id) }, { exceptUserId: p.user.id });
      });
      return detail(p, loadVisible(p, reqCtx, docId));
    },

    sign(p, reqCtx, docId, input) {
      const { capacity } = schemas.sign.parse(input);
      const d = loadVisible(p, reqCtx, docId);
      requireCap(p, 'sign', d);
      const v = versionRow(docId, d.current_version);
      if (recomputeHash(d, v) !== v.sha256) throw conflict('This version failed its integrity check and cannot be signed.', 'INTEGRITY_FAILED');
      // Momentaufnahme von Rang und Institution: Mitgliedschaft in der ausstellenden Organisation bzw. deren nächstem Vorfahren
      const chain = p.orgs.ancestorsOf(d.owning_org_id);
      const m = p.memberships.map((x) => ({ ...x, idx: chain.indexOf(x.orgId) })).filter((x) => x.idx >= 0).sort((a, b) => a.idx - b.idx)[0]
        ?? p.memberships[0];
      const orgName = m ? p.orgs.byId.get(m.orgId)?.name : p.orgs.byId.get(d.owning_org_id)?.name;
      transaction(db, () => {
        db.prepare(`INSERT INTO document_signatures (document_id, version, sha256, signer_user_id, signer_name, signer_rank, signer_org, capacity, signed_at)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(docId, v.version, v.sha256, p.user.id, p.user.display_name, m?.rankName ?? '', orgName ?? '', capacity, now());
        setStatus(docId, 'SIGNED');
        caseEvent(d.case_id, 'DOCUMENT_SIGNED', p.user.id, `${d.doc_number} signed (version ${v.version})`, { documentId: docId, version: v.version });
        audit.write({ ...reqCtx, action: 'DOCUMENT_SIGN', ...res(d), details: { version: v.version, sha256: v.sha256, capacity } });
      });
      return detail(p, loadVisible(p, reqCtx, docId));
    },

    issue(p, reqCtx, docId) {
      const d = loadVisible(p, reqCtx, docId);
      requireCap(p, 'issue', d);
      transaction(db, () => {
        setStatus(docId, 'ISSUED');
        caseEvent(d.case_id, 'DOCUMENT_ISSUED', p.user.id, `${d.doc_number} issued`, { documentId: docId, version: d.current_version });
        audit.write({ ...reqCtx, action: 'DOCUMENT_ISSUE', ...res(d), details: { version: d.current_version } });
      });
      return detail(p, loadVisible(p, reqCtx, docId));
    },

    revokeSignature(p, reqCtx, docId, signatureId, input) {
      const { reason: why } = schemas.reasonOnly.parse(input);
      const d = loadVisible(p, reqCtx, docId);
      const s = /** @type {any} */ (db.prepare('SELECT * FROM document_signatures WHERE id = ? AND document_id = ?').get(signatureId, docId));
      if (!s) throw notFound();
      if (db.prepare('SELECT 1 FROM signature_revocations WHERE signature_id = ?').get(signatureId)) throw conflict('This signature has already been revoked.');
      if (s.signer_user_id !== p.user.id && !capabilities(p, d).revokeAny) throw forbidden();
      transaction(db, () => {
        db.prepare('INSERT INTO signature_revocations (signature_id, reason, revoked_by, revoked_at) VALUES (?,?,?,?)').run(signatureId, why, p.user.id, now());
        const still = signatures(d).some((x) => x.status === 'VALID');
        if (!still && ['SIGNED', 'ISSUED'].includes(d.status)) setStatus(docId, 'DRAFT');
        caseEvent(d.case_id, 'SIGNATURE_REVOKED', p.user.id, `${d.doc_number}: signature revoked`, { documentId: docId, signatureId, reason: why });
        audit.write({ ...reqCtx, action: 'DOCUMENT_SIGNATURE_REVOKE', ...res(d), details: { signatureId, signer: s.signer_user_id, reason: why } });
      });
      return detail(p, loadVisible(p, reqCtx, docId));
    },

    archive(p, reqCtx, docId, input) {
      const { reason: why } = schemas.reasonOnly.parse(input);
      const d = loadVisible(p, reqCtx, docId);
      requireCap(p, 'archive', d);
      transaction(db, () => {
        setStatus(docId, 'ARCHIVED');
        caseEvent(d.case_id, 'DOCUMENT_ARCHIVED', p.user.id, `${d.doc_number} archived`, { documentId: docId, reason: why });
        audit.write({ ...reqCtx, action: 'DOCUMENT_ARCHIVE', ...res(d), details: { reason: why } });
      });
      return detail(p, loadVisible(p, reqCtx, docId));
    },

    /** Entwürfe ohne Signatur verwerfen (weich gelöscht; Versionen bleiben für das Audit erhalten). */
    remove(p, reqCtx, docId) {
      const d = loadVisible(p, reqCtx, docId);
      requireCap(p, 'delete', d);
      transaction(db, () => {
        setStatus(docId, 'DELETED');
        caseEvent(d.case_id, 'DOCUMENT_DELETED', p.user.id, `Draft ${d.doc_number} discarded`, { documentId: docId });
        audit.write({ ...reqCtx, action: 'DOCUMENT_DELETE', ...res(d) });
      });
      return { deleted: true };
    },

    /** Darf p die Datei herunterladen? Nur über ein sichtbares Dokument – oder eigene, noch nicht verwendete Uploads. Liefert true/false. */
    fileAccess(p, reqCtx, fileId) {
      const v = documentVisibility(db, p);
      const viaDoc = /** @type {any} */ (db.prepare(`SELECT d.* FROM documents d JOIN document_versions dv ON dv.document_id = d.id
        WHERE dv.file_id = ? AND ${v.sql} LIMIT 1`).get(fileId, ...v.params));
      if (viaDoc) {
        if (!p.hasAnywhere('DOCUMENT_DOWNLOAD')) throw forbidden();
        audit.write({ ...reqCtx, action: 'DOCUMENT_DOWNLOAD', ...res(viaDoc), details: { fileId } });
        return true;
      }
      const own = db.prepare(`SELECT 1 FROM files f WHERE f.id = ? AND f.uploaded_by = ? AND NOT EXISTS (SELECT 1 FROM document_versions dv WHERE dv.file_id = f.id)
        AND NOT EXISTS (SELECT 1 FROM evidence_files ef WHERE ef.file_id = f.id)`).get(fileId, p.user.id);
      if (own) return true;
      const any = db.prepare(`SELECT d.* FROM documents d JOIN document_versions dv ON dv.document_id = d.id WHERE dv.file_id = ? LIMIT 1`).get(fileId);
      if (any && reqCtx) audit.write({ ...reqCtx, action: 'DOCUMENT_ACCESS', outcome: 'DENIED', ...res(any), details: { fileId } });
      return false;
    },

    /**
     * Dokument ausdrücklich für eine Organisation freigeben (z. B. Antrag → Gericht, Haftbefehl → USMS).
     * Aufrufer (Fach-Service) hat die Berechtigung geprüft; läuft in dessen Transaktion.
     */
    shareWithOrg(p, reqCtx, docId, orgId, reason) {
      const d = /** @type {any} */ (db.prepare('SELECT * FROM documents WHERE id = ?').get(docId));
      if (db.prepare("SELECT 1 FROM document_access WHERE document_id = ? AND subject_type = 'ORG' AND subject_id = ? AND revoked_at IS NULL").get(docId, orgId)) return;
      db.prepare(`INSERT INTO document_access (document_id, subject_type, subject_id, granted_by, reason, created_at)
        VALUES (?, 'ORG', ?, ?, ?, ?)`).run(docId, orgId, p.user.id, reason, now());
      audit.write({ ...reqCtx, action: 'DOCUMENT_SHARE', ...res(d), details: { orgId, reason } });
    },

    /** Für Tests und Audit-UI: IDs sichtbarer Dokumente */
    visibleIds(p, ids) {
      const v = documentVisibility(db, p);
      return db.prepare(`SELECT d.id FROM documents d WHERE d.id IN (${inList(ids)}) AND ${v.sql}`).all(...ids, ...v.params).map((r) => Number(r.id));
    },
  };
}

module.exports = { createDocumentService };
