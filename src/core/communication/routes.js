// @ts-check
'use strict';
/**
 * /api/notifications, /api/conversations, /api/requests, /api/me/counters
 */
const express = require('express');
const { z } = require('zod');
const { notFound } = require('../../http/errors');
const { requestContext } = require('../audit/audit');
const { principalOf } = require('../authz/middleware');
const { createNotificationService } = require('../notifications/service');
const { createMessagingService } = require('../messaging/service');
const { createRequestService } = require('../requests/service');

const idParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
};

/** @param {import('../../app').AppContext} ctx */
function communicationRoutes(ctx) {
  const notes = createNotificationService(ctx);
  const msg = createMessagingService(ctx);
  const reqs = createRequestService(ctx);
  const router = express.Router();
  const P = principalOf;
  const A = requestContext;
  const I = (req) => idParam(req.params.id);

  // Zähler für die Kopfzeile (Glocke, Nachrichten)
  router.get('/me/counters', (req, res) => res.json({ notifications: notes.unreadCount(P(req)), messages: msg.unreadTotal(P(req)) }));

  router.get('/notifications', (req, res) => res.json(notes.list(P(req), req.query)));
  router.post('/notifications/read', (req, res) => {
    const { ids } = z.object({ ids: z.array(z.number().int().positive()).max(500) }).parse(req.body);
    notes.markRead(P(req), ids);
    res.json({ ok: true });
  });
  router.post('/notifications/read-all', (req, res) => { notes.markAllRead(P(req)); res.json({ ok: true }); });

  router.get('/conversations', (req, res) => res.json(msg.list(P(req), req.query)));
  router.post('/conversations', (req, res) => res.status(201).json(msg.create(P(req), A(req), req.body)));
  router.get('/conversations/:id', (req, res) => res.json(msg.get(P(req), A(req), I(req))));
  router.post('/conversations/:id/messages', (req, res) => res.status(201).json(msg.reply(P(req), A(req), I(req), req.body)));

  router.get('/requests', (req, res) => res.json(reqs.list(P(req), req.query)));
  router.post('/requests', (req, res) => res.status(201).json(reqs.create(P(req), A(req), req.body)));
  router.get('/requests/:id', (req, res) => res.json(reqs.get(P(req), A(req), I(req))));
  router.get('/requests/:id/assignees', (req, res) => res.json(reqs.assignees(P(req), A(req), I(req))));
  router.post('/requests/:id/assign', (req, res) => res.json(reqs.assign(P(req), A(req), I(req), req.body)));
  router.post('/requests/:id/start', (req, res) => res.json(reqs.start(P(req), A(req), I(req))));
  router.post('/requests/:id/respond', (req, res) => res.json(reqs.respond(P(req), A(req), I(req), req.body)));
  router.post('/requests/:id/decline', (req, res) => res.json(reqs.decline(P(req), A(req), I(req), req.body)));
  router.post('/requests/:id/close', (req, res) => res.json(reqs.close(P(req), A(req), I(req))));

  return { router, notifications: notes };
}

module.exports = { communicationRoutes };
