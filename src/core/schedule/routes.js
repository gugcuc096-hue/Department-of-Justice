// @ts-check
'use strict';
/**
 * /api/hearings, /api/deadlines
 */
const express = require('express');
const { notFound } = require('../../http/errors');
const { requestContext } = require('../audit/audit');
const { principalOf } = require('../authz/middleware');
const { createHearingService } = require('./hearings');
const { createDeadlineService } = require('./deadlines');

const idParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
};

/** @param {import('../../app').AppContext} ctx */
function scheduleRoutes(ctx) {
  const hearings = createHearingService(ctx);
  const deadlines = createDeadlineService(ctx);
  const router = express.Router();
  const P = principalOf;
  const A = requestContext;
  const I = (req) => idParam(req.params.id);

  router.get('/hearings', (req, res) => res.json(hearings.list(P(req), req.query)));
  router.post('/hearings', (req, res) => res.status(201).json(hearings.create(P(req), A(req), req.body)));
  router.get('/hearings/:id', (req, res) => res.json(hearings.get(P(req), A(req), I(req))));
  router.patch('/hearings/:id', (req, res) => res.json(hearings.update(P(req), A(req), I(req), req.body)));
  router.post('/hearings/:id/reschedule', (req, res) => res.json(hearings.reschedule(P(req), A(req), I(req), req.body)));
  for (const action of ['postpone', 'cancel', 'held']) {
    router.post(`/hearings/:id/${action}`, (req, res) => res.json(hearings.setStatus(P(req), A(req), I(req), action, req.body)));
  }
  router.post('/hearings/:id/participants', (req, res) => res.status(201).json(hearings.addParticipant(P(req), A(req), I(req), req.body)));
  router.post('/hearings/:id/participants/:pid/remove', (req, res) => res.json(hearings.removeParticipant(P(req), A(req), I(req), idParam(req.params.pid))));
  router.post('/hearings/:id/protocol', (req, res) => res.status(201).json(hearings.protocol(P(req), A(req), I(req), req.body)));

  router.get('/deadlines', (req, res) => res.json(deadlines.list(P(req), req.query)));
  router.post('/deadlines', (req, res) => res.status(201).json(deadlines.create(P(req), A(req), req.body)));
  router.get('/deadlines/:id', (req, res) => res.json(deadlines.get(P(req), A(req), I(req))));
  router.post('/deadlines/:id/complete', (req, res) => res.json(deadlines.complete(P(req), A(req), I(req))));
  router.post('/deadlines/:id/extend', (req, res) => res.json(deadlines.extend(P(req), A(req), I(req), req.body)));
  router.post('/deadlines/:id/cancel', (req, res) => res.json(deadlines.cancel(P(req), A(req), I(req), req.body)));

  return { router };
}

module.exports = { scheduleRoutes };
