// @ts-check
'use strict';
/**
 * Benachrichtigungen (prompt.txt 6.8, SECURITY_MODEL.md Abschnitt 7).
 *
 * Regeln:
 *  1. Empfänger nur, wer den Gegenstand zum Erstellungszeitpunkt sehen darf (Sichtbarkeitsprüfer je Gegenstandstyp).
 *  2. Beim Anzeigen wird die Sichtbarkeit erneut geprüft – entzogene Zugriffe lassen die Benachrichtigung verschwinden.
 *  3. Versiegelte, sehr hoch eingestufte oder abgeschottete Vorgänge (Compartments) erzeugen nur einen neutralen Text.
 *  4. Benachrichtigungen stammen ausschließlich aus echten Systemereignissen (prompt.txt Abschnitt 1, Regel 2).
 *
 * Module melden ihre Sichtbarkeitsprüfer an: ctx.subjectVisible[type] = (principal, id) => boolean.
 */
const { z } = require('zod');
const { now, inList } = require('../../db');
const { loadPrincipal } = require('../authz/principal');
const { loadOrgTree } = require('../authz/orgs');

const GENERIC = { title: 'New activity in a protected matter', body: 'Open the platform to see details you are authorized for.' };

/**
 * @typedef {object} Note
 * @property {string} type           z. B. "APPLICATION_SUBMITTED"
 * @property {string} title
 * @property {string} [body]
 * @property {string} [link]         z. B. "/app/applications/12"
 * @property {string} [subjectType]  z. B. "application"
 * @property {number} [subjectId]
 * @property {string} [level]        Sicherheitsstufe des Gegenstands
 * @property {string[]} [compartments]
 * @property {boolean} [sealed]
 * @property {string} [dedupeKey]    verhindert doppelte Erinnerungen
 */

/** @param {import('../../app').AppContext} ctx */
function createNotifier(ctx) {
  const { db } = ctx;
  const insert = db.prepare(`INSERT OR IGNORE INTO notifications (user_id, type, title, body, link, subject_type, subject_id, dedupe_key, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const levels = () => new Map(db.prepare('SELECT code, rank FROM security_levels').all().map((r) => [String(r.code), Number(r.rank)]));

  const principalOf = (userId, orgs) => {
    const u = /** @type {any} */ (db.prepare("SELECT * FROM users WHERE id = ? AND status = 'ACTIVE'").get(userId));
    return u ? loadPrincipal(db, u, { orgs }) : null;
  };

  /** Darf p den Gegenstand sehen? Ohne angemeldeten Prüfer: nein (sicherer Standard). */
  function visible(p, type, id) {
    if (!type) return true;
    const check = ctx.subjectVisible?.[type];
    return check ? Boolean(check(p, id)) : false;
  }

  /**
   * Benachrichtigung an Benutzer. Wer den Gegenstand nicht sieht, wird übersprungen; der Auslöser selbst ebenfalls.
   * @param {number[]} userIds @param {Note} n @param {{ exceptUserId?: number }} [opts]
   */
  function toUsers(userIds, n, opts = {}) {
    const orgs = loadOrgTree(db);
    const rank = levels().get(n.level ?? 'INTERNAL') ?? 0;
    const sensitive = Boolean(n.sealed) || (n.compartments?.length ?? 0) > 0 || rank >= (levels().get('SEALED') ?? 4);
    const text = sensitive ? GENERIC : { title: n.title, body: n.body ?? '' };
    let sent = 0;
    for (const uid of new Set(userIds.filter((x) => x && x !== opts.exceptUserId))) {
      const p = principalOf(uid, orgs);
      if (!p || !visible(p, n.subjectType, n.subjectId)) continue;
      const r = insert.run(uid, n.type, text.title, text.body, n.link ?? '', n.subjectType ?? null, n.subjectId ?? null, n.dedupeKey ?? null, now());
      sent += Number(r.changes);
    }
    return sent;
  }

  /**
   * Aktive Benutzer mit Mitgliedschaft im Teilbaum von orgId, die code dort besitzen.
   * @param {number} orgId @param {string} code
   */
  function usersWith(orgId, code) {
    const orgs = loadOrgTree(db);
    const sub = orgs.subtree(orgId);
    const ids = db.prepare(`SELECT DISTINCT u.id FROM users u JOIN memberships m ON m.user_id = u.id
      WHERE u.status = 'ACTIVE' AND m.org_id IN (${inList(sub)})`).all(...sub).map((r) => Number(r.id));
    return ids.filter((id) => principalOf(id, orgs)?.has(code, orgId));
  }

  return { toUsers, usersWith, visible };
}

/** @param {import('../../app').AppContext} ctx */
function createNotificationService(ctx) {
  const { db, audit } = ctx;
  const notifier = createNotifier(ctx);
  const listQuery = z.object({ unread: z.enum(['0', '1']).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });

  /** Nur Benachrichtigungen, deren Gegenstand p (noch) sehen darf. */
  const visibleRows = (p, rows) => rows.filter((r) => notifier.visible(p, r.subject_type, r.subject_id));

  return {
    list(p, query) {
      const f = listQuery.parse(query);
      const rows = db.prepare(`SELECT * FROM notifications WHERE user_id = ? ${f.unread === '1' ? 'AND read_at IS NULL' : ''} ORDER BY id DESC LIMIT 300`).all(p.user.id);
      return { items: visibleRows(p, rows).slice(0, f.limit).map((r) => ({ id: r.id, type: r.type, title: r.title, body: r.body, link: r.link, createdAt: r.created_at, read: Boolean(r.read_at) })) };
    },

    unreadCount(p) {
      const rows = db.prepare('SELECT id, subject_type, subject_id FROM notifications WHERE user_id = ? AND read_at IS NULL ORDER BY id DESC LIMIT 500').all(p.user.id);
      return visibleRows(p, rows).length;
    },

    markRead(p, ids) {
      const list = z.array(z.number().int().positive()).max(500).parse(ids);
      if (list.length) db.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (${inList(list)})`).run(now(), p.user.id, ...list);
    },

    markAllRead(p) {
      db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), p.user.id);
    },

    /**
     * Erinnerungen (idempotent über dedupe_key): Fristen in den nächsten 24 h, überfällige Fristen,
     * Termine in den nächsten 24 h. Wird periodisch vom Server aufgerufen.
     */
    runReminders() {
      const t = Date.now();
      const nowIso = new Date(t).toISOString();
      const in24 = new Date(t + 86_400_000).toISOString();
      let sent = 0;
      const caseInfo = (caseId) => {
        const c = /** @type {any} */ (db.prepare('SELECT case_number, security_level, is_sealed FROM cases WHERE id = ?').get(caseId));
        const comps = db.prepare('SELECT compartment_code c FROM case_compartments WHERE case_id = ?').all(caseId).map((r) => String(r.c));
        return { c, comps };
      };
      for (const d of db.prepare("SELECT * FROM deadlines WHERE status = 'OPEN' AND due_at < ?").all(in24)) {
        const overdue = String(d.due_at) < nowIso;
        const { c, comps } = caseInfo(d.case_id);
        sent += notifier.toUsers([Number(d.responsible_user_id)], {
          type: overdue ? 'DEADLINE_OVERDUE' : 'DEADLINE_DUE_SOON',
          title: overdue ? `Deadline overdue: ${d.title}` : `Deadline due within 24 hours: ${d.title}`,
          body: `${c.case_number} · due ${String(d.due_at).slice(0, 16).replace('T', ' ')} UTC`,
          link: `/app/cases/${d.case_id}?tab=schedule`, subjectType: 'deadline', subjectId: Number(d.id),
          level: c.security_level, compartments: comps, sealed: Boolean(c.is_sealed),
          dedupeKey: `${overdue ? 'deadline-overdue' : 'deadline-soon'}:${d.id}:${d.due_at}`,
        });
      }
      for (const hr of db.prepare("SELECT * FROM hearings WHERE status = 'SCHEDULED' AND starts_at > ? AND starts_at < ?").all(nowIso, in24)) {
        const { c, comps } = caseInfo(hr.case_id);
        const users = [
          ...db.prepare('SELECT user_id FROM hearing_participants WHERE hearing_id = ? AND removed_at IS NULL AND user_id IS NOT NULL').all(hr.id),
          ...db.prepare('SELECT user_id FROM case_participants WHERE case_id = ? AND removed_at IS NULL AND grants_access = 1 AND user_id IS NOT NULL').all(hr.case_id),
        ].map((r) => Number(r.user_id));
        sent += notifier.toUsers(users, {
          type: 'HEARING_REMINDER', title: `Hearing within 24 hours: ${hr.title}`,
          body: `${String(hr.starts_at).slice(0, 16).replace('T', ' ')} UTC · ${hr.room}`, link: `/app/hearings/${hr.id}`,
          subjectType: 'hearing', subjectId: Number(hr.id), level: c.security_level, compartments: comps, sealed: Boolean(c.is_sealed),
          dedupeKey: `hearing-reminder:${hr.id}:${hr.starts_at}`,
        });
      }
      if (sent) audit.write({ action: 'SYSTEM_REMINDERS', details: { sent } });
      return sent;
    },
  };
}

module.exports = { createNotifier, createNotificationService, GENERIC };
