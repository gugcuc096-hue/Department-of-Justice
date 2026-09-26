// @ts-check
'use strict';
/**
 * Vorlagen rendern und Versionen hashen (ADR-010).
 *
 * - Platzhalter {{feld}} bzw. {{issuer.name}} werden IMMER HTML-escaped; Zeilenumbrüche werden zu <br>.
 *   Das gerenderte HTML ist damit sicher und kann im Frontend direkt eingesetzt werden.
 * - Das Ergebnis wird mit der Vorlagenversion in der Dokumentversion eingefroren: spätere Vorlagenänderungen
 *   verändern bestehende (ggf. signierte) Dokumente nicht.
 * - Der Hash einer Version deckt Titel, Typ, Vorlage, Inhalt, gerendertes HTML und ggf. Datei-Hash ab.
 */
const crypto = require('crypto');

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** @param {Record<string, any>} ctx @param {string} path */
const lookup = (ctx, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);

/**
 * @param {string} body  Vorlagen-HTML (vertrauenswürdig: aus Seed/Administration)
 * @param {Record<string, any>} ctx  Werte (nicht vertrauenswürdig)
 */
function renderTemplate(body, ctx) {
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = lookup(ctx, key);
    const s = v == null ? '' : String(v).trim();
    return s ? esc(s).replace(/\r?\n/g, '<br>') : '<span class="doc-empty">—</span>';
  });
}

/** Stabiler JSON-Text (sortierte Schlüssel) für Hashes. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * @param {{ documentId: number, version: number, typeCode: string, templateCode: string|null, templateVersion: number|null,
 *   content: object, renderedHtml: string, fileSha256: string|null }} v
 */
function versionHash(v) {
  return crypto.createHash('sha256').update(canonical({
    documentId: v.documentId, version: v.version, typeCode: v.typeCode, templateCode: v.templateCode ?? null,
    templateVersion: v.templateVersion ?? null, content: v.content, renderedHtml: v.renderedHtml, fileSha256: v.fileSha256 ?? null,
  })).digest('hex');
}

module.exports = { renderTemplate, versionHash, canonical, esc };
