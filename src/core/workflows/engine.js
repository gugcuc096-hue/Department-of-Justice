// @ts-check
'use strict';
/**
 * Generische Workflow-Engine (WORKFLOWS.md Abschnitt 1).
 *
 * Die Engine kennt Zustände und Übergänge und protokolliert jeden Wechsel (workflow_actions, append-only).
 * WER handeln darf, prüft der Fach-Service (Permission im richtigen Scope, Akteursrolle, keine Selbstentscheidung),
 * weil das vom Gegenstand abhängt. Die Engine erzwingt:
 *   - Übergang nur aus einem zulässigen Ausgangszustand (sonst 409 INVALID_TRANSITION)
 *   - Pflichtbegründung
 *   - "system"-Übergänge nie durch Benutzeraktionen; humanDecision-Übergänge nie durch das System
 * Aufrufe müssen innerhalb der Transaktion des Fach-Services erfolgen.
 */
const { now, parseJson } = require('../../db');
const { conflict, badRequest } = require('../../http/errors');

/** @param {import('../../db').Database} db */
function createWorkflowEngine(db) {
  const defCache = new Map();

  function definition(code, version) {
    const key = `${code}@${version ?? 'latest'}`;
    if (!defCache.has(key)) {
      const row = /** @type {any} */ (version
        ? db.prepare('SELECT * FROM workflow_definitions WHERE code = ? AND version = ?').get(code, version)
        : db.prepare('SELECT * FROM workflow_definitions WHERE code = ? AND is_active = 1 ORDER BY version DESC LIMIT 1').get(code));
      if (!row) throw new Error(`workflow definition ${code} not found`);
      defCache.set(key, { code: row.code, version: row.version, name: row.name, ...parseJson(row.definition, {}) });
    }
    return defCache.get(key);
  }

  const instanceFor = (subjectType, subjectId) =>
    /** @type {any} */ (db.prepare('SELECT * FROM workflow_instances WHERE subject_type = ? AND subject_id = ?').get(subjectType, subjectId)) ?? null;

  return {
    definition,
    instanceFor,

    /** Neue Instanz im Anfangszustand. */
    start(code, subjectType, subjectId, actorUserId) {
      const def = definition(code);
      const ts = now();
      const { lastInsertRowid } = db.prepare(`INSERT INTO workflow_instances (definition_code, definition_version, subject_type, subject_id, state, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?)`).run(def.code, def.version, subjectType, subjectId, def.initial, ts, ts);
      db.prepare('INSERT INTO workflow_actions (instance_id, from_state, to_state, action, actor_user_id, comment, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(lastInsertRowid, '', def.initial, 'create', actorUserId, '', ts);
      return instanceFor(subjectType, subjectId);
    },

    /** Übergänge, die aus dem aktuellen Zustand grundsätzlich möglich sind (ohne Rechteprüfung). */
    available(instance) {
      const def = definition(instance.definition_code, instance.definition_version);
      return def.transitions.filter((t) => t.from.includes(instance.state));
    },

    /** Übergang-Definition finden oder 409. */
    transitionFor(instance, action) {
      const def = definition(instance.definition_code, instance.definition_version);
      const t = def.transitions.find((x) => x.action === action);
      if (!t || !t.from.includes(instance.state)) {
        throw conflict(`This action is not possible while the application is "${def.states[instance.state]?.label ?? instance.state}".`, 'INVALID_TRANSITION');
      }
      return t;
    },

    /**
     * Übergang ausführen.
     * @param {any} instance
     * @param {string} action
     * @param {{ actorUserId: number|null, comment?: string, bySystem?: boolean }} o
     */
    apply(instance, action, { actorUserId, comment = '', bySystem = false }) {
      const t = this.transitionFor(instance, action);
      if (t.actor === 'system' && !bySystem) throw conflict('This step is performed automatically.', 'INVALID_TRANSITION');
      if (t.humanDecision && (bySystem || !actorUserId)) throw new Error(`transition ${action} requires a human decision`);
      if (t.requireComment && !String(comment).trim()) throw badRequest('A reason is required.', [{ field: 'reason', message: 'Please give a reason.' }]);
      const ts = now();
      db.prepare('UPDATE workflow_instances SET state = ?, updated_at = ? WHERE id = ?').run(t.to, ts, instance.id);
      db.prepare('INSERT INTO workflow_actions (instance_id, from_state, to_state, action, actor_user_id, comment, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(instance.id, instance.state, t.to, action, actorUserId, comment, ts);
      return { from: instance.state, to: t.to, transition: t };
    },

    history(instanceId) {
      return db.prepare(`SELECT a.*, u.display_name AS actor_name FROM workflow_actions a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.instance_id = ? ORDER BY a.id`).all(instanceId).map((a) => ({
        id: a.id, action: a.action, from: a.from_state, to: a.to_state, comment: a.comment, at: a.created_at,
        actor: a.actor_user_id ? { id: a.actor_user_id, name: a.actor_name } : null,
      }));
    },
  };
}

module.exports = { createWorkflowEngine };
