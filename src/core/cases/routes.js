// @ts-check
'use strict';
/**
 * /api/cases, /api/case-types, /api/security-profiles
 */
const express = require('express');
const { notFound } = require('../../http/errors');
const { requestContext } = require('../audit/audit');
const { principalOf } = require('../authz/middleware');
const { createCaseService } = require('./service');

const idParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
};

/** @param {import('../../app').AppContext} ctx */
function caseRoutes(ctx) {
  const cases = createCaseService(ctx);
  const router = express.Router();
  const P = principalOf;
  const A = requestContext;
  const I = (req) => idParam(req.params.id);

  router.get('/case-types', (req, res) => res.json(cases.creatableTypes(P(req))));
  router.get('/security-profiles', (req, res) => res.json(cases.profiles(P(req))));

  router.get('/cases', (req, res) => res.json(cases.list(P(req), req.query)));
  router.post('/cases', (req, res) => res.status(201).json(cases.create(P(req), A(req), req.body)));
  router.get('/cases/:id', (req, res) => res.json(cases.get(P(req), A(req), I(req))));
  router.patch('/cases/:id', (req, res) => res.json(cases.update(P(req), A(req), I(req), req.body)));
  router.get('/cases/:id/timeline', (req, res) => res.json(cases.timeline(P(req), A(req), I(req))));

  router.post('/cases/:id/participants', (req, res) => res.status(201).json(cases.addParticipant(P(req), A(req), I(req), req.body)));
  router.post('/cases/:id/participants/:pid/remove', (req, res) => res.json(cases.removeParticipant(P(req), A(req), I(req), idParam(req.params.pid), req.body)));
  router.post('/cases/:id/access', (req, res) => res.status(201).json(cases.grantAccess(P(req), A(req), I(req), req.body)));
  router.post('/cases/:id/access/:aid/revoke', (req, res) => res.json(cases.revokeAccess(P(req), A(req), I(req), idParam(req.params.aid), req.body)));

  for (const action of ['close', 'reopen', 'archive']) {
    router.post(`/cases/:id/${action}`, (req, res) => res.json(cases.setStatus(P(req), A(req), I(req), action, req.body)));
  }
  router.post('/cases/:id/seal', (req, res) => res.json(cases.seal(P(req), A(req), I(req), req.body)));
  router.post('/cases/:id/unseal', (req, res) => res.json(cases.unseal(P(req), A(req), I(req), req.body)));
  router.put('/cases/:id/security', (req, res) => res.json(cases.setSecurity(P(req), A(req), I(req), req.body)));
  router.post('/cases/:id/transfer', (req, res) => res.json(cases.transfer(P(req), A(req), I(req), req.body)));
  router.post('/cases/:id/links', (req, res) => res.status(201).json(cases.link(P(req), A(req), I(req), req.body)));
  router.delete('/cases/:id/links/:lid', (req, res) => res.json(cases.unlink(P(req), A(req), I(req), idParam(req.params.lid))));

  return { router, service: cases };
}

module.exports = { caseRoutes };
