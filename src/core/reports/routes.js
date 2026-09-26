// @ts-check
'use strict';
/**
 * /api/audit, /api/reports, /api/dashboard, /api/drafts, /api/cases/:id/export
 */
const express = require('express');
const { notFound } = require('../../http/errors');
const { requestContext } = require('../audit/audit');
const { principalOf } = require('../authz/middleware');
const { createAuditService } = require('../audit/service');
const { createReportService } = require('./service');
const { createDashboardService } = require('../dashboard/service');
const { createDraftService } = require('../drafts/service');

const idParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
};

/** Datei ausliefern (nie cachen, immer als Download). */
const attachment = (res, name, type, body) => {
  res.set('Content-Type', type);
  res.set('Content-Disposition', `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"`);
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(body);
};

/** @param {import('../../app').AppContext} ctx */
function reportRoutes(ctx) {
  const auditSvc = createAuditService(ctx);
  const reports = createReportService(ctx);
  const dashboard = createDashboardService(ctx);
  const drafts = createDraftService(ctx);
  const router = express.Router();
  const P = principalOf;
  const A = requestContext;

  router.get('/audit', (req, res) => res.json(auditSvc.list(P(req), A(req), req.query)));
  router.get('/audit/verify', (req, res) => res.json(auditSvc.verify(P(req), A(req))));
  router.get('/audit/export', (req, res) => attachment(res, `audit-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv; charset=utf-8', auditSvc.exportCsv(P(req), A(req), req.query)));

  router.get('/reports', (req, res) => res.json(reports.list(P(req))));
  router.get('/reports/:kind', (req, res) => res.json(reports.run(P(req), A(req), String(req.params.kind), req.query)));
  router.get('/reports/:kind/export', (req, res) => {
    const kind = String(req.params.kind);
    attachment(res, `report-${kind}-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv; charset=utf-8', reports.exportCsv(P(req), A(req), kind, req.query));
  });
  router.get('/cases/:id/export', (req, res) => {
    const out = reports.exportCase(P(req), A(req), idParam(req.params.id));
    attachment(res, out.filename, 'application/json; charset=utf-8', JSON.stringify(out.bundle, null, 2));
  });

  router.get('/dashboard', (req, res) => res.json(dashboard.get(P(req))));

  router.get('/drafts/:key', (req, res) => res.json(drafts.get(P(req), String(req.params.key))));
  router.put('/drafts/:key', (req, res) => res.json(drafts.save(P(req), String(req.params.key), req.body)));
  router.delete('/drafts/:key', (req, res) => { drafts.remove(P(req), String(req.params.key)); res.json({ ok: true }); });

  return { router };
}

module.exports = { reportRoutes };
