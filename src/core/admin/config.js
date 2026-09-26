// @ts-check
'use strict';
/**
 * Administration Center: Organisationen, Ränge, Rollen, Permission-Katalog, Feature Flags.
 * Nichts davon ist hartcodiert (prompt.txt 5.9, 10.5); der Seed liefert nur den Startbestand.
 */
const { z } = require('zod');
const { transaction, now } = require('../../db');
const { forbidden, notFound, badRequest, conflict } = require('../../http/errors');
const { orgRef } = require('../users/me');

const id = z.number().int().positive();
const code = z.string().trim().min(2).max(40).regex(/^[A-Z0-9_]+$/, 'Uppercase letters, digits and underscores only.');
const reason = z.string().trim().min(3).max(500);

const schemas = {
  org: z.object({
    parentId: id,
    kind: z.enum(['INSTITUTION', 'OFFICE', 'COURT', 'DIVISION', 'AUTHORITY']),
    code,
    name: z.string().trim().min(2).max(160),
    shortName: z.string().trim().min(1).max(60),
    subtitle: z.string().trim().max(160).default(''),
  }),
  orgUpdate: z.object({
    name: z.string().trim().min(2).max(160).optional(),
    shortName: z.string().trim().min(1).max(60).optional(),
    subtitle: z.string().trim().max(160).optional(),
    isActive: z.boolean().optional(),
  }),
  rank: z.object({ code, name: z.string().trim().min(2).max(80), level: z.number().int().min(1).max(100) }),
  rankUpdate: z.object({ name: z.string().trim().min(2).max(80).optional(), level: z.number().int().min(1).max(100).optional(), isActive: z.boolean().optional() }),
  role: z.object({ code, name: z.string().trim().min(2).max(80), description: z.string().trim().max(500).default('') }),
  rolePermissions: z.object({ permissions: z.array(z.string().min(2).max(64)).max(300), reason }),
  flag: z.object({ enabled: z.boolean(), legalStatus: z.enum(['VERIFIED', 'NOT_VERIFIED']).optional(), note: z.string().trim().max(1000).optional(), reason }),
};

/** @param {import('../../app').AppContext} ctx */
function createConfigAdmin(ctx) {
  const { db, audit } = ctx;

  const rankRow = (r) => ({ id: r.id, orgId: r.org_id, code: r.code, name: r.name, level: r.level, isActive: Boolean(r.is_active) });

  return {
    schemas,

    /** Organisationsbaum mit Rängen (für alle angemeldeten Benutzer lesbar). @param {import('../authz/principal').Principal} p */
    orgTree(p) {
      const ranks = db.prepare('SELECT * FROM ranks ORDER BY org_id, level DESC').all();
      return p.orgs.rows.map((o) => ({
        ...orgRef(p.orgs, o.id), parentId: o.parent_id, isActive: Boolean(o.is_active), sortOrder: o.sort_order,
        ranks: ranks.filter((r) => r.org_id === o.id).map(rankRow),
      }));
    },

    createOrg(p, reqCtx, input) {
      const d = schemas.org.parse(input);
      if (!p.has('ORG_MANAGE', null)) throw forbidden();
      if (!p.orgs.byId.has(d.parentId)) throw badRequest('Unknown parent organization.');
      if (p.orgs.byCode.has(d.code)) throw conflict('This code is already in use.');
      return transaction(db, () => {
        const { lastInsertRowid } = db.prepare(`INSERT INTO organizations (parent_id, kind, code, name, short_name, subtitle, sort_order)
          VALUES (?,?,?,?,?,?, (SELECT IFNULL(MAX(sort_order), 0) + 1 FROM organizations))`).run(d.parentId, d.kind, d.code, d.name, d.shortName, d.subtitle);
        audit.write({ ...reqCtx, action: 'ORG_CREATE', resourceType: 'organization', resourceId: Number(lastInsertRowid), resourceOrgId: Number(lastInsertRowid), details: d });
        return { id: Number(lastInsertRowid) };
      });
    },

    updateOrg(p, reqCtx, orgId, input) {
      const d = schemas.orgUpdate.parse(input);
      if (!p.has('ORG_MANAGE', null)) throw forbidden();
      const o = p.orgs.byId.get(orgId);
      if (!o) throw notFound();
      if (o.kind === 'PLATFORM' && d.isActive === false) throw badRequest('The platform organization cannot be deactivated.');
      transaction(db, () => {
        db.prepare(`UPDATE organizations SET name = COALESCE(?, name), short_name = COALESCE(?, short_name), subtitle = COALESCE(?, subtitle),
          is_active = COALESCE(?, is_active), updated_at = ? WHERE id = ?`)
          .run(d.name ?? null, d.shortName ?? null, d.subtitle ?? null, d.isActive == null ? null : d.isActive ? 1 : 0, now(), orgId);
        audit.write({ ...reqCtx, action: 'ORG_EDIT', resourceType: 'organization', resourceId: orgId, resourceOrgId: orgId,
          details: { before: { name: o.name, shortName: o.short_name, subtitle: o.subtitle, isActive: Boolean(o.is_active) }, after: d } });
      });
    },

    createRank(p, reqCtx, orgId, input) {
      const d = schemas.rank.parse(input);
      if (!p.orgs.byId.has(orgId)) throw notFound();
      if (!p.has('RANK_MANAGE', orgId)) throw forbidden();
      if (db.prepare('SELECT 1 FROM ranks WHERE org_id = ? AND code = ?').get(orgId, d.code)) throw conflict('This rank code already exists in this organization.');
      return transaction(db, () => {
        const { lastInsertRowid } = db.prepare('INSERT INTO ranks (org_id, code, name, level) VALUES (?,?,?,?)').run(orgId, d.code, d.name, d.level);
        audit.write({ ...reqCtx, action: 'RANK_CREATE', resourceType: 'rank', resourceId: Number(lastInsertRowid), resourceOrgId: orgId, details: d });
        return rankRow(db.prepare('SELECT * FROM ranks WHERE id = ?').get(lastInsertRowid));
      });
    },

    updateRank(p, reqCtx, rankId, input) {
      const d = schemas.rankUpdate.parse(input);
      const r = /** @type {any} */ (db.prepare('SELECT * FROM ranks WHERE id = ?').get(rankId));
      if (!r) throw notFound();
      if (!p.has('RANK_MANAGE', r.org_id)) throw forbidden();
      transaction(db, () => {
        db.prepare('UPDATE ranks SET name = COALESCE(?, name), level = COALESCE(?, level), is_active = COALESCE(?, is_active) WHERE id = ?')
          .run(d.name ?? null, d.level ?? null, d.isActive == null ? null : d.isActive ? 1 : 0, rankId);
        audit.write({ ...reqCtx, action: 'RANK_EDIT', resourceType: 'rank', resourceId: rankId, resourceOrgId: r.org_id,
          details: { before: rankRow(r), after: d } });
      });
      return rankRow(db.prepare('SELECT * FROM ranks WHERE id = ?').get(rankId));
    },

    permissions() {
      return db.prepare('SELECT code, category, description FROM permissions ORDER BY category, code').all();
    },

    roles() {
      const roles = db.prepare('SELECT * FROM roles ORDER BY is_system DESC, name').all();
      const perms = db.prepare('SELECT role_id, permission_code FROM role_permissions ORDER BY permission_code').all();
      return roles.map((r) => ({
        id: r.id, code: r.code, name: r.name, description: r.description, isSystem: Boolean(r.is_system),
        permissions: perms.filter((x) => x.role_id === r.id).map((x) => x.permission_code),
      }));
    },

    createRole(p, reqCtx, input) {
      const d = schemas.role.parse(input);
      if (!p.has('ROLE_MANAGE', null)) throw forbidden();
      if (db.prepare('SELECT 1 FROM roles WHERE code = ?').get(d.code)) throw conflict('This role code already exists.');
      return transaction(db, () => {
        const { lastInsertRowid } = db.prepare('INSERT INTO roles (code, name, description) VALUES (?,?,?)').run(d.code, d.name, d.description);
        audit.write({ ...reqCtx, action: 'ROLE_CREATE', resourceType: 'role', resourceId: Number(lastInsertRowid), details: d });
        return { id: Number(lastInsertRowid) };
      });
    },

    setRolePermissions(p, reqCtx, roleId, input) {
      const d = schemas.rolePermissions.parse(input);
      if (!p.has('ROLE_MANAGE', null)) throw forbidden();
      const role = /** @type {any} */ (db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId));
      if (!role) throw notFound();
      const known = new Set(db.prepare('SELECT code FROM permissions').all().map((r) => r.code));
      const unknown = d.permissions.filter((x) => !known.has(x));
      if (unknown.length) throw badRequest(`Unknown permissions: ${unknown.join(', ')}`);
      const before = db.prepare('SELECT permission_code FROM role_permissions WHERE role_id = ?').all(roleId).map((r) => String(r.permission_code));
      const after = [...new Set(d.permissions)].sort();
      transaction(db, () => {
        db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId);
        const ins = db.prepare('INSERT INTO role_permissions (role_id, permission_code) VALUES (?,?)');
        for (const x of after) ins.run(roleId, x);
        db.prepare('UPDATE roles SET updated_at = ? WHERE id = ?').run(now(), roleId);
        audit.write({ ...reqCtx, action: 'ROLE_PERMISSIONS_CHANGE', resourceType: 'role', resourceId: roleId, details: {
          role: role.code, added: after.filter((x) => !before.includes(x)), removed: before.filter((x) => !after.includes(x)), reason: d.reason,
        } });
      });
    },

    flags() {
      return db.prepare('SELECT code, name, enabled, legal_status, note, updated_at FROM feature_flags ORDER BY code').all()
        .map((f) => ({ code: f.code, name: f.name, enabled: Boolean(f.enabled), legalStatus: f.legal_status, note: f.note, updatedAt: f.updated_at }));
    },

    setFlag(p, reqCtx, flagCode, input) {
      const d = schemas.flag.parse(input);
      if (!p.has('FEATURE_TOGGLE', null)) throw forbidden();
      const f = /** @type {any} */ (db.prepare('SELECT * FROM feature_flags WHERE code = ?').get(flagCode));
      if (!f) throw notFound();
      transaction(db, () => {
        db.prepare('UPDATE feature_flags SET enabled = ?, legal_status = COALESCE(?, legal_status), note = COALESCE(?, note), updated_by = ?, updated_at = ? WHERE code = ?')
          .run(d.enabled ? 1 : 0, d.legalStatus ?? null, d.note ?? null, p.user.id, now(), flagCode);
        audit.write({ ...reqCtx, action: 'FEATURE_TOGGLE', resourceType: 'feature_flag', resourceId: flagCode,
          details: { before: { enabled: Boolean(f.enabled), legalStatus: f.legal_status }, after: d } });
      });
    },
  };
}

/**
 * Ist eine Funktion freigeschaltet? Gesperrte Funktionen liefern 403 FEATURE_DISABLED (ADR-012).
 * @param {import('../../db').Database} db @param {string} flagCode
 */
function assertFeature(db, flagCode) {
  const f = /** @type {any} */ (db.prepare('SELECT enabled, name FROM feature_flags WHERE code = ?').get(flagCode));
  if (!f || !f.enabled) {
    throw forbidden(`${f?.name ?? 'This function'} is disabled: its legal basis has not been verified.`, 'FEATURE_DISABLED');
  }
}

module.exports = { createConfigAdmin, assertFeature };
