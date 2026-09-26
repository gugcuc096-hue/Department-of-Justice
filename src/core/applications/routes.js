// @ts-check
'use strict';
/**
 * /api/applications, /api/warrants
 */
const express = require('express');
const { z } = require('zod');
const { notFound } = require('../../http/errors');
const { requestContext } = require('../audit/audit');
const { principalOf } = require('../authz/middleware');
const { createApplicationService } = require('./service');
const { createWarrantService } = require('./warrants');

const idParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
};
const ACTIONS = new Set(['submit', 'withdraw', 'accept', 'request_revision', 'approve', 'deny', 'issue']);

/** @param {import('../../app').AppContext} ctx */
function applicationRoutes(ctx) {
  const apps = createApplicationService(ctx);
  const warrants = createWarrantService(ctx);
  const router = express.Router();
  const P = principalOf;
  const A = requestContext;
  const I = (req) => idParam(req.params.id);

  router.get('/application-options', (req, res) => {
    const { caseId } = z.object({ caseId: z.coerce.number().int().positive() }).parse(req.query);
    res.json(apps.options(P(req), A(req), caseId));
  });
  router.get('/applications', (req, res) => res.json(apps.list(P(req), req.query)));
  router.post('/applications', (req, res) => res.status(201).json(apps.create(P(req), A(req), req.body)));
  router.get('/applications/:id', (req, res) => res.json(apps.get(P(req), A(req), I(req))));
  router.patch('/applications/:id', (req, res) => res.json(apps.update(P(req), A(req), I(req), req.body)));
  router.get('/applications/:id/judges', (req, res) => res.json(apps.judges(P(req), A(req), I(req))));
  router.post('/applications/:id/:action', (req, res) => {
    const action = String(req.params.action);
    if (!ACTIONS.has(action)) throw notFound();
    res.json(apps.act(P(req), A(req), I(req), action, req.body));
  });

  router.get('/warrants', (req, res) => res.json(warrants.list(P(req), req.query)));
  router.get('/warrants/:id', (req, res) => res.json(warrants.get(P(req), A(req), I(req))));
  router.post('/warrants/:id/start', (req, res) => res.json(warrants.start(P(req), A(req), I(req))));
  router.post('/warrants/:id/report', (req, res) => res.json(warrants.report(P(req), A(req), I(req), req.body)));
  router.post('/warrants/:id/acknowledge', (req, res) => res.json(warrants.acknowledge(P(req), A(req), I(req))));
  router.post('/warrants/:id/recall', (req, res) => res.json(warrants.recall(P(req), A(req), I(req), req.body)));

  return { router };
}

module.exports = { applicationRoutes };
