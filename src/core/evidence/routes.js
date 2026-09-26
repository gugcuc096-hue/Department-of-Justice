// @ts-check
'use strict';
/**
 * /api/evidence
 */
const express = require('express');
const { notFound } = require('../../http/errors');
const { requestContext } = require('../audit/audit');
const { principalOf } = require('../authz/middleware');
const { createEvidenceService } = require('./service');

const idParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
};

/** @param {import('../../app').AppContext} ctx */
function evidenceRoutes(ctx) {
  const ev = createEvidenceService(ctx);
  ctx.fileAccessors.push((p, reqCtx, fileId) => ev.fileAccess(p, reqCtx, fileId));
  const router = express.Router();
  const P = principalOf;
  const A = requestContext;
  const I = (req) => idParam(req.params.id);

  router.get('/evidence-categories', (_req, res) => res.json(ev.CATEGORIES));
  router.get('/evidence', (req, res) => res.json(ev.list(P(req), req.query)));
  router.post('/evidence', (req, res) => res.status(201).json(ev.create(P(req), A(req), req.body)));
  router.get('/evidence/:id', (req, res) => res.json(ev.get(P(req), A(req), I(req))));
  router.post('/evidence/:id/transfer', (req, res) => res.json(ev.transfer(P(req), A(req), I(req), req.body)));
  router.post('/evidence/:id/accept', (req, res) => res.json(ev.accept(P(req), A(req), I(req))));
  router.post('/evidence/:id/reject', (req, res) => res.json(ev.decline(P(req), A(req), I(req), 'reject', req.body)));
  router.post('/evidence/:id/cancel', (req, res) => res.json(ev.decline(P(req), A(req), I(req), 'cancel', req.body)));
  router.post('/evidence/:id/move', (req, res) => res.json(ev.move(P(req), A(req), I(req), req.body)));
  router.post('/evidence/:id/release', (req, res) => res.json(ev.close(P(req), A(req), I(req), 'release', req.body)));
  router.post('/evidence/:id/dispose', (req, res) => res.json(ev.close(P(req), A(req), I(req), 'dispose', req.body)));
  router.post('/evidence/:id/files', (req, res) => res.status(201).json(ev.addFile(P(req), A(req), I(req), req.body)));

  return { router };
}

module.exports = { evidenceRoutes };
