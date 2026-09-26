// @ts-check
'use strict';
/**
 * /api/me – eigenes Profil, Kontext (aktive Organisation), Permissions zur Benutzerführung.
 */
const express = require('express');
const { z } = require('zod');
const { principalOf } = require('../authz/middleware');
const { badRequest } = require('../../http/errors');
const { requestContext } = require('../audit/audit');
const { transaction } = require('../../db');

/** @param {import('../authz/orgs').OrgTree} orgs @param {number} id */
const orgRef = (orgs, id) => {
  const o = orgs.byId.get(id);
  if (!o) return null;
  const inst = orgs.institutionOf(id);
  return { id: o.id, code: o.code, name: o.name, shortName: o.short_name, subtitle: o.subtitle, kind: o.kind,
    brandCode: o.brand_code, institution: inst ? { id: inst.id, code: inst.code, name: inst.name } : null };
};

/** @param {import('../authz/principal').Principal} p */
function profile(p) {
  const u = p.user;
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    badgeNo: u.badge_no,
    clearance: u.clearance_level,
    compartments: [...p.compartments].sort(),
    memberships: p.memberships.map((m) => ({ org: orgRef(p.orgs, m.orgId), rank: m.rankName, rankLevel: m.rankLevel, isPrimary: m.isPrimary })),
    activeOrg: p.activeOrgId ? orgRef(p.orgs, p.activeOrgId) : null,
    // Nur zur Benutzerführung im Frontend; jede Aktion wird serverseitig erneut geprüft.
    permissions: [...new Set(p.grants.filter((g) => g.caseId == null).map((g) => g.code))].sort(),
  };
}

/** @param {import('../../app').AppContext} ctx */
function meRoutes(ctx) {
  const router = express.Router();

  router.get('/', (req, res) => res.json(profile(principalOf(req))));

  /**
   * Navigation (ADR-004): serverseitig aus Permissions berechnet. Enthält nur Funktionen, die tatsächlich
   * implementiert sind; die API prüft jede Aktion unabhängig davon erneut.
   */
  router.get('/navigation', (req, res) => {
    const p = principalOf(req);
    const any = (...codes) => codes.some((c) => p.hasAnywhere(c));
    const sections = [];
    const work = [{ id: 'dashboard', label: 'Dashboard', path: '/app/' }];
    if (any('CASE_VIEW', 'CASE_VIEW_ORG')) work.push({ id: 'cases', label: 'Cases', path: '/app/cases' });
    if (any('CASE_CREATE')) work.push({ id: 'case-new', label: 'New case', path: '/app/cases/new' });
    if (any('DOCUMENT_VIEW')) work.push({ id: 'documents', label: 'Documents', path: '/app/documents' });
    if (any('APPLICATION_CREATE', 'APPLICATION_REVIEW', 'APPLICATION_DECIDE')) work.push({ id: 'applications', label: 'Court applications', path: '/app/applications' });
    if (any('WARRANT_VIEW')) work.push({ id: 'warrants', label: 'Warrants', path: '/app/warrants' });
    if (any('EVIDENCE_VIEW', 'EVIDENCE_CREATE')) work.push({ id: 'evidence', label: 'Evidence custody', path: '/app/evidence' });
    if (any('CASE_VIEW')) work.push({ id: 'calendar', label: 'Calendar & deadlines', path: '/app/calendar' });
    if (any('PERSON_VIEW')) work.push({ id: 'persons', label: 'Person records', path: '/app/persons' });
    if (any('COMPANY_VIEW')) work.push({ id: 'companies', label: 'Companies', path: '/app/companies' });
    if (any('MESSAGE_SEND')) work.push({ id: 'messages', label: 'Messages', path: '/app/messages' });
    if (any('REQUEST_CREATE', 'REQUEST_RESPOND', 'REQUEST_ASSIGN')) work.push({ id: 'requests', label: 'Official requests', path: '/app/requests' });
    work.push({ id: 'notifications', label: 'Notifications', path: '/app/notifications' });
    work.push({ id: 'delegations', label: 'Delegations', path: '/app/delegations' });
    sections.push({ id: 'work', label: 'Work', items: work });

    const admin = [];
    if (any('USER_VIEW')) admin.push({ id: 'admin-users', label: 'Users', path: '/app/admin/users' });
    if (any('ORG_MANAGE', 'RANK_MANAGE', 'USER_VIEW')) admin.push({ id: 'admin-orgs', label: 'Organizations & ranks', path: '/app/admin/organizations' });
    if (any('ROLE_MANAGE', 'ROLE_ASSIGN')) admin.push({ id: 'admin-roles', label: 'Roles & permissions', path: '/app/admin/roles' });
    if (any('FEATURE_TOGGLE')) admin.push({ id: 'admin-flags', label: 'Legal basis & features', path: '/app/admin/features' });
    if (admin.length) sections.push({ id: 'admin', label: 'Administration', items: admin });

    res.json({ sections });
  });

  // Department Switcher: nur zwischen eigenen Mitgliedschaften wechseln
  router.put('/active-org', (req, res) => {
    const { orgId } = z.object({ orgId: z.number().int().positive() }).parse(req.body);
    const p = principalOf(req);
    if (!p.memberships.some((m) => m.orgId === orgId)) throw badRequest('You are not a member of this organization.');
    const auth = /** @type {any} */ (req).auth;
    transaction(ctx.db, () => {
      ctx.sessions.setActiveOrg(auth.session.token_hash, orgId);
      ctx.audit.write({ ...requestContext(req), action: 'CONTEXT_SWITCH', resourceType: 'organization', resourceId: orgId, resourceOrgId: orgId });
    });
    p.activeOrgId = orgId;
    res.json(profile(p));
  });

  return router;
}

module.exports = { meRoutes, profile, orgRef };
