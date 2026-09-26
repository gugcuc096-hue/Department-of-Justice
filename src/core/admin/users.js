// @ts-check
'use strict';
/**
 * Benutzer- und Rechteverwaltung (Administration Center I).
 *
 * Vergaberegeln (PERMISSIONS.md Abschnitt 3):
 *  - Niemand ändert eigene Rollen, Permissions, Compartments, Clearance, Mitgliedschaften oder Status.
 *  - Benutzerweite Änderungen (Status, Clearance, Passwort, Stammdaten) verlangen die Permission für ALLE
 *    Mitgliedschaften des Ziels (ein DA-Admin deaktiviert niemanden, der auch im District Court ist).
 *  - Mitgliedschafts- und Rollenänderungen in Org X verlangen die Permission im Scope von X.
 *  - Direkte Permissions: nur, was der Vergebende im Ziel-Scope selbst besitzt.
 *  - Clearance: höchstens die eigene.
 *  - Compartments: nur, wer das Compartment selbst hält (Ausnahme Erstvergabe, solange es niemand hält);
 *    der Empfänger braucht die fachliche Voraussetzung (z. B. US_SJA_ACCESS für USSJA).
 */
const crypto = require('crypto');
const { z } = require('zod');
const { transaction, now, inList } = require('../../db');
const { forbidden, notFound, badRequest, conflict } = require('../../http/errors');
const { hashPassword, validatePassword } = require('../auth/passwords');
const { orgRef } = require('../users/me');

/** Fachliche Voraussetzung, damit ein Benutzer ein Compartment erhalten kann. */
const COMPARTMENT_PREREQUISITE = {
  SID: 'SID_ACCESS',
  SID_RESTRICTED: 'SID_RESTRICTED_ACCESS',
  REGISTRY: 'REGISTRY_VIEW',
  USSJA: 'US_SJA_ACCESS',
};

const id = z.number().int().positive();
const reason = z.string().trim().min(3).max(500);
const isoDate = z.string().datetime({ offset: true });

const schemas = {
  create: z.object({
    username: z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9._-]+$/, 'Letters, digits, dot, underscore and hyphen only.'),
    displayName: z.string().trim().min(2).max(120),
    badgeNo: z.string().trim().max(40).default(''),
    contact: z.string().trim().max(300).default(''),
    orgId: id,
    rankId: id.nullable().default(null),
  }),
  update: z.object({
    displayName: z.string().trim().min(2).max(120).optional(),
    badgeNo: z.string().trim().max(40).optional(),
    contact: z.string().trim().max(300).optional(),
  }),
  membership: z.object({ orgId: id, rankId: id.nullable().default(null), supervisorUserId: id.nullable().default(null), isPrimary: z.boolean().default(false) }),
  membershipUpdate: z.object({ rankId: id.nullable().optional(), supervisorUserId: id.nullable().optional(), isPrimary: z.boolean().optional() }),
  role: z.object({ roleId: id, scopeOrgId: id.nullable(), reason }),
  permission: z.object({ code: z.string().min(2).max(64), scopeOrgId: id.nullable(), reason, expiresAt: isoDate.nullable().default(null) }),
  clearance: z.object({ level: z.string().min(2).max(40), reason }),
  compartment: z.object({ code: z.string().min(2).max(40), reason, expiresAt: isoDate.nullable().default(null) }),
  status: z.object({ reason }),
};

/**
 * @param {import('../../app').AppContext} ctx
 */
function createUserAdmin(ctx) {
  const { db, audit, config } = ctx;

  const getUser = (userId) => /** @type {any} */ (db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
  const membershipOrgIds = (userId) => db.prepare('SELECT org_id FROM memberships WHERE user_id = ?').all(userId).map((r) => Number(r.org_id));

  /** @param {import('../authz/principal').Principal} p @param {number} targetId */
  function assertNotSelf(p, targetId) {
    if (p.user.id === targetId) throw forbidden('You cannot change your own access rights or account status.', 'SELF_MODIFICATION');
  }

  /**
   * Darf p den Benutzer sehen/bearbeiten? mode 'any': eine Mitgliedschaft im Scope genügt; 'all': alle.
   * Benutzer ohne Mitgliedschaft können nur mit globaler Permission verwaltet werden.
   * @param {import('../authz/principal').Principal} p @param {string} code @param {number} targetId @param {'any'|'all'} mode
   */
  function coversUser(p, code, targetId, mode) {
    if (p.has(code, null)) return true;
    const orgIds = membershipOrgIds(targetId);
    if (!orgIds.length) return false;
    return mode === 'all' ? orgIds.every((o) => p.has(code, o)) : orgIds.some((o) => p.has(code, o));
  }

  /**
   * Lädt Ziel oder 404 – auch wenn es existiert, aber außerhalb des Scopes liegt.
   * @param {import('../authz/principal').Principal} p @param {string} code @param {number} targetId @param {'any'|'all'} [mode]
   */
  function loadTarget(p, code, targetId, mode = 'any') {
    const user = getUser(targetId);
    if (!user || !coversUser(p, code, targetId, mode)) {
      if (user && coversUser(p, 'USER_VIEW', targetId, 'any')) throw forbidden();
      throw notFound();
    }
    return user;
  }

  /** @param {import('../authz/principal').Principal} p @param {number} userId */
  function view(p, userId) {
    const u = getUser(userId);
    const memberships = db.prepare(`SELECT m.id, m.org_id, m.rank_id, m.is_primary, m.supervisor_user_id, r.name AS rank_name, s.display_name AS supervisor_name
      FROM memberships m LEFT JOIN ranks r ON r.id = m.rank_id LEFT JOIN users s ON s.id = m.supervisor_user_id
      WHERE m.user_id = ? ORDER BY m.is_primary DESC, m.id`).all(userId);
    const roles = db.prepare(`SELECT ur.id, ur.scope_org_id, ur.reason, ur.granted_at, r.id AS role_id, r.code, r.name
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.name`).all(userId);
    const perms = db.prepare('SELECT id, permission_code, scope_org_id, reason, expires_at FROM user_permissions WHERE user_id = ? ORDER BY permission_code').all(userId);
    // Compartment-Zugehörigkeit anderer nur zeigen, wenn der Betrachter das Compartment selbst hält
    const comps = db.prepare('SELECT compartment_code, granted_at, expires_at, reason FROM user_compartments WHERE user_id = ?').all(userId)
      .filter((c) => p.compartments.has(String(c.compartment_code)));
    return {
      id: u.id, username: u.username, displayName: u.display_name, badgeNo: u.badge_no, contact: u.contact,
      status: u.status, clearance: u.clearance_level, mustChangePassword: Boolean(u.must_change_password),
      isDemo: Boolean(u.is_demo), createdAt: u.created_at, lastLoginAt: u.last_login_at,
      lockedUntil: u.locked_until && Date.parse(u.locked_until) > Date.now() ? u.locked_until : null,
      memberships: memberships.map((m) => ({ id: m.id, org: orgRef(p.orgs, Number(m.org_id)), rankId: m.rank_id, rank: m.rank_name,
        isPrimary: Boolean(m.is_primary), supervisor: m.supervisor_user_id ? { id: m.supervisor_user_id, name: m.supervisor_name } : null })),
      roles: roles.map((r) => ({ id: r.id, roleId: r.role_id, code: r.code, name: r.name, scope: r.scope_org_id ? orgRef(p.orgs, Number(r.scope_org_id)) : null, reason: r.reason, grantedAt: r.granted_at })),
      permissions: perms.map((x) => ({ id: x.id, code: x.permission_code, scope: x.scope_org_id ? orgRef(p.orgs, Number(x.scope_org_id)) : null, reason: x.reason, expiresAt: x.expires_at })),
      compartments: comps.map((c) => ({ code: c.compartment_code, grantedAt: c.granted_at, expiresAt: c.expires_at, reason: c.reason })),
      canEdit: coversUser(p, 'USER_EDIT', userId, 'all') && p.user.id !== userId,
    };
  }

  /** @param {import('../authz/principal').Principal} p @param {{ q?: string, orgId?: number, status?: string, limit?: number, offset?: number }} f */
  function list(p, f) {
    const limit = f.limit ?? 50;
    const offset = f.offset ?? 0;
    const global = p.has('USER_VIEW', null);
    const where = [];
    const params = [];
    if (!global) {
      const orgIds = [...p.orgsWith('USER_VIEW')];
      if (!orgIds.length) return { items: [], total: 0 };
      where.push(`EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.org_id IN (${inList(orgIds)}))`);
      params.push(...orgIds);
    }
    if (f.orgId) {
      const sub = p.orgs.subtree(f.orgId);
      where.push(`EXISTS (SELECT 1 FROM memberships m2 WHERE m2.user_id = u.id AND m2.org_id IN (${inList(sub)}))`);
      params.push(...sub);
    }
    if (f.status) { where.push('u.status = ?'); params.push(f.status); }
    if (f.q) {
      where.push("(u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\' OR u.badge_no LIKE ? ESCAPE '\\')");
      const like = `%${f.q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      params.push(like, like, like);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(/** @type {any} */ (db.prepare(`SELECT COUNT(*) n FROM users u ${w}`).get(...params)).n);
    const rows = db.prepare(`SELECT u.id FROM users u ${w} ORDER BY u.display_name COLLATE NOCASE LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { items: rows.map((r) => view(p, Number(r.id))), total };
  }

  const auditCtx = (reqCtx, action, targetId, details) =>
    audit.write({ ...reqCtx, action, resourceType: 'user', resourceId: targetId, details });

  function generateTemporaryPassword() {
    // 16 Zeichen, Buchstaben und Ziffern gemischt – erfüllt die Richtlinie
    return crypto.randomBytes(12).toString('base64url').replace(/[-_]/g, 'x') + '7a';
  }

  return {
    schemas,
    list,
    view,

    /** @param {import('../authz/principal').Principal} p */
    get(p, userId) {
      loadTarget(p, 'USER_VIEW', userId);
      return view(p, userId);
    },

    /** Legt einen Benutzer mit Erstmitgliedschaft an und liefert ein einmalig angezeigtes Startpasswort. */
    async create(p, reqCtx, input) {
      const d = schemas.create.parse(input);
      if (!p.orgs.byId.has(d.orgId)) throw badRequest('Unknown organization.');
      if (!p.has('USER_CREATE', d.orgId)) throw forbidden();
      if (d.rankId && !db.prepare('SELECT 1 FROM ranks WHERE id = ? AND org_id = ?').get(d.rankId, d.orgId)) throw badRequest('The rank does not belong to this organization.');
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(d.username)) throw conflict('This username is already taken.', 'USERNAME_TAKEN');
      const temporaryPassword = generateTemporaryPassword();
      const hash = await hashPassword(temporaryPassword, config.bcryptCost);
      const userId = transaction(db, () => {
        const { lastInsertRowid } = db.prepare(`INSERT INTO users (username, display_name, badge_no, contact, password_hash, must_change_password)
          VALUES (?,?,?,?,?,1)`).run(d.username, d.displayName, d.badgeNo, d.contact, hash);
        db.prepare('INSERT INTO memberships (user_id, org_id, rank_id, is_primary) VALUES (?,?,?,1)').run(lastInsertRowid, d.orgId, d.rankId);
        audit.write({ ...reqCtx, action: 'USER_CREATE', resourceType: 'user', resourceId: Number(lastInsertRowid), resourceOrgId: d.orgId,
          details: { username: d.username, orgId: d.orgId, rankId: d.rankId } });
        return Number(lastInsertRowid);
      });
      return { user: view(p, userId), temporaryPassword };
    },

    update(p, reqCtx, userId, input) {
      const d = schemas.update.parse(input);
      const before = loadTarget(p, 'USER_EDIT', userId, 'all');
      assertNotSelf(p, userId);
      transaction(db, () => {
        db.prepare(`UPDATE users SET display_name = COALESCE(?, display_name), badge_no = COALESCE(?, badge_no),
          contact = COALESCE(?, contact), updated_at = ? WHERE id = ?`).run(d.displayName ?? null, d.badgeNo ?? null, d.contact ?? null, now(), userId);
        auditCtx(reqCtx, 'USER_EDIT', userId, { before: { displayName: before.display_name, badgeNo: before.badge_no }, after: d });
      });
      return view(p, userId);
    },

    setStatus(p, reqCtx, userId, status, input) {
      const { reason: why } = schemas.status.parse(input);
      loadTarget(p, 'USER_DISABLE', userId, 'all');
      assertNotSelf(p, userId);
      transaction(db, () => {
        db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), userId);
        if (status !== 'ACTIVE') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
        auditCtx(reqCtx, status === 'ACTIVE' ? 'USER_ENABLE' : 'USER_DISABLE', userId, { reason: why });
      });
      return view(p, userId);
    },

    async resetPassword(p, reqCtx, userId) {
      loadTarget(p, 'USER_EDIT', userId, 'all');
      assertNotSelf(p, userId);
      const temporaryPassword = generateTemporaryPassword();
      if (validatePassword(temporaryPassword)) throw new Error('generated password violates policy');
      const hash = await hashPassword(temporaryPassword, config.bcryptCost);
      transaction(db, () => {
        db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?').run(hash, now(), userId);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
        auditCtx(reqCtx, 'USER_PASSWORD_RESET', userId, {});
      });
      return { temporaryPassword };
    },

    addMembership(p, reqCtx, userId, input) {
      const d = schemas.membership.parse(input);
      if (!getUser(userId)) throw notFound();
      assertNotSelf(p, userId);
      if (!p.orgs.byId.has(d.orgId)) throw badRequest('Unknown organization.');
      if (!p.has('USER_EDIT', d.orgId)) throw forbidden();
      if (d.rankId && !db.prepare('SELECT 1 FROM ranks WHERE id = ? AND org_id = ?').get(d.rankId, d.orgId)) throw badRequest('The rank does not belong to this organization.');
      if (d.supervisorUserId && !getUser(d.supervisorUserId)) throw badRequest('Unknown supervisor.');
      if (db.prepare('SELECT 1 FROM memberships WHERE user_id = ? AND org_id = ?').get(userId, d.orgId)) throw conflict('The user is already a member of this organization.');
      transaction(db, () => {
        if (d.isPrimary) db.prepare('UPDATE memberships SET is_primary = 0 WHERE user_id = ?').run(userId);
        db.prepare('INSERT INTO memberships (user_id, org_id, rank_id, supervisor_user_id, is_primary) VALUES (?,?,?,?,?)')
          .run(userId, d.orgId, d.rankId, d.supervisorUserId, d.isPrimary ? 1 : 0);
        audit.write({ ...reqCtx, action: 'MEMBERSHIP_ADD', resourceType: 'user', resourceId: userId, resourceOrgId: d.orgId, details: d });
      });
      return view(p, userId);
    },

    updateMembership(p, reqCtx, userId, membershipId, input) {
      const d = schemas.membershipUpdate.parse(input);
      const m = /** @type {any} */ (db.prepare('SELECT * FROM memberships WHERE id = ? AND user_id = ?').get(membershipId, userId));
      if (!m) throw notFound();
      assertNotSelf(p, userId);
      if (!p.has('USER_EDIT', m.org_id)) throw forbidden();
      if (d.rankId && !db.prepare('SELECT 1 FROM ranks WHERE id = ? AND org_id = ?').get(d.rankId, m.org_id)) throw badRequest('The rank does not belong to this organization.');
      transaction(db, () => {
        if (d.isPrimary) db.prepare('UPDATE memberships SET is_primary = 0 WHERE user_id = ?').run(userId);
        db.prepare(`UPDATE memberships SET rank_id = ?, supervisor_user_id = ?, is_primary = ? WHERE id = ?`).run(
          d.rankId !== undefined ? d.rankId : m.rank_id,
          d.supervisorUserId !== undefined ? d.supervisorUserId : m.supervisor_user_id,
          d.isPrimary !== undefined ? (d.isPrimary ? 1 : 0) : m.is_primary, membershipId);
        audit.write({ ...reqCtx, action: d.rankId !== undefined && d.rankId !== m.rank_id ? 'RANK_CHANGE' : 'MEMBERSHIP_EDIT',
          resourceType: 'user', resourceId: userId, resourceOrgId: m.org_id, details: { before: { rankId: m.rank_id }, after: d } });
      });
      return view(p, userId);
    },

    removeMembership(p, reqCtx, userId, membershipId) {
      const m = /** @type {any} */ (db.prepare('SELECT * FROM memberships WHERE id = ? AND user_id = ?').get(membershipId, userId));
      if (!m) throw notFound();
      assertNotSelf(p, userId);
      if (!p.has('USER_EDIT', m.org_id)) throw forbidden();
      transaction(db, () => {
        db.prepare('DELETE FROM memberships WHERE id = ?').run(membershipId);
        // Rollen, deren Scope nur über diese Mitgliedschaft erreichbar war, bleiben bestehen, wirken aber
        // nur noch auf Ressourcen im Scope – sie werden bewusst nicht still entfernt (Admin entscheidet).
        audit.write({ ...reqCtx, action: 'MEMBERSHIP_REMOVE', resourceType: 'user', resourceId: userId, resourceOrgId: m.org_id, details: { orgId: m.org_id } });
      });
      return view(p, userId);
    },

    assignRole(p, reqCtx, userId, input) {
      const d = schemas.role.parse(input);
      if (!getUser(userId)) throw notFound();
      assertNotSelf(p, userId);
      const role = /** @type {any} */ (db.prepare('SELECT * FROM roles WHERE id = ?').get(d.roleId));
      if (!role) throw badRequest('Unknown role.');
      if (d.scopeOrgId != null && !p.orgs.byId.has(d.scopeOrgId)) throw badRequest('Unknown organization.');
      if (!p.has('ROLE_ASSIGN', d.scopeOrgId)) throw forbidden(d.scopeOrgId == null ? 'Only global administrators may assign roles without scope.' : undefined);
      if (d.scopeOrgId != null && !membershipOrgIds(userId).some((o) => p.orgs.isWithin(o, d.scopeOrgId))) {
        throw badRequest('The user must be a member of the scope organization (or one of its units).');
      }
      if (db.prepare('SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = ? AND IFNULL(scope_org_id, 0) = ?').get(userId, d.roleId, d.scopeOrgId ?? 0)) {
        throw conflict('This role is already assigned in this scope.');
      }
      transaction(db, () => {
        db.prepare('INSERT INTO user_roles (user_id, role_id, scope_org_id, granted_by, reason) VALUES (?,?,?,?,?)')
          .run(userId, d.roleId, d.scopeOrgId, p.user.id, d.reason);
        audit.write({ ...reqCtx, action: 'ROLE_ASSIGN', resourceType: 'user', resourceId: userId, resourceOrgId: d.scopeOrgId,
          details: { role: role.code, scopeOrgId: d.scopeOrgId, reason: d.reason } });
      });
      return view(p, userId);
    },

    revokeRole(p, reqCtx, userId, assignmentId, input) {
      const { reason: why } = schemas.status.parse(input);
      const a = /** @type {any} */ (db.prepare('SELECT ur.*, r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.id = ? AND ur.user_id = ?').get(assignmentId, userId));
      if (!a) throw notFound();
      assertNotSelf(p, userId);
      if (!p.has('ROLE_ASSIGN', a.scope_org_id)) throw forbidden();
      transaction(db, () => {
        db.prepare('DELETE FROM user_roles WHERE id = ?').run(assignmentId);
        audit.write({ ...reqCtx, action: 'ROLE_REVOKE', resourceType: 'user', resourceId: userId, resourceOrgId: a.scope_org_id,
          details: { role: a.code, scopeOrgId: a.scope_org_id, reason: why } });
      });
      return view(p, userId);
    },

    grantPermission(p, reqCtx, userId, input) {
      const d = schemas.permission.parse(input);
      if (!getUser(userId)) throw notFound();
      assertNotSelf(p, userId);
      if (!db.prepare('SELECT 1 FROM permissions WHERE code = ?').get(d.code)) throw badRequest('Unknown permission.');
      if (d.scopeOrgId != null && !p.orgs.byId.has(d.scopeOrgId)) throw badRequest('Unknown organization.');
      if (!p.has('PERMISSION_ASSIGN', d.scopeOrgId)) throw forbidden();
      // Nur weitergeben, was man im Ziel-Scope selbst besitzt
      if (!p.has(d.code, d.scopeOrgId)) throw forbidden('You can only grant permissions you hold yourself in this scope.', 'ESCALATION_DENIED');
      transaction(db, () => {
        db.prepare(`INSERT INTO user_permissions (user_id, permission_code, scope_org_id, granted_by, reason, expires_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT DO UPDATE SET reason = excluded.reason, expires_at = excluded.expires_at, granted_by = excluded.granted_by, granted_at = excluded.granted_at`)
          .run(userId, d.code, d.scopeOrgId, p.user.id, d.reason, d.expiresAt);
        audit.write({ ...reqCtx, action: 'PERMISSION_GRANT', resourceType: 'user', resourceId: userId, resourceOrgId: d.scopeOrgId, details: d });
      });
      return view(p, userId);
    },

    revokePermission(p, reqCtx, userId, grantId, input) {
      const { reason: why } = schemas.status.parse(input);
      const g = /** @type {any} */ (db.prepare('SELECT * FROM user_permissions WHERE id = ? AND user_id = ?').get(grantId, userId));
      if (!g) throw notFound();
      assertNotSelf(p, userId);
      if (!p.has('PERMISSION_ASSIGN', g.scope_org_id)) throw forbidden();
      transaction(db, () => {
        db.prepare('DELETE FROM user_permissions WHERE id = ?').run(grantId);
        audit.write({ ...reqCtx, action: 'PERMISSION_REVOKE', resourceType: 'user', resourceId: userId, resourceOrgId: g.scope_org_id,
          details: { code: g.permission_code, reason: why } });
      });
      return view(p, userId);
    },

    setClearance(p, reqCtx, userId, input) {
      const d = schemas.clearance.parse(input);
      const target = loadTarget(p, 'CLEARANCE_ASSIGN', userId, 'all');
      assertNotSelf(p, userId);
      if (!p.levels.has(d.level)) throw badRequest('Unknown security level.');
      if (!p.clearedFor(d.level)) throw forbidden('You cannot assign a clearance above your own.', 'ESCALATION_DENIED');
      transaction(db, () => {
        db.prepare('UPDATE users SET clearance_level = ?, updated_at = ? WHERE id = ?').run(d.level, now(), userId);
        auditCtx(reqCtx, 'CLEARANCE_CHANGE', userId, { before: target.clearance_level, after: d.level, reason: d.reason });
      });
      return view(p, userId);
    },

    grantCompartment(p, reqCtx, userId, input) {
      const d = schemas.compartment.parse(input);
      const target = getUser(userId);
      if (!target) throw notFound();
      assertNotSelf(p, userId);
      const comp = /** @type {any} */ (db.prepare('SELECT * FROM compartments WHERE code = ?').get(d.code));
      if (!comp) throw badRequest('Unknown compartment.');
      if (!p.has('COMPARTMENT_ASSIGN', comp.owner_org_id)) throw forbidden();
      const holders = Number(/** @type {any} */ (db.prepare(`SELECT COUNT(*) n FROM user_compartments
        WHERE compartment_code = ? AND (expires_at IS NULL OR expires_at > ?)`).get(d.code, now())).n);
      if (!p.compartments.has(d.code) && holders > 0) {
        throw forbidden('Only holders of this compartment can grant it.', 'ESCALATION_DENIED');
      }
      const prerequisite = COMPARTMENT_PREREQUISITE[d.code];
      if (prerequisite) {
        const { loadPrincipal } = require('../authz/principal');
        if (!loadPrincipal(db, target, { orgs: p.orgs }).hasAnywhere(prerequisite)) {
          throw badRequest(`The user first needs a role with ${prerequisite} before this compartment can be granted.`);
        }
      }
      transaction(db, () => {
        db.prepare(`INSERT INTO user_compartments (user_id, compartment_code, granted_by, reason, expires_at) VALUES (?,?,?,?,?)
          ON CONFLICT DO UPDATE SET granted_by = excluded.granted_by, reason = excluded.reason, expires_at = excluded.expires_at, granted_at = excluded.granted_at`)
          .run(userId, d.code, p.user.id, d.reason, d.expiresAt);
        audit.write({ ...reqCtx, action: 'COMPARTMENT_GRANT', resourceType: 'user', resourceId: userId, resourceOrgId: comp.owner_org_id,
          resourceCompartments: [d.code], details: { code: d.code, reason: d.reason, expiresAt: d.expiresAt, initialGrant: holders === 0 } });
      });
      return view(p, userId);
    },

    revokeCompartment(p, reqCtx, userId, code, input) {
      const { reason: why } = schemas.status.parse(input);
      assertNotSelf(p, userId);
      const comp = /** @type {any} */ (db.prepare('SELECT * FROM compartments WHERE code = ?').get(code));
      if (!comp || !p.compartments.has(code)) throw notFound();
      if (!p.has('COMPARTMENT_ASSIGN', comp.owner_org_id)) throw forbidden();
      const res = db.prepare('SELECT 1 FROM user_compartments WHERE user_id = ? AND compartment_code = ?').get(userId, code);
      if (!res) throw notFound();
      transaction(db, () => {
        db.prepare('DELETE FROM user_compartments WHERE user_id = ? AND compartment_code = ?').run(userId, code);
        audit.write({ ...reqCtx, action: 'COMPARTMENT_REVOKE', resourceType: 'user', resourceId: userId, resourceOrgId: comp.owner_org_id,
          resourceCompartments: [code], details: { code, reason: why } });
      });
      return view(p, userId);
    },
  };
}

module.exports = { createUserAdmin, COMPARTMENT_PREREQUISITE };
