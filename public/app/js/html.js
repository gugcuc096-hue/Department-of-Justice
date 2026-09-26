/**
 * Sicheres HTML-Templating. Jeder interpolierte Wert wird escaped, außer er ist ausdrücklich mit raw()
 * als vertrauenswürdig markiert (z. B. Ausgabe von USMSBrand.html.* oder verschachtelte h``-Ergebnisse).
 */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"'`]/g, (c) => ESC[c]);

class Raw {
  constructor(html) { this.html = html; }
  toString() { return this.html; }
}

/** Als vertrauenswürdig markiertes HTML. Nur für selbst erzeugtes Markup verwenden. */
export const raw = (html) => new Raw(String(html));

const render = (v) => {
  if (v == null || v === false) return '';
  if (v instanceof Raw) return v.html;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
};

/** Tagged Template: h`<p>${userInput}</p>` → escaped. Ergebnis ist Raw und kann verschachtelt werden. */
export function h(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return raw(out);
}

/** Datum/Zeit in UI-Sprache (Englisch, US-Behördenstil). */
export function fmtDate(iso, withTime = true) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', withTime
    ? { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: 'long', day: 'numeric' }).format(d);
}

export const titleCase = (s) => String(s ?? '').toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
