// @ts-check
'use strict';
/**
 * Formularentwürfe (Autosave, prompt.txt 9.5). Jeder Benutzer sieht nur seine eigenen Entwürfe.
 * Entwürfe sind Arbeitsstände, keine Vorgänge: sie erscheinen in keiner Liste, Suche oder Benachrichtigung.
 * Entwürfe älter als DRAFT_TTL_DAYS werden beim Speichern eines neuen Entwurfs verworfen.
 */
const { z } = require('zod');
const { now, parseJson } = require('../../db');
const { badRequest } = require('../../http/errors');

const DRAFT_TTL_DAYS = 30;
const MAX_BYTES = 100_000;
const key = z.string().regex(/^[a-z0-9:_-]{3,80}$/, 'Invalid draft key.');

/** @param {import('../../app').AppContext} ctx */
function createDraftService(ctx) {
  const { db } = ctx;
  return {
    get(p, k) {
      const r = /** @type {any} */ (db.prepare('SELECT payload, updated_at FROM drafts WHERE user_id = ? AND form_key = ?').get(p.user.id, key.parse(k)));
      return r ? { payload: parseJson(r.payload, {}), updatedAt: r.updated_at } : null;
    },
    save(p, k, body) {
      const payload = z.object({ payload: z.record(z.string().max(80), z.unknown()) }).parse(body).payload;
      const text = JSON.stringify(payload);
      if (Buffer.byteLength(text) > MAX_BYTES) throw badRequest('The draft is too large.');
      const ts = now();
      db.prepare(`INSERT INTO drafts (user_id, form_key, payload, updated_at) VALUES (?,?,?,?)
        ON CONFLICT (user_id, form_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`).run(p.user.id, key.parse(k), text, ts);
      db.prepare('DELETE FROM drafts WHERE user_id = ? AND updated_at < ?').run(p.user.id, new Date(Date.now() - DRAFT_TTL_DAYS * 86_400_000).toISOString());
      return { updatedAt: ts };
    },
    remove(p, k) {
      db.prepare('DELETE FROM drafts WHERE user_id = ? AND form_key = ?').run(p.user.id, key.parse(k));
    },
  };
}

module.exports = { createDraftService };
