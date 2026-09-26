// @ts-check
'use strict';
/**
 * Routen: /api/orgs, /api/feature-flags, /api/directory, /api/delegations, /api/admin/*
 */
const express = require('express');
const { z } = require('zod');
const { asyncHandler } = require('../../http/async');
const { notFound } = require('../../http/errors');
const { requestContext } = require('../audit/audit');
const { principalOf, requirePermission } = require('../authz/middleware');
const { createUserAdmin } = require('./users');
const { createConfigAdmin } = require('./config');
const { createDelegations } = require('./delegations');
const { orgRef } = require('../users/me');
const { inList } = require('../../db');

/** Pfad-ID oder 404. */
const idParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
};

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  orgId: z.coerce.number().int().positive().optional(),
  status: z.enum(['ACTIVE', 'DISABLED', 'PENDING']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** @param {import('../../app').AppContext} ctx */
function adminRoutes(ctx) {
  const users = createUserAdmin(ctx);
  const cfg = createConfigAdmin(ctx);
  const delegations = createDelegations(ctx);
  const { db } = ctx;
  const router = express.Router();
  const P = principalOf;
  const A = requestContext;

  // ------------------------------------------------ für alle angemeldeten Benutzer
  router.get('/orgs', (req, res) => res.json(cfg.orgTree(P(req))));
  router.get('/feature-flags', (_req, res) => res.json(cfg.flags()));

  /**
   * Personalverzeichnis zur Auswahl von Empfängern/Vertretern: nur aktive Benutzer, Name, Organisation, Rang.
   * Mitgliedschaften in abgeschotteten Bereichen (SID, Registry, US-SJA) sieht nur, wer das Compartment hält.
   */
  router.get('/directory', (req, res) => {
    const p = P(req);
    const q = z.object({ q: z.string().trim().min(2).max(60) }).parse(req.query).q;
    const hidden = new Set(db.prepare('SELECT code, owner_org_id FROM compartments').all()
      .filter((c) => c.owner_org_id && !p.compartments.has(String(c.code)))
      .flatMap((c) => p.orgs.subtree(Number(c.owner_org_id))));
    const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const rows = db.prepare(`SELECT id, display_name, badge_no FROM users
      WHERE status = 'ACTIVE' AND (display_name LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\' OR badge_no LIKE ? ESCAPE '\\')
      ORDER BY display_name COLLATE NOCASE LIMIT 20`).all(like, like, like);
    const ids = rows.map((r) => Number(r.id));
    const ms = ids.length ? db.prepare(`SELECT m.user_id, m.org_id, r.name AS rank FROM memberships m LEFT JOIN ranks r ON r.id = m.rank_id
      WHERE m.user_id IN (${inList(ids)}) ORDER BY m.is_primary DESC`).all(...ids) : [];
    res.json(rows.map((u) => ({
      id: u.id, displayName: u.display_name, badgeNo: u.badge_no,
      memberships: ms.filter((m) => m.user_id === u.id && !hidden.has(Number(m.org_id)))
        .map((m) => ({ org: orgRef(p.orgs, Number(m.org_id)), rank: m.rank })),
    })));
  });

  router.get('/delegations', (req, res) => res.json(delegations.list(P(req))));
  router.post('/delegations', (req, res) => res.status(201).json(delegations.request(P(req), A(req), req.body)));
  router.post('/delegations/:id/approve', (req, res) => res.json(delegations.decide(P(req), A(req), idParam(req.params.id), true, req.body)));
  router.post('/delegations/:id/reject', (req, res) => res.json(delegations.decide(P(req), A(req), idParam(req.params.id), false, req.body)));
  router.post('/delegations/:id/revoke', (req, res) => res.json(delegations.revoke(P(req), A(req), idParam(req.params.id), req.body)));

  // ------------------------------------------------ Administration Center
  const admin = express.Router();

  admin.get('/users', requirePermission(ctx, 'USER_VIEW'), (req, res) => res.json(users.list(P(req), listQuery.parse(req.query))));
  admin.post('/users', requirePermission(ctx, 'USER_CREATE'), asyncHandler(async (req, res) => res.status(201).json(await users.create(P(req), A(req), req.body))));
  admin.get('/users/:id', (req, res) => res.json(users.get(P(req), idParam(req.params.id))));
  admin.patch('/users/:id', (req, res) => res.json(users.update(P(req), A(req), idParam(req.params.id), req.body)));
  admin.post('/users/:id/disable', (req, res) => res.json(users.setStatus(P(req), A(req), idParam(req.params.id), 'DISABLED', req.body)));
  admin.post('/users/:id/enable', (req, res) => res.json(users.setStatus(P(req), A(req), idParam(req.params.id), 'ACTIVE', req.body)));
  admin.post('/users/:id/reset-password', asyncHandler(async (req, res) => res.json(await users.resetPassword(P(req), A(req), idParam(req.params.id)))));

  admin.post('/users/:id/memberships', (req, res) => res.status(201).json(users.addMembership(P(req), A(req), idParam(req.params.id), req.body)));
  admin.patch('/users/:id/memberships/:mid', (req, res) => res.json(users.updateMembership(P(req), A(req), idParam(req.params.id), idParam(req.params.mid), req.body)));
  admin.delete('/users/:id/memberships/:mid', (req, res) => res.json(users.removeMembership(P(req), A(req), idParam(req.params.id), idParam(req.params.mid))));

  admin.post('/users/:id/roles', (req, res) => res.status(201).json(users.assignRole(P(req), A(req), idParam(req.params.id), req.body)));
  admin.post('/users/:id/roles/:aid/revoke', (req, res) => res.json(users.revokeRole(P(req), A(req), idParam(req.params.id), idParam(req.params.aid), req.body)));
  admin.post('/users/:id/permissions', (req, res) => res.status(201).json(users.grantPermission(P(req), A(req), idParam(req.params.id), req.body)));
  admin.post('/users/:id/permissions/:gid/revoke', (req, res) => res.json(users.revokePermission(P(req), A(req), idParam(req.params.id), idParam(req.params.gid), req.body)));
  admin.put('/users/:id/clearance', (req, res) => res.json(users.setClearance(P(req), A(req), idParam(req.params.id), req.body)));
  admin.post('/users/:id/compartments', (req, res) => res.status(201).json(users.grantCompartment(P(req), A(req), idParam(req.params.id), req.body)));
  admin.post('/users/:id/compartments/:code/revoke', (req, res) => res.json(users.revokeCompartment(P(req), A(req), idParam(req.params.id), String(req.params.code), req.body)));

  admin.post('/orgs', (req, res) => res.status(201).json(cfg.createOrg(P(req), A(req), req.body)));
  admin.patch('/orgs/:id', (req, res) => { cfg.updateOrg(P(req), A(req), idParam(req.params.id), req.body); res.json({ ok: true }); });
  admin.post('/orgs/:id/ranks', (req, res) => res.status(201).json(cfg.createRank(P(req), A(req), idParam(req.params.id), req.body)));
  admin.patch('/ranks/:id', (req, res) => res.json(cfg.updateRank(P(req), A(req), idParam(req.params.id), req.body)));

  admin.get('/permissions', (_req, res) => res.json(cfg.permissions()));
  admin.get('/roles', (_req, res) => res.json(cfg.roles()));
  admin.post('/roles', (req, res) => res.status(201).json(cfg.createRole(P(req), A(req), req.body)));
  admin.put('/roles/:id/permissions', (req, res) => { cfg.setRolePermissions(P(req), A(req), idParam(req.params.id), req.body); res.json({ ok: true }); });
  admin.get('/security-levels', (_req, res) => res.json(db.prepare('SELECT code, rank, name FROM security_levels ORDER BY rank').all()));
  admin.get('/compartments', (_req, res) => res.json(db.prepare('SELECT code, name, owner_org_id AS ownerOrgId FROM compartments ORDER BY code').all()));
  admin.put('/feature-flags/:code', (req, res) => { cfg.setFlag(P(req), A(req), String(req.params.code), req.body); res.json(cfg.flags()); });

  router.use('/admin', admin);
  return router;
}

module.exports = { adminRoutes };
