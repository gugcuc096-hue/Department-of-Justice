// @ts-check
'use strict';
/**
 * Datei-Uploads (SECURITY_MODEL.md Abschnitt 11): Allowlist, Magic-Bytes-Prüfung, Größenlimit, Zufallsname,
 * SHA-256, Ablage außerhalb von public/, Auslieferung nur über die API mit Prüfung des Elterndokuments.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { now } = require('../../db');
const { badRequest, notFound } = require('../../http/errors');

const MAX_BYTES = 10 * 1024 * 1024;

/** Erlaubte Typen mit Signatur der ersten Bytes. */
const TYPES = {
  'application/pdf': { ext: 'pdf', check: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  'image/png': { ext: 'png', check: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/jpeg': { ext: 'jpg', check: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/webp': { ext: 'webp', check: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
};
const MIME_TYPES = Object.keys(TYPES);

/** Dateinamen für Anzeige und Content-Disposition entschärfen. */
const safeName = (name) => String(name || 'file').normalize('NFKC').replace(/[^\w.\- ()äöüÄÖÜß]/g, '_').slice(0, 120) || 'file';

/** @param {import('../../app').AppContext} ctx */
function createFileService(ctx) {
  const { db, audit, config } = ctx;
  fs.mkdirSync(config.uploadDir, { recursive: true });

  return {
    MIME_TYPES,
    MAX_BYTES,

    /**
     * @param {import('../authz/principal').Principal} p
     * @param {any} reqCtx
     * @param {{ buffer: Buffer, mime: string, originalName: string }} f
     */
    store(p, reqCtx, f) {
      const type = TYPES[f.mime];
      if (!type) throw badRequest('Only PDF, PNG, JPEG and WebP files can be uploaded.');
      if (!Buffer.isBuffer(f.buffer) || f.buffer.length === 0) throw badRequest('The file is empty.');
      if (f.buffer.length > MAX_BYTES) throw badRequest('The file is larger than 10 MB.');
      if (!type.check(f.buffer)) throw badRequest('The file content does not match its type.');
      const storageName = `${crypto.randomBytes(16).toString('hex')}.${type.ext}`;
      const sha256 = crypto.createHash('sha256').update(f.buffer).digest('hex');
      fs.writeFileSync(path.join(config.uploadDir, storageName), f.buffer, { flag: 'wx' });
      const { lastInsertRowid } = db.prepare(`INSERT INTO files (storage_name, original_name, mime, size, sha256, uploaded_by, created_at)
        VALUES (?,?,?,?,?,?,?)`).run(storageName, safeName(f.originalName), f.mime, f.buffer.length, sha256, p.user.id, now());
      audit.write({ ...reqCtx, action: 'FILE_UPLOAD', resourceType: 'file', resourceId: Number(lastInsertRowid), details: { mime: f.mime, size: f.buffer.length, sha256 } });
      return { id: Number(lastInsertRowid), originalName: safeName(f.originalName), mime: f.mime, size: f.buffer.length, sha256 };
    },

    /** Datei-Zeile oder null */
    get(fileId) {
      return /** @type {any} */ (db.prepare('SELECT * FROM files WHERE id = ?').get(fileId)) ?? null;
    },

    /** Noch nicht verwendete Datei des Benutzers (für die Anlage eines Anhangs). */
    unattachedOwnFile(p, fileId) {
      const f = /** @type {any} */ (db.prepare(`SELECT * FROM files f WHERE f.id = ? AND f.uploaded_by = ?
        AND NOT EXISTS (SELECT 1 FROM document_versions v WHERE v.file_id = f.id)
        AND NOT EXISTS (SELECT 1 FROM evidence_files ef WHERE ef.file_id = f.id)`).get(fileId, p.user.id));
      if (!f) throw badRequest('The uploaded file was not found or is already in use.');
      return f;
    },

    /** Datei ausliefern (Aufrufer hat die Berechtigung geprüft). */
    send(res, file) {
      res.set('Content-Type', file.mime);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Security-Policy', "default-src 'none'; sandbox");
      res.attachment(file.original_name);
      res.sendFile(path.join(config.uploadDir, file.storage_name), (err) => { if (err && !res.headersSent) res.status(404).end(); });
    },

    assertExists(file) {
      if (!file || !fs.existsSync(path.join(config.uploadDir, file.storage_name))) throw notFound();
    },
  };
}

module.exports = { createFileService, MIME_TYPES, MAX_BYTES };
