// @ts-check
'use strict';
/**
 * Offizielle Anfragen Institution → Institution (prompt.txt 6.7).
 *
 *   OPEN ── assign ──► ASSIGNED ── start ──► IN_PROGRESS ── respond ──► ANSWERED ── close ──► CLOSED
 *     └────────────── decline (Begründung) ──────────────────────────► DECLINED ── close ──► CLOSED
 *
 * Sichtbarkeit: Absenderseite (Mitglieder der absendenden Organisation mit REQUEST_CREATE/REQUEST_RESPOND),
 * Empfängerseite (Mitglieder der empfangenden Organisation mit REQUEST_RESPOND/REQUEST_ASSIGN), Ersteller,
 * zugewiesene Person. Beigefügte Dokumente werden ausdrücklich für die Empfängerorganisation freigegeben –
 * die Empfängerseite sieht nie die Akte des Absenders.
 */
const { z } = require('zod');
const { transaction, now, inList } = require('../../db');
const { forbidden, notFound, badRequest, conflict } = require('../../http/errors');
const { canViewCase } = require('../cases/visibility');
const { createCaseService } = require('../cases/service');
const { createDocumentService } = require('../documents/service');
const { loadPrincipal } = require('../authz/principal');
const { nextNumber } = require('../numbers');
const { orgRef } = require('../users/me');

const reason = z.string().trim().min(3).max(2000);
const schemas = {
  create: z.object({
    senderOrgId: z.number().int().positive(),
    receiverOrgId: z.number().int().positive(),
    subject: z.string().trim().min(3).max(200),
    body: z.string().trim().min(3).max(10_000),
    priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
    dueAt: z.string().datetime({ offset: true }).nullable().default(null),
    caseId: z.number().int().positive().nullable().default(null),
    documentIds: z.array(z.number().int().positive()).max(30).default([]),
  }),
  assign: z.object({ userId: z.number().int().positive() }),
  respond: z.object({ response: z.string().trim().min(3).max(10_000) }),
  reason: z.object({ reason }),
  list: z.object({
    box: z.enum(['inbox', 'outbox', 'all']).default('all'),
    status: z.enum(['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ANSWERED', 'DECLINED', 'CLOSED', 'ACTIVE']).optional(),
    caseId: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
};

/** @param {import('../../app').AppContext} ctx */
function createRequestService(ctx) {
  const { db, audit } = ctx;
  const cases = createCaseService(ctx);
  const docs = createDocumentService(ctx);

  const res = (r) => ({ resourceType: 'official_request', resourceId: r.id, resourceOrgId: r.receiver_org_id, resourceLevel: r.security_level, resourceCompartments: [] });
  const nameOf = (uid) => (uid ? String(/** @type {any} */ (db.prepare('SELECT display_name FROM users WHERE id = ?').get(uid))?.display_name ?? '') : null);
  const logEvent = (id, type, actor, comment = '') =>
    db.prepare('INSERT INTO official_request_events (request_id, type, actor_user_id, comment, created_at) VALUES (?,?,?,?,?)').run(id, type, actor, comment, now());

  const senderOrgs = (p) => [...new Set([...p.orgsWith('REQUEST_CREATE'), ...p.orgsWith('REQUEST_RESPOND')])];
  const receiverOrgs = (p) => [...new Set([...p.orgsWith('REQUEST_RESPOND'), ...p.orgsWith('REQUEST_ASSIGN')])];

  function visibility(p, alias = 'rq') {
    const s = senderOrgs(p);
    const r = receiverOrgs(p);
    const parts = [`${alias}.created_by = ?`, `${alias}.assigned_user_id = ?`];
    const params = [p.user.id, p.user.id];
    if (s.length) { parts.push(`${alias}.sender_org_id IN (${inList(s)})`); params.push(...s); }
    if (r.length) { parts.push(`${alias}.receiver_org_id IN (${inList(r)})`); params.push(...r); }
    return { sql: `((SELECT rank FROM security_levels WHERE code = ${alias}.security_level) <= ? AND (${parts.join(' OR ')}))`, params: [p.clearanceRank, ...params] };
  }

  function loadVisible(p, reqCtx, id) {
    const v = visibility(p);
    const r = /** @type {any} */ (db.prepare(`SELECT rq.* FROM official_requests rq WHERE rq.id = ? AND ${v.sql}`).get(id, ...v.params));
    if (r) return r;
    const hidden = /** @type {any} */ (db.prepare('SELECT * FROM official_requests WHERE id = ?').get(id));
    if (hidden && reqCtx) audit.write({ ...reqCtx, action: 'REQUEST_ACCESS', outcome: 'DENIED', ...res(hidden) });
    throw notFound();
  }

  function capabilities(p, r) {
    const receiver = p.isMemberWithin(r.receiver_org_id);
    const sender = p.isMemberWithin(r.sender_org_id) || r.created_by === p.user.id;
    const open = ['OPEN', 'ASSIGNED', 'IN_PROGRESS'].includes(r.status);
    return {
      assign: open && receiver && p.has('REQUEST_ASSIGN', r.receiver_org_id),
      start: r.status === 'ASSIGNED' && r.assigned_user_id === p.user.id,
      respond: open && receiver && (r.assigned_user_id === p.user.id || p.has('REQUEST_RESPOND', r.receiver_org_id)),
      decline: open && receiver && p.has('REQUEST_RESPOND', r.receiver_org_id),
      close: ['ANSWERED', 'DECLINED'].includes(r.status) && sender && p.has('REQUEST_CREATE', r.sender_org_id),
    };
  }
  function requireCap(p, reqCtx, cap, r) {
    if (capabilities(p, r)[cap]) return;
    audit.write({ ...reqCtx, action: `REQUEST_${cap.toUpperCase()}`, outcome: 'DENIED', ...res(r) });
    if (['CLOSED', 'ANSWERED', 'DECLINED'].includes(r.status) && cap !== 'close') throw conflict('This request is no longer open.', 'REQUEST_CLOSED');
    throw forbidden();
  }

  function detail(p, r) {
    const attached = db.prepare(`SELECT d.id, d.doc_number, d.title FROM official_request_documents rd JOIN documents d ON d.id = rd.document_id
      WHERE rd.request_id = ? ORDER BY d.id`).all(r.id);
    const visibleDocs = new Set(attached.length ? docs.visibleIds(p, attached.map((x) => Number(x.id))) : []);
    const kase = r.case_id && canViewCase(db, p, r.case_id) ? /** @type {any} */ (db.prepare('SELECT id, case_number FROM cases WHERE id = ?').get(r.case_id)) : null;
    return {
      id: r.id, requestNo: r.request_no, subject: r.subject, body: r.body, priority: r.priority, dueAt: r.due_at, status: r.status,
      securityLevel: r.security_level, sender: orgRef(p.orgs, r.sender_org_id), receiver: orgRef(p.orgs, r.receiver_org_id),
      createdBy: nameOf(r.created_by), createdAt: r.created_at, updatedAt: r.updated_at,
      assignedTo: r.assigned_user_id ? { id: r.assigned_user_id, name: nameOf(r.assigned_user_id) } : null,
      response: r.response, respondedAt: r.responded_at, respondedBy: nameOf(r.responded_by),
      case: kase ? { id: kase.id, caseNumber: kase.case_number } : null,
      documents: attached.filter((x) => visibleDocs.has(Number(x.id))).map((x) => ({ id: x.id, docNumber: x.doc_number, title: x.title })),
      direction: p.isMemberWithin(r.receiver_org_id) ? 'INBOX' : 'OUTBOX',
      history: db.prepare(`SELECT e.*, u.display_name FROM official_request_events e LEFT JOIN users u ON u.id = e.actor_user_id
        WHERE e.request_id = ? ORDER BY e.id`).all(r.id).map((e) => ({ type: e.type, comment: e.comment, at: e.created_at, actor: e.display_name })),
      capabilities: capabilities(p, r),
    };
  }

  /** Absender benachrichtigen (Ersteller + Bearbeiter mit REQUEST_CREATE der absendenden Organisation). */
  const notifySender = (r, type, title, actorId) => ctx.notify?.toUsers([r.created_by, ...ctx.notify.usersWith(r.sender_org_id, 'REQUEST_CREATE')], {
    type, title, body: `${r.request_no} · ${r.subject}`, link: `/app/requests/${r.id}`, subjectType: 'official_request', subjectId: r.id, level: r.security_level,
  }, { exceptUserId: actorId });

  return {
    schemas, visibility,

    create(p, reqCtx, input) {
      const d = schemas.create.parse(input);
      const recv = p.orgs.byId.get(d.receiverOrgId);
      if (!recv || recv.kind === 'PLATFORM' || d.receiverOrgId === d.senderOrgId) throw badRequest('Choose a receiving organization.', [{ field: 'receiverOrgId', message: 'Invalid receiver.' }]);
      if (!p.orgs.byId.has(d.senderOrgId) || !p.isMemberWithin(d.senderOrgId) || !p.has('REQUEST_CREATE', d.senderOrgId)) {
        throw forbidden('You cannot send requests on behalf of this organization.');
      }
      let level = 'INTERNAL';
      if (d.caseId) {
        const c = cases.loadVisible(p, reqCtx, d.caseId);
        const caps = cases.capabilities(p, c);
        if (!(caps.edit || caps.addDocument)) throw forbidden('You must be working on the case to refer to it.');
        level = c.security_level;
      }
      if (d.documentIds.length) {
        if (!d.caseId) throw badRequest('Documents can only be attached from a case.');
        const ok = new Set(docs.visibleIds(p, d.documentIds));
        const inCase = new Set(db.prepare(`SELECT id FROM documents WHERE case_id = ? AND id IN (${inList(d.documentIds)})`).all(d.caseId, ...d.documentIds).map((x) => Number(x.id)));
        if (d.documentIds.some((x) => !ok.has(x) || !inCase.has(x))) throw badRequest('Only documents of the referenced case can be attached.', [{ field: 'documentIds', message: 'Invalid selection.' }]);
      }
      const id = transaction(db, () => {
        const ts = now();
        const no = nextNumber(db, 'REQ');
        const { lastInsertRowid } = db.prepare(`INSERT INTO official_requests (request_no, sender_org_id, receiver_org_id, case_id, subject, body, priority, due_at,
          security_level, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(no, d.senderOrgId, d.receiverOrgId, d.caseId, d.subject, d.body,
          d.priority, d.dueAt ? new Date(d.dueAt).toISOString() : null, level, p.user.id, ts, ts);
        const rid = Number(lastInsertRowid);
        for (const docId of new Set(d.documentIds)) {
          db.prepare('INSERT INTO official_request_documents (request_id, document_id) VALUES (?,?)').run(rid, docId);
          docs.shareWithOrg(p, reqCtx, docId, d.receiverOrgId, `Attached to official request ${no}`);
        }
        logEvent(rid, 'CREATED', p.user.id);
        if (d.caseId) {
          db.prepare('INSERT INTO case_events (case_id, type, actor_user_id, summary, payload, created_at) VALUES (?,?,?,?,?,?)')
            .run(d.caseId, 'REQUEST_SENT', p.user.id, `Official request ${no} sent to ${recv.name}`, JSON.stringify({ requestId: rid }), ts);
        }
        const r = db.prepare('SELECT * FROM official_requests WHERE id = ?').get(rid);
        audit.write({ ...reqCtx, action: 'REQUEST_CREATE', ...res(r), details: { requestNo: no, sender: d.senderOrgId, receiver: d.receiverOrgId, priority: d.priority } });
        ctx.notify?.toUsers([...ctx.notify.usersWith(d.receiverOrgId, 'REQUEST_ASSIGN'), ...ctx.notify.usersWith(d.receiverOrgId, 'REQUEST_RESPOND')], {
          type: 'REQUEST_RECEIVED', title: `Official request from ${p.orgs.byId.get(d.senderOrgId)?.name}`, body: `${no} · ${d.subject} · priority ${d.priority.toLowerCase()}`,
          link: `/app/requests/${rid}`, subjectType: 'official_request', subjectId: rid, level,
        }, { exceptUserId: p.user.id });
        return rid;
      });
      return detail(p, db.prepare('SELECT * FROM official_requests WHERE id = ?').get(id));
    },

    list(p, query) {
      const f = schemas.list.parse(query);
      const v = visibility(p);
      const where = [v.sql];
      const params = [...v.params];
      const mine = [...p.memberAncestorOrgIds()];
      if (f.box === 'inbox') { where.push(`rq.receiver_org_id IN (${inList(mine)})`); params.push(...mine); }
      if (f.box === 'outbox') { where.push(`(rq.sender_org_id IN (${inList(mine)}) OR rq.created_by = ?)`); params.push(...mine, p.user.id); }
      if (f.status === 'ACTIVE') where.push("rq.status IN ('OPEN','ASSIGNED','IN_PROGRESS')");
      else if (f.status) { where.push('rq.status = ?'); params.push(f.status); }
      if (f.caseId) { where.push('rq.case_id = ?'); params.push(f.caseId); }
      const rows = db.prepare(`SELECT rq.* FROM official_requests rq WHERE ${where.join(' AND ')} ORDER BY rq.updated_at DESC LIMIT ?`).all(...params, f.limit);
      return { items: rows.map((r) => { const x = detail(p, r); delete x.history; delete x.body; return x; }) };
    },

    get(p, reqCtx, id) {
      const r = loadVisible(p, reqCtx, id);
      audit.write({ ...reqCtx, action: 'REQUEST_VIEW', ...res(r) });
      return detail(p, r);
    },

    /** Personen der Empfängerorganisation, denen zugewiesen werden kann. */
    assignees(p, reqCtx, id) {
      const r = loadVisible(p, reqCtx, id);
      requireCap(p, reqCtx, 'assign', r);
      return ctx.notify.usersWith(r.receiver_org_id, 'REQUEST_RESPOND').map((uid) => ({ id: uid, name: nameOf(uid) }));
    },

    assign(p, reqCtx, id, input) {
      const d = schemas.assign.parse(input);
      const r = loadVisible(p, reqCtx, id);
      requireCap(p, reqCtx, 'assign', r);
      const u = /** @type {any} */ (db.prepare("SELECT * FROM users WHERE id = ? AND status = 'ACTIVE'").get(d.userId));
      const up = u ? loadPrincipal(db, u, { orgs: p.orgs }) : null;
      if (!up || !up.isMemberWithin(r.receiver_org_id) || !up.has('REQUEST_RESPOND', r.receiver_org_id) || !up.clearedFor(r.security_level)) {
        throw badRequest('This person cannot handle the request.', [{ field: 'userId', message: 'Choose a member of the receiving organization.' }]);
      }
      transaction(db, () => {
        db.prepare("UPDATE official_requests SET assigned_user_id = ?, status = 'ASSIGNED', updated_at = ? WHERE id = ?").run(u.id, now(), id);
        logEvent(id, 'ASSIGNED', p.user.id, u.display_name);
        audit.write({ ...reqCtx, action: 'REQUEST_ASSIGN', ...res(r), details: { userId: u.id } });
        ctx.notify?.toUsers([u.id], { type: 'REQUEST_ASSIGNED', title: `Official request assigned to you: ${r.subject}`, body: r.request_no,
          link: `/app/requests/${id}`, subjectType: 'official_request', subjectId: id, level: r.security_level }, { exceptUserId: p.user.id });
      });
      return detail(p, loadVisible(p, reqCtx, id));
    },

    start(p, reqCtx, id) {
      const r = loadVisible(p, reqCtx, id);
      requireCap(p, reqCtx, 'start', r);
      transaction(db, () => {
        db.prepare("UPDATE official_requests SET status = 'IN_PROGRESS', updated_at = ? WHERE id = ?").run(now(), id);
        logEvent(id, 'IN_PROGRESS', p.user.id);
        audit.write({ ...reqCtx, action: 'REQUEST_START', ...res(r) });
      });
      return detail(p, loadVisible(p, reqCtx, id));
    },

    respond(p, reqCtx, id, input) {
      const d = schemas.respond.parse(input);
      const r = loadVisible(p, reqCtx, id);
      requireCap(p, reqCtx, 'respond', r);
      transaction(db, () => {
        const ts = now();
        db.prepare("UPDATE official_requests SET status = 'ANSWERED', response = ?, responded_at = ?, responded_by = ?, updated_at = ? WHERE id = ?").run(d.response, ts, p.user.id, ts, id);
        logEvent(id, 'ANSWERED', p.user.id);
        audit.write({ ...reqCtx, action: 'REQUEST_RESPOND', ...res(r) });
        notifySender(r, 'REQUEST_ANSWERED', `Your official request was answered: ${r.subject}`, p.user.id);
      });
      return detail(p, loadVisible(p, reqCtx, id));
    },

    decline(p, reqCtx, id, input) {
      const { reason: why } = schemas.reason.parse(input);
      const r = loadVisible(p, reqCtx, id);
      requireCap(p, reqCtx, 'decline', r);
      transaction(db, () => {
        const ts = now();
        db.prepare("UPDATE official_requests SET status = 'DECLINED', response = ?, responded_at = ?, responded_by = ?, updated_at = ? WHERE id = ?").run(why, ts, p.user.id, ts, id);
        logEvent(id, 'DECLINED', p.user.id, why);
        audit.write({ ...reqCtx, action: 'REQUEST_DECLINE', ...res(r), details: { reason: why } });
        notifySender(r, 'REQUEST_DECLINED', `Your official request was declined: ${r.subject}`, p.user.id);
      });
      return detail(p, loadVisible(p, reqCtx, id));
    },

    close(p, reqCtx, id) {
      const r = loadVisible(p, reqCtx, id);
      requireCap(p, reqCtx, 'close', r);
      transaction(db, () => {
        db.prepare("UPDATE official_requests SET status = 'CLOSED', updated_at = ? WHERE id = ?").run(now(), id);
        logEvent(id, 'CLOSED', p.user.id);
        audit.write({ ...reqCtx, action: 'REQUEST_CLOSE', ...res(r) });
      });
      return detail(p, loadVisible(p, reqCtx, id));
    },

    canView(p, id) {
      const v = visibility(p);
      return Boolean(db.prepare(`SELECT 1 FROM official_requests rq WHERE rq.id = ? AND ${v.sql}`).get(id, ...v.params));
    },
  };
}

module.exports = { createRequestService };
