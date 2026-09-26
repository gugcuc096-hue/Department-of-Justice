// @ts-check
'use strict';
const { loadPrincipal } = require('./principal');
const { forbidden } = require('../../http/errors');
const { requestContext } = require('../audit/audit');

/**
 * Hängt den Principal an den Request (nach requireAuth).
 * @param {import('../../app').AppContext} ctx
 * @returns {import('express').RequestHandler}
 */
function attachPrincipal(ctx) {
  return (req, _res, next) => {
    const auth = /** @type {any} */ (req).auth;
    /** @type {any} */ (req).principal = loadPrincipal(ctx.db, auth.user, { activeOrgId: auth.session.active_org_id });
    next();
  };
}

/**
 * Grobe Permission-Prüfung auf Routenebene. Die objektbezogene Prüfung (can(user, action, resource))
 * erfolgt zusätzlich im Service – diese Middleware ersetzt sie nicht.
 * Ablehnungen werden auditiert.
 * @param {import('../../app').AppContext} ctx
 * @param {string} code
 * @param {'anywhere'|'global'} [mode]
 * @returns {import('express').RequestHandler}
 */
function requirePermission(ctx, code, mode = 'anywhere') {
  return (req, _res, next) => {
    /** @type {import('./principal').Principal} */
    const p = /** @type {any} */ (req).principal;
    const ok = mode === 'global' ? p.has(code, null) : p.hasAnywhere(code);
    if (ok) return next();
    ctx.audit.write({ ...requestContext(req), action: 'PERMISSION_CHECK', outcome: 'DENIED', details: { permission: code, path: req.path } });
    next(forbidden());
  };
}

/** @param {import('express').Request} req @returns {import('./principal').Principal} */
const principalOf = (req) => /** @type {any} */ (req).principal;

module.exports = { attachPrincipal, requirePermission, principalOf };
