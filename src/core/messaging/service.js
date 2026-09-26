// @ts-check
'use strict';
/**
 * Interne Kommunikation (prompt.txt 6.7).
 *
 *   DIRECT      benannte Personen (Benutzer ↔ Benutzer)
 *   CASE        alle, die die Akte sehen dürfen (Beteiligte ↔ Beteiligte) – folgt Stufe, Compartments, Sealing
 *   DEPARTMENT  Organisation ↔ Organisation; lesen: Mitglieder beider Organisationen mit MESSAGE_SEND,
 *               schreiben im Namen der Organisation: MESSAGE_DEPARTMENT
 * Nachrichten sind unveränderlich. Workflow-Nachrichten des Systems laufen über Benachrichtigungen.
 */
const { z } = require('zod');
const { transaction, now, inList } = require('../../db');
const { forbidden, notFound, badRequest } = require('../../http/errors');
const { caseVisibility, canViewCase } = require('../cases/visibility');
const { orgRef } = require('../users/me');

const body = z.string().trim().min(1).max(10_000);
const schemas = {
  create: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('DIRECT'), userIds: z.array(z.number().int().positive()).min(1).max(20), subject: z.string().trim().min(2).max(200), body }),
    z.object({ kind: z.literal('CASE'), caseId: z.number().int().positive(), subject: z.string().trim().min(2).max(200), body }),
    z.object({ kind: z.literal('DEPARTMENT'), fromOrgId: z.number().int().positive(), toOrgId: z.number().int().positive(), subject: z.string().trim().min(2).max(200), body }),
  ]),
  message: z.object({ body }),
  list: z.object({ caseId: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }),
};

/** @param {import('../../app').AppContext} ctx */
function createMessagingService(ctx) {
  const { db, audit } = ctx;

  const comps = (caseId) => (caseId ? db.prepare('SELECT compartment_code c FROM case_compartments WHERE case_id = ?').all(caseId).map((r) => String(r.c)) : []);
  const res = (c) => ({ resourceType: 'conversation', resourceId: c.id, resourceLevel: c.security_level, resourceCompartments: comps(c.case_id) });
  const nameOf = (uid) => String(/** @type {any} */ (db.prepare('SELECT display_name FROM users WHERE id = ?').get(uid))?.display_name ?? '');

  function visibility(p, alias = 'cv') {
    const v = caseVisibility(db, p, { alias: 'cvc' });
    const parts = [
      `(${alias}.kind = 'DIRECT' AND EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = ${alias}.id AND cm.user_id = ?))`,
      `(${alias}.kind = 'CASE' AND EXISTS (SELECT 1 FROM cases cvc WHERE cvc.id = ${alias}.case_id AND ${v.sql}))`,
    ];
    const params = [p.user.id, ...v.params];
    const mine = [...p.memberAncestorOrgIds()];
    if (p.hasAnywhere('MESSAGE_SEND') && mine.length) {
      parts.push(`(${alias}.kind = 'DEPARTMENT' AND (${alias}.org_a_id IN (${inList(mine)}) OR ${alias}.org_b_id IN (${inList(mine)})))`);
      params.push(...mine, ...mine);
    }
    return { sql: `((SELECT rank FROM security_levels WHERE code = ${alias}.security_level) <= ? AND (${parts.join(' OR ')}))`, params: [p.clearanceRank, ...params] };
  }

  function loadVisible(p, reqCtx, id) {
    const v = visibility(p);
    const c = /** @type {any} */ (db.prepare(`SELECT cv.* FROM conversations cv WHERE cv.id = ? AND ${v.sql}`).get(id, ...v.params));
    if (c) return c;
    const hidden = /** @type {any} */ (db.prepare('SELECT * FROM conversations WHERE id = ?').get(id));
    if (hidden && reqCtx) audit.write({ ...reqCtx, action: 'CONVERSATION_ACCESS', outcome: 'DENIED', ...res(hidden) });
    throw notFound();
  }

  /** Empfänger einer neuen Nachricht (ohne Absender); Sichtbarkeit prüft der Notifier. */
  function recipients(c) {
    if (c.kind === 'DIRECT') return db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?').all(c.id).map((r) => Number(r.user_id));
    if (c.kind === 'CASE') return db.prepare('SELECT user_id FROM case_participants WHERE case_id = ? AND removed_at IS NULL AND grants_access = 1 AND user_id IS NOT NULL').all(c.case_id).map((r) => Number(r.user_id));
    return [...ctx.notify.usersWith(c.org_a_id, 'MESSAGE_DEPARTMENT'), ...ctx.notify.usersWith(c.org_b_id, 'MESSAGE_DEPARTMENT')];
  }

  /** Darf p hier schreiben? Abteilungsunterhaltungen nur im Namen einer der beiden Organisationen. */
  function senderOrg(p, c) {
    if (c.kind !== 'DEPARTMENT') return p.hasAnywhere('MESSAGE_SEND') ? null : false;
    for (const org of [c.org_a_id, c.org_b_id]) if (p.isMemberWithin(org) && p.has('MESSAGE_DEPARTMENT', org)) return org;
    return false;
  }

  function post(p, c, text) {
    const org = senderOrg(p, c);
    if (org === false) throw forbidden('You cannot write in this conversation.');
    const ts = now();
    const { lastInsertRowid } = db.prepare('INSERT INTO messages (conversation_id, sender_user_id, sender_org_id, body, created_at) VALUES (?,?,?,?,?)')
      .run(c.id, p.user.id, org, text, ts);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(ts, c.id);
    db.prepare(`INSERT INTO conversation_reads (conversation_id, user_id, last_read_message_id) VALUES (?,?,?)
      ON CONFLICT DO UPDATE SET last_read_message_id = excluded.last_read_message_id`).run(c.id, p.user.id, lastInsertRowid);
    const caseRow = c.case_id ? /** @type {any} */ (db.prepare('SELECT is_sealed FROM cases WHERE id = ?').get(c.case_id)) : null;
    ctx.notify?.toUsers(recipients(c), {
      type: 'MESSAGE', title: `New message: ${c.subject}`, body: `${p.user.display_name}${org ? ` (${p.orgs.byId.get(org)?.short_name})` : ''}`,
      link: `/app/messages/${c.id}`, subjectType: 'conversation', subjectId: c.id, level: c.security_level,
      compartments: comps(c.case_id), sealed: Boolean(caseRow?.is_sealed), dedupeKey: `message:${lastInsertRowid}`,
    }, { exceptUserId: p.user.id });
    return Number(lastInsertRowid);
  }

  function unread(p, conversationId) {
    const r = /** @type {any} */ (db.prepare('SELECT last_read_message_id FROM conversation_reads WHERE conversation_id = ? AND user_id = ?').get(conversationId, p.user.id));
    return Number(/** @type {any} */ (db.prepare('SELECT COUNT(*) n FROM messages WHERE conversation_id = ? AND id > ? AND sender_user_id <> ?')
      .get(conversationId, r?.last_read_message_id ?? 0, p.user.id)).n);
  }

  function summary(p, c) {
    const last = /** @type {any} */ (db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(c.id));
    const kase = c.case_id && canViewCase(db, p, c.case_id) ? /** @type {any} */ (db.prepare('SELECT id, case_number FROM cases WHERE id = ?').get(c.case_id)) : null;
    return {
      id: c.id, kind: c.kind, subject: c.subject, securityLevel: c.security_level, updatedAt: c.updated_at,
      case: kase ? { id: kase.id, caseNumber: kase.case_number } : null,
      orgs: c.kind === 'DEPARTMENT' ? [orgRef(p.orgs, c.org_a_id), orgRef(p.orgs, c.org_b_id)] : null,
      members: c.kind === 'DIRECT' ? db.prepare(`SELECT u.id, u.display_name FROM conversation_members cm JOIN users u ON u.id = cm.user_id
        WHERE cm.conversation_id = ? ORDER BY u.display_name`).all(c.id).map((u) => ({ id: u.id, name: u.display_name })) : null,
      lastMessage: last ? { at: last.created_at, sender: nameOf(last.sender_user_id), preview: String(last.body).slice(0, 120) } : null,
      unread: unread(p, c.id),
    };
  }

  return {
    schemas, visibility,

    create(p, reqCtx, input) {
      const d = schemas.create.parse(input);
      if (!p.hasAnywhere('MESSAGE_SEND')) throw forbidden();
      let level = 'INTERNAL';
      let caseId = null;
      let orgA = null;
      let orgB = null;
      const members = new Set([p.user.id]);
      if (d.kind === 'DIRECT') {
        for (const uid of d.userIds) {
          const u = /** @type {any} */ (db.prepare("SELECT * FROM users WHERE id = ? AND status = 'ACTIVE'").get(uid));
          if (!u) throw badRequest('Unknown or inactive recipient.', [{ field: 'userIds', message: 'Unknown recipient.' }]);
          members.add(uid);
        }
        if (members.size < 2) throw badRequest('Choose at least one other person.');
      } else if (d.kind === 'CASE') {
        if (!canViewCase(db, p, d.caseId)) throw notFound();
        const c = /** @type {any} */ (db.prepare('SELECT * FROM cases WHERE id = ?').get(d.caseId));
        caseId = c.id;
        level = c.security_level;
      } else {
        if (d.fromOrgId === d.toOrgId || !p.orgs.byId.has(d.toOrgId) || !p.orgs.byId.has(d.fromOrgId)) throw badRequest('Choose two different organizations.');
        if (!p.isMemberWithin(d.fromOrgId) || !p.has('MESSAGE_DEPARTMENT', d.fromOrgId)) throw forbidden('You cannot write on behalf of this organization.');
        orgA = d.fromOrgId;
        orgB = d.toOrgId;
      }
      const id = transaction(db, () => {
        const ts = now();
        const { lastInsertRowid } = db.prepare(`INSERT INTO conversations (kind, subject, case_id, org_a_id, org_b_id, security_level, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(d.kind, d.subject, caseId, orgA, orgB, level, p.user.id, ts, ts);
        const cid = Number(lastInsertRowid);
        if (d.kind === 'DIRECT') for (const uid of members) db.prepare('INSERT INTO conversation_members (conversation_id, user_id, added_at) VALUES (?,?,?)').run(cid, uid, ts);
        const c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(cid);
        post(p, c, d.body);
        audit.write({ ...reqCtx, action: 'CONVERSATION_CREATE', ...res(c), details: { kind: d.kind, caseId, orgA, orgB } });
        return cid;
      });
      return this.get(p, reqCtx, id);
    },

    list(p, query) {
      const f = schemas.list.parse(query);
      const v = visibility(p);
      const where = [v.sql];
      const params = [...v.params];
      if (f.caseId) { where.push('cv.case_id = ?'); params.push(f.caseId); }
      const rows = db.prepare(`SELECT cv.* FROM conversations cv WHERE ${where.join(' AND ')} ORDER BY cv.updated_at DESC LIMIT ?`).all(...params, f.limit);
      return { items: rows.map((c) => summary(p, c)) };
    },

    unreadTotal(p) {
      const v = visibility(p);
      return db.prepare(`SELECT cv.id FROM conversations cv WHERE ${v.sql} ORDER BY cv.updated_at DESC LIMIT 200`).all(...v.params)
        .reduce((n, r) => n + unread(p, Number(r.id)), 0);
    },

    /** Unterhaltung mit Nachrichten; markiert als gelesen. */
    get(p, reqCtx, id) {
      const c = loadVisible(p, reqCtx, id);
      const msgs = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(id);
      if (msgs.length) {
        db.prepare(`INSERT INTO conversation_reads (conversation_id, user_id, last_read_message_id) VALUES (?,?,?)
          ON CONFLICT DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id)`).run(id, p.user.id, msgs.at(-1).id);
      }
      return {
        ...summary(p, c),
        canWrite: senderOrg(p, c) !== false,
        messages: msgs.map((m) => ({ id: m.id, at: m.created_at, sender: { id: m.sender_user_id, name: nameOf(m.sender_user_id) },
          onBehalfOf: m.sender_org_id ? orgRef(p.orgs, Number(m.sender_org_id)) : null, body: m.body, mine: m.sender_user_id === p.user.id })),
      };
    },

    reply(p, reqCtx, id, input) {
      const d = schemas.message.parse(input);
      const c = loadVisible(p, reqCtx, id);
      transaction(db, () => {
        const mid = post(p, c, d.body);
        audit.write({ ...reqCtx, action: 'MESSAGE_SEND', ...res(c), details: { messageId: mid } });
      });
      return this.get(p, reqCtx, id);
    },

    /** Für den Notifier: Sichtbarkeit einer Unterhaltung. */
    canView(p, id) {
      const v = visibility(p);
      return Boolean(db.prepare(`SELECT 1 FROM conversations cv WHERE cv.id = ? AND ${v.sql}`).get(id, ...v.params));
    },
  };
}

module.exports = { createMessagingService };
