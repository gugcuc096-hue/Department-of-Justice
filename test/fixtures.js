'use strict';
/**
 * Test-Fixtures: Benutzer direkt in der Datenbank anlegen (schnell, ohne Admin-API).
 */
const bcrypt = require('bcryptjs');

const PASSWORD = 'Fixture-Password-1';
const HASH = bcrypt.hashSync(PASSWORD, 4);

const orgId = (db, code) => {
  const r = db.prepare('SELECT id FROM organizations WHERE code = ?').get(code);
  if (!r) throw new Error(`unknown org ${code}`);
  return r.id;
};

/**
 * @param {any} db
 * @param {{ username: string, orgs?: Array<[string, string?]>, roles?: Array<[string, string|null]>,
 *   compartments?: string[], clearance?: string, displayName?: string }} o
 *   orgs: [orgCode, rankName?]; roles: [roleCode, scopeOrgCode|null]
 */
function createUser(db, o) {
  const { lastInsertRowid: id } = db.prepare(`INSERT INTO users (username, display_name, password_hash, clearance_level)
    VALUES (?,?,?,?)`).run(o.username, o.displayName ?? o.username, HASH, o.clearance ?? 'CONFIDENTIAL');
  (o.orgs ?? []).forEach(([code, rank], i) => {
    const oid = orgId(db, code);
    const rankId = rank ? db.prepare('SELECT id FROM ranks WHERE org_id = ? AND name = ?').get(oid, rank)?.id : null;
    if (rank && !rankId) throw new Error(`unknown rank ${rank} in ${code}`);
    db.prepare('INSERT INTO memberships (user_id, org_id, rank_id, is_primary) VALUES (?,?,?,?)').run(id, oid, rankId ?? null, i === 0 ? 1 : 0);
  });
  for (const [role, scope] of o.roles ?? []) {
    const roleId = db.prepare('SELECT id FROM roles WHERE code = ?').get(role)?.id;
    if (!roleId) throw new Error(`unknown role ${role}`);
    db.prepare('INSERT INTO user_roles (user_id, role_id, scope_org_id) VALUES (?,?,?)').run(id, roleId, scope ? orgId(db, scope) : null);
  }
  for (const c of o.compartments ?? []) {
    db.prepare('INSERT INTO user_compartments (user_id, compartment_code) VALUES (?,?)').run(id, c);
  }
  return Number(id);
}

/** Client anmelden (Fixture-Passwort). */
async function login(t, username, password = PASSWORD) {
  const c = t.client();
  const res = await c.post('/api/auth/login', { username, password });
  if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return c;
}

/** Bootstrap-Admin anmelden und Passwortwechsel erledigen. */
async function adminClient(t) {
  const { ADMIN } = require('./helpers');
  const c = t.client();
  await c.post('/api/auth/login', ADMIN);
  const changed = await c.post('/api/auth/password', { currentPassword: ADMIN.password, newPassword: 'Admin-Password-Changed-1' });
  if (changed.status !== 200) throw new Error('admin password change failed');
  return c;
}

module.exports = { PASSWORD, createUser, login, adminClient, orgId };
