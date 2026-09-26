// @ts-check
'use strict';
/**
 * /api/documents, /api/document-types, /api/files
 */
const express = require('express');
const { z } = require('zod');
const { notFound } = require('../../http/errors');
const { requestContext } = require('../audit/audit');
const { principalOf, requirePermission } = require('../authz/middleware');
const { createDocumentService } = require('./service');
const { createFileService } = require('../files/service');

const idParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
};

/** @param {import('../../app').AppContext} ctx */
function documentRoutes(ctx) {
  const docs = createDocumentService(ctx);
  const files = createFileService(ctx);
  const router = express.Router();
  const P = principalOf;
  const A = requestContext;
  const I = (req) => idParam(req.params.id);
  ctx.fileAccessors.push((p, reqCtx, fileId) => docs.fileAccess(p, reqCtx, fileId));

  router.get('/document-types', (req, res) => {
    const q = z.object({ caseId: z.coerce.number().int().positive().optional(), orgId: z.coerce.number().int().positive().optional() }).parse(req.query);
    res.json(docs.creatableTypes(P(req), A(req), q));
  });

  router.get('/documents', (req, res) => res.json(docs.list(P(req), req.query)));
  router.post('/documents', (req, res) => res.status(201).json(docs.create(P(req), A(req), req.body)));
  router.get('/documents/:id', (req, res) => res.json(docs.get(P(req), A(req), I(req))));
  router.patch('/documents/:id', (req, res) => res.json(docs.update(P(req), A(req), I(req), req.body)));
  router.get('/documents/:id/versions/:v', (req, res) => res.json(docs.version(P(req), A(req), I(req), idParam(req.params.v))));
  router.post('/documents/:id/submit', (req, res) => res.json(docs.submit(P(req), A(req), I(req))));
  router.post('/documents/:id/approve', (req, res) => res.json(docs.decide(P(req), A(req), I(req), true, req.body)));
  router.post('/documents/:id/reject', (req, res) => res.json(docs.decide(P(req), A(req), I(req), false, req.body)));
  router.post('/documents/:id/sign', (req, res) => res.json(docs.sign(P(req), A(req), I(req), req.body)));
  router.post('/documents/:id/issue', (req, res) => res.json(docs.issue(P(req), A(req), I(req))));
  router.post('/documents/:id/archive', (req, res) => res.json(docs.archive(P(req), A(req), I(req), req.body)));
  router.post('/documents/:id/signatures/:sid/revoke', (req, res) => res.json(docs.revokeSignature(P(req), A(req), I(req), idParam(req.params.sid), req.body)));
  router.delete('/documents/:id', (req, res) => res.json(docs.remove(P(req), A(req), I(req))));

  // Upload: Rohdaten mit Content-Type (PDF/PNG/JPEG/WebP), Dateiname im Header X-Filename (URL-kodiert)
  router.post('/files', requirePermission(ctx, 'DOCUMENT_CREATE'),
    express.raw({ type: files.MIME_TYPES, limit: files.MAX_BYTES }),
    (req, res) => {
      let name = 'file';
      try { name = decodeURIComponent(String(req.get('x-filename') ?? 'file')); } catch { /* Standardname */ }
      const mime = String(req.get('content-type') ?? '').split(';')[0].trim();
      res.status(201).json(files.store(P(req), A(req), { buffer: req.body, mime, originalName: name }));
    });

  router.get('/files/:id', (req, res) => {
    const id = I(req);
    const file = files.get(id);
    if (!file) throw notFound();
    // Jedes Modul prüft seine eigenen Bezüge (Dokumentversion, Beweismittelfoto); keiner erlaubt → 404
    if (!ctx.fileAccessors.some((allow) => allow(P(req), A(req), id))) throw notFound();
    files.assertExists(file);
    files.send(res, file);
  });

  return { router, service: docs };
}

module.exports = { documentRoutes };
