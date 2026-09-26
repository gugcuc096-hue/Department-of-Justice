// @ts-check
'use strict';
/**
 * Idempotenter Seed: legt fehlende Stammdaten an, überschreibt aber nie, was Administratoren geändert haben.
 * Rollen erhalten ihre Standard-Permissions nur beim erstmaligen Anlegen.
 */
const { transaction } = require('../index');
const { hashPasswordSync, validatePassword } = require('../../core/auth/passwords');
const { createAudit } = require('../../core/audit/audit');
const C = require('./catalog');
const D = require('./documents');
const { WORKFLOWS } = require('../../core/workflows/definitions');

/**
 * @param {import('../index').Database} db
 * @param {{ config: import('../../config').Config, logger: import('../../http/logger').Logger }} deps
 */
function seed(db, { config, logger }) {
  transaction(db, () => {
    seedOrganizations(db);
    seedRanks(db);

    const perm = db.prepare('INSERT OR IGNORE INTO permissions (code, category, description) VALUES (?,?,?)');
    for (const [code, category, description] of C.PERMISSIONS) perm.run(code, category, description);

    const level = db.prepare('INSERT OR IGNORE INTO security_levels (code, rank, name) VALUES (?,?,?)');
    for (const [code, rank, name] of C.SECURITY_LEVELS) level.run(code, rank, name);

    const comp = db.prepare(`INSERT OR IGNORE INTO compartments (code, name, owner_org_id)
      VALUES (?, ?, (SELECT id FROM organizations WHERE code = ?))`);
    for (const c of C.COMPARTMENTS) comp.run(c.code, c.name, c.owner);

    const profile = db.prepare(`INSERT OR IGNORE INTO security_profiles (code, name, level_code, compartments, requires_explicit_access)
      VALUES (?,?,?,?,?)`);
    for (const p of C.SECURITY_PROFILES) profile.run(p.code, p.name, p.level, JSON.stringify(p.compartments), p.explicit ? 1 : 0);

    seedRoles(db);

    const flag = db.prepare('INSERT OR IGNORE INTO feature_flags (code, name, enabled, legal_status, note) VALUES (?,?,?,?,?)');
    for (const [code, name, enabled, note] of C.FEATURE_FLAGS) flag.run(code, name, enabled, 'NOT_VERIFIED', note);

    seedCaseTypes(db);
    seedDocuments(db);
  });

  bootstrapAdmin(db, config, logger);
}

function seedOrganizations(db) {
  const find = db.prepare('SELECT id FROM organizations WHERE code = ?');
  const insert = db.prepare(`INSERT INTO organizations (parent_id, kind, code, name, short_name, subtitle, brand_code, sort_order)
    VALUES (?,?,?,?,?,?,?,?)`);
  C.ORGANIZATIONS.forEach((o, i) => {
    if (find.get(o.code)) return;
    const parentId = o.parent ? /** @type {any} */ (find.get(o.parent)).id : null;
    insert.run(parentId, o.kind, o.code, o.name, o.short, o.subtitle ?? '', o.brand ?? null, i);
  });
}

function seedRanks(db) {
  const insert = db.prepare(`INSERT OR IGNORE INTO ranks (org_id, code, name, level)
    VALUES ((SELECT id FROM organizations WHERE code = ?), ?, ?, ?)`);
  for (const [org, names] of Object.entries(C.RANKS)) {
    names.forEach((name, i) => insert.run(org, C.rankCode(name), name, i + 1));
  }
}

function seedRoles(db) {
  const find = db.prepare('SELECT id FROM roles WHERE code = ?');
  const insert = db.prepare('INSERT INTO roles (code, name, description, is_system) VALUES (?,?,?,?)');
  const grant = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_code) VALUES (?,?)');
  for (const r of C.ROLES) {
    if (find.get(r.code)) continue;
    const { lastInsertRowid } = insert.run(r.code, r.name, r.description ?? '', r.system ? 1 : 0);
    for (const p of new Set(r.permissions)) grant.run(lastInsertRowid, p);
  }
}

function seedCaseTypes(db) {
  const insert = db.prepare(`INSERT OR IGNORE INTO case_types
    (code, name, default_security_profile, default_org_access, edit_scope, feature_flag, sort_order) VALUES (?,?,?,1,?,?,?)`);
  const org = db.prepare(`INSERT OR IGNORE INTO case_type_orgs (type_code, org_id, number_prefix)
    VALUES (?, (SELECT id FROM organizations WHERE code = ?), ?)`);
  C.CASE_TYPES.forEach((t, i) => {
    insert.run(t.code, t.name, t.profile, t.editScope ?? 'PARTICIPANTS_AND_SUPERVISORS', t.flag ?? null, i);
    for (const [orgCode, prefix] of t.orgs) org.run(t.code, orgCode, prefix);
  });
}

/** Vorlagen (Version 1) und Dokumenttypen – nur anlegen, was fehlt. */
function seedDocuments(db) {
  const tpl = db.prepare(`INSERT OR IGNORE INTO document_templates (code, version, name, fields, body, created_at)
    VALUES (?, 1, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
  for (const t of D.TEMPLATES) tpl.run(t.code, t.name, JSON.stringify(t.fields), t.body);
  const type = db.prepare(`INSERT OR IGNORE INTO document_types
    (code, name, number_suffix, template_code, sign_permission, allowed_orgs, feature_flag, sort_order, workflow_only) VALUES (?,?,?,?,?,?,?,?,?)`);
  D.DOCUMENT_TYPES.forEach((t, i) => type.run(t.code, t.name, t.suffix, t.template, t.sign, t.orgs ? JSON.stringify(t.orgs) : null, t.flag ?? null, i, t.workflowOnly ? 1 : 0));
  const wf = db.prepare(`INSERT OR IGNORE INTO workflow_definitions (code, version, name, definition, created_at)
    VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
  for (const w of WORKFLOWS) wf.run(w.code, w.version, w.name, JSON.stringify(w.definition));
}

/**
 * Legt den ersten System Admin an – nur wenn noch kein Benutzer existiert.
 * Das Passwort muss beim ersten Login geändert werden.
 */
function bootstrapAdmin(db, config, logger) {
  const count = Number(/** @type {any} */ (db.prepare('SELECT COUNT(*) AS n FROM users').get()).n);
  if (count > 0) return;
  if (!config.bootstrapAdmin) {
    logger.warn('no users exist – set BOOTSTRAP_ADMIN_USER and BOOTSTRAP_ADMIN_PASSWORD to create the first system administrator');
    return;
  }
  const { username, password } = config.bootstrapAdmin;
  const problem = validatePassword(password);
  if (problem) throw new Error(`BOOTSTRAP_ADMIN_PASSWORD: ${problem}`);

  transaction(db, () => {
    const { lastInsertRowid: userId } = db.prepare(`INSERT INTO users
      (username, display_name, password_hash, must_change_password, clearance_level) VALUES (?, ?, ?, 1, 'CLASSIFIED')`)
      .run(username, 'System Administrator', hashPasswordSync(password, config.bcryptCost));
    db.prepare(`INSERT INTO memberships (user_id, org_id, is_primary) VALUES (?, (SELECT id FROM organizations WHERE code = 'SJCS'), 1)`)
      .run(userId);
    db.prepare(`INSERT INTO user_roles (user_id, role_id, scope_org_id, reason)
      VALUES (?, (SELECT id FROM roles WHERE code = 'SYSTEM_ADMIN'), NULL, 'Bootstrap')`).run(userId);
    createAudit(db).write({
      action: 'SYSTEM_BOOTSTRAP_ADMIN', resourceType: 'user', resourceId: Number(userId), details: { username },
    });
  });
  logger.info('bootstrap system administrator created – password change required at first login', { username });
}

module.exports = { seed };
