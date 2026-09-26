// @ts-check
'use strict';
/**
 * Audit Log: append-only (Trigger in 001_core.sql) und hash-verkettet (ADR-009).
 * hash = sha256(prev_hash + kanonisches JSON des Eintrags). verify() erkennt jede nachträgliche
 * Veränderung, Löschung oder Einfügung direkt in der Datenbankdatei.
 *
 * Audit-Einträge werden in derselben Transaktion wie die fachliche Änderung geschrieben:
 * ohne Audit-Eintrag keine Änderung.
 */
const crypto = require('crypto');
const { now } = require('../../db');

const GENESIS = '0'.repeat(64);

// Feste Reihenfolge = kanonische Form. Neue Felder nur am Ende ergänzen (sonst bricht verify für Altbestand).
const FIELDS = /** @type {const} */ ([
  'ts', 'actor_user_id', 'session_hash', 'active_org_id', 'action', 'resource_type', 'resource_id',
  'resource_org_id', 'resource_level', 'resource_compartments', 'ip', 'user_agent', 'outcome', 'details',
]);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const canonical = (row) => JSON.stringify(FIELDS.map((f) => row[f] ?? null));

/**
 * @typedef {object} AuditEntry
 * @property {string} action                 z. B. "AUTH_LOGIN", "CASE_VIEW", "ROLE_ASSIGN"
 * @property {'SUCCESS'|'DENIED'|'FAILURE'} [outcome]
 * @property {number|null} [actorUserId]
 * @property {string|null} [sessionHash]
 * @property {number|null} [activeOrgId]
 * @property {string|null} [resourceType]
 * @property {string|number|null} [resourceId]
 * @property {number|null} [resourceOrgId]
 * @property {string|null} [resourceLevel]
 * @property {string[]} [resourceCompartments]
 * @property {string} [ip]
 * @property {string} [userAgent]
 * @property {object} [details]              niemals Passwörter/Token/Akteninhalte
 */

/** @param {import('../../db').Database} db */
function createAudit(db) {
  const lastHash = db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
  const insert = db.prepare(`INSERT INTO audit_log
    (ts, actor_user_id, session_hash, active_org_id, action, resource_type, resource_id, resource_org_id,
     resource_level, resource_compartments, ip, user_agent, outcome, details, prev_hash, hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  /** @param {AuditEntry} e */
  function write(e) {
    const row = {
      ts: now(),
      actor_user_id: e.actorUserId ?? null,
      session_hash: e.sessionHash ?? null,
      active_org_id: e.activeOrgId ?? null,
      action: e.action,
      resource_type: e.resourceType ?? null,
      resource_id: e.resourceId == null ? null : String(e.resourceId),
      resource_org_id: e.resourceOrgId ?? null,
      resource_level: e.resourceLevel ?? null,
      resource_compartments: JSON.stringify([...(e.resourceCompartments ?? [])].sort()),
      ip: e.ip ?? '',
      user_agent: (e.userAgent ?? '').slice(0, 300),
      outcome: e.outcome ?? 'SUCCESS',
      details: JSON.stringify(e.details ?? {}),
    };
    const prev = /** @type {any} */ (lastHash.get())?.hash ?? GENESIS;
    const hash = sha256(prev + canonical(row));
    insert.run(row.ts, row.actor_user_id, row.session_hash, row.active_org_id, row.action, row.resource_type,
      row.resource_id, row.resource_org_id, row.resource_level, row.resource_compartments, row.ip, row.user_agent,
      row.outcome, row.details, prev, hash);
    return hash;
  }

  /** Prüft die gesamte Kette. @returns {{ ok: boolean, entries: number, brokenAtId: number|null }} */
  function verify() {
    let prev = GENESIS;
    let entries = 0;
    for (const r of db.prepare('SELECT * FROM audit_log ORDER BY id').iterate()) {
      const row = /** @type {any} */ (r);
      if (row.prev_hash !== prev || sha256(prev + canonical(row)) !== row.hash) {
        return { ok: false, entries, brokenAtId: Number(row.id) };
      }
      prev = row.hash;
      entries++;
    }
    return { ok: true, entries, brokenAtId: null };
  }

  return { write, verify };
}

/**
 * Audit-Kontext aus einem Request (Actor, Session, IP, User-Agent).
 * @param {import('express').Request} req
 */
function requestContext(req) {
  const auth = /** @type {any} */ (req).auth;
  return {
    actorUserId: auth?.user?.id ?? null,
    sessionHash: auth?.session?.token_hash ? String(auth.session.token_hash).slice(0, 16) : null,
    activeOrgId: auth?.session?.active_org_id ?? null,
    ip: req.ip ?? '',
    userAgent: req.get('user-agent') ?? '',
  };
}

module.exports = { createAudit, requestContext, GENESIS };
