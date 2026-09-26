/**
 * UI-Bausteine: Toast, Dialog-Formulare, Feldfehler, Badges, Tabellen, Paginierung, Benutzerauswahl.
 */
import { h, raw, esc, fmtDate, titleCase } from './html.js';
import { api, ApiError, qs } from './api.js';

// ---------------------------------------------------------------- Toast
export function toast(message, kind = 'info') {
  let box = document.querySelector('.toasts');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toasts';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    document.body.append(box);
  }
  const t = document.createElement('div');
  t.className = `toast${kind === 'error' ? ' toast--error' : ''}`;
  t.textContent = message;
  box.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 7000 : 4000);
}

/** Fehler verständlich anzeigen (Details nur als Request-ID für den Support). */
export function showError(err) {
  const msg = err instanceof ApiError ? err.message : 'An unexpected error occurred.';
  toast(err?.requestId ? `${msg} (Ref. ${err.requestId.slice(0, 8)})` : msg, 'error');
}

// ---------------------------------------------------------------- Badges
export const badge = (text, cls = '') => h`<span class="badge ${cls}">${text}</span>`;
export const levelBadge = (level) => badge(titleCase(level), `badge--level-${level}`);
export const statusBadge = (status) => badge(titleCase(status), `badge--status-${status}`);
export const demoBadge = (isDemo) => (isDemo ? badge('Demo', 'badge--demo') : '');
export const unverifiedBadge = (legalStatus) => (legalStatus === 'NOT_VERIFIED'
  ? h`<span class="badge badge--unverified" title="The legal basis of this function has not yet been verified against the ModernV legal sources.">Legal basis not verified</span>`
  : '');

// ---------------------------------------------------------------- Formulare
export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'number' || el.dataset.type === 'int') out[el.name] = el.value === '' ? null : Number(el.value);
    else if (el.type === 'datetime-local') out[el.name] = el.value ? new Date(el.value).toISOString() : null;
    else out[el.name] = el.value;
  }
  return out;
}

export function clearFieldErrors(form) {
  form.querySelectorAll('.field__error').forEach((e) => e.remove());
  form.querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid'));
}

export function showFieldErrors(form, err) {
  clearFieldErrors(form);
  const errors = err instanceof ApiError ? err.fieldErrors : {};
  let first = null;
  for (const [field, message] of Object.entries(errors)) {
    const el = form.elements[field];
    if (!el || !el.closest) continue;
    el.setAttribute('aria-invalid', 'true');
    const p = document.createElement('div');
    p.className = 'field__error';
    p.id = `${field}-error`;
    p.textContent = message;
    el.setAttribute('aria-describedby', p.id);
    el.closest('.field')?.append(p);
    first ??= el;
  }
  first?.focus();
  return Object.keys(errors).length > 0;
}

/** Formularfeld-Markup. */
export function field({ name, label, type = 'text', value = '', required = false, hint = '', options = null, attrs = '', plain = false }) {
  const id = `f-${name}-${Math.random().toString(36).slice(2, 7)}`;
  let control;
  if (options) {
    control = h`<select id="${id}" name="${name}" ${required ? raw('required') : ''} ${raw(attrs)}>
      ${options.map((o) => h`<option value="${o.value}" ${String(o.value) === String(value) ? raw('selected') : ''}>${o.label}</option>`)}
    </select>`;
  } else if (type === 'textarea') {
    control = h`<textarea id="${id}" name="${name}" ${required ? raw('required') : ''} ${raw(attrs)}>${value}</textarea>`;
  } else if (type === 'checkbox') {
    return h`<div class="field"><label class="checkbox"><input type="checkbox" name="${name}" ${value ? raw('checked') : ''} ${raw(attrs)}> ${label}</label>
      ${hint ? h`<div class="field__hint">${hint}</div>` : ''}</div>`;
  } else {
    control = h`<input id="${id}" name="${name}" type="${type}" value="${value}" ${required ? raw('required') : ''} ${raw(attrs)}>`;
  }
  // plain: Filterfelder ohne "(optional)"-Hinweis
  return h`<div class="field"><label for="${id}">${label}${required || plain ? '' : h` <span class="muted small">(optional)</span>`}</label>${control}
    ${hint ? h`<div class="field__hint">${hint}</div>` : ''}</div>`;
}

// ---------------------------------------------------------------- Dialog
/**
 * Formular-Dialog. onSubmit(data, form) wird aufgerufen; wirft es einen ApiError, werden Feldfehler angezeigt.
 * Liefert das Ergebnis von onSubmit oder null bei Abbruch.
 */
export function formDialog({ title, body, submitLabel = 'Save', danger = false, onSubmit, onOpen }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dialog';
    dlg.setAttribute('aria-labelledby', 'dlg-title');
    dlg.innerHTML = String(h`<form method="dialog" novalidate>
      <div class="dialog__head"><h2 id="dlg-title">${title}</h2></div>
      <div class="dialog__body">${body}<div class="form-error" role="alert"></div></div>
      <div class="dialog__foot">
        <button type="button" class="btn" data-cancel>Cancel</button>
        <button type="submit" class="btn ${danger ? 'btn--danger' : 'btn--primary'}">${submitLabel}</button>
      </div></form>`);
    document.body.append(dlg);
    const form = dlg.querySelector('form');
    const close = (value) => { dlg.close(); dlg.remove(); resolve(value); };
    dlg.querySelector('[data-cancel]').addEventListener('click', () => close(null));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      const errBox = form.querySelector('.form-error');
      errBox.innerHTML = '';
      try {
        const result = await onSubmit(formData(form), form);
        close(result ?? true);
      } catch (err) {
        if (!showFieldErrors(form, err)) {
          errBox.innerHTML = String(h`<div class="notice notice--error">${err.message || 'The action failed.'}</div>`);
        }
      } finally {
        btn.disabled = false;
      }
    });
    dlg.showModal();
    onOpen?.(dlg);
    (form.querySelector('input:not([type=hidden]), select, textarea') ?? form.querySelector('[type=submit]'))?.focus();
  });
}

/** Aktion mit Pflichtbegründung bestätigen. */
export function reasonDialog({ title, text = '', submitLabel = 'Confirm', danger = false, onSubmit, extra = '' }) {
  return formDialog({
    title, submitLabel, danger,
    body: h`${text ? h`<p>${text}</p>` : ''}${raw(String(extra))}${field({ name: 'reason', label: 'Reason', type: 'textarea', required: true, hint: 'Recorded in the audit log.' })}`,
    onSubmit,
  });
}

/** Einmalige Anzeige eines Geheimnisses (z. B. Startpasswort). */
export function secretDialog({ title, text, secret }) {
  return formDialog({
    title, submitLabel: 'Done',
    body: h`<p>${text}</p><p class="mono secret">${secret}</p>
      <p class="muted small">This value is shown only once and is not stored in plain text.</p>`,
    onSubmit: () => true,
    onOpen: (dlg) => dlg.querySelector('[data-cancel]').remove(),
  });
}

// ---------------------------------------------------------------- Tabellen & Paginierung
export function table(columns, rows, emptyText = 'No entries.') {
  if (!rows.length) return h`<div class="empty">${emptyText}</div>`;
  return h`<div class="table-wrap"><table class="table">
    <thead><tr>${columns.map((c) => h`<th scope="col">${c.label}</th>`)}</tr></thead>
    <tbody>${rows.map((r) => h`<tr>${columns.map((c) => h`<td>${c.render ? c.render(r) : r[c.key]}</td>`)}</tr>`)}</tbody>
  </table></div>`;
}

export function pagination({ total, limit, offset, baseQuery, path }) {
  if (total <= limit) return '';
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.ceil(total / limit);
  const link = (o) => `${path}${qs({ ...baseQuery, offset: o })}`;
  return h`<nav class="row pagination" aria-label="Pagination">
    <span class="muted small">Page ${page} of ${pages} · ${total} entries</span><span class="spacer"></span>
    ${offset > 0 ? h`<a class="btn btn--small" href="${link(Math.max(0, offset - limit))}">Previous</a>` : ''}
    ${offset + limit < total ? h`<a class="btn btn--small" href="${link(offset + limit)}">Next</a>` : ''}
  </nav>`;
}

// ---------------------------------------------------------------- Benutzerauswahl (Personalverzeichnis)
export const userPickerMarkup = (name = 'userId', label = 'User') => h`
  <div class="field picker" data-picker="${name}">
    <label for="picker-${name}">${label}</label>
    <input id="picker-${name}" type="search" placeholder="Type at least two letters of a name or badge number" autocomplete="off">
    <input type="hidden" name="${name}" data-type="int">
    <div class="picker__list" hidden></div>
    <div class="picker__chosen muted small"></div>
  </div>`;

export function bindUserPicker(root, name = 'userId') {
  const box = root.querySelector(`[data-picker="${name}"]`);
  if (!box) return;
  const input = box.querySelector('input[type=search]');
  const hidden = box.querySelector('input[type=hidden]');
  const list = box.querySelector('.picker__list');
  const chosen = box.querySelector('.picker__chosen');
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    hidden.value = '';
    chosen.textContent = '';
    const q = input.value.trim();
    if (q.length < 2) { list.hidden = true; return; }
    timer = setTimeout(async () => {
      try {
        const people = await api.get(`/api/directory${qs({ q })}`);
        list.innerHTML = people.length
          ? String(h`${people.map((p) => h`<button type="button" data-id="${p.id}" data-name="${p.displayName}">
              <strong>${p.displayName}</strong> ${p.badgeNo ? h`<span class="muted">#${p.badgeNo}</span>` : ''}
              <div class="small muted">${p.memberships.map((m) => `${m.org?.shortName ?? ''}${m.rank ? ` · ${m.rank}` : ''}`).join(' / ')}</div></button>`)}`)
          : '<div class="empty small">No matching active users.</div>';
        list.hidden = false;
      } catch (err) { showError(err); }
    }, 250);
  });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    hidden.value = b.dataset.id;
    input.value = b.dataset.name;
    chosen.textContent = `Selected: ${b.dataset.name}`;
    list.hidden = true;
  });
}

export { h, raw, esc, fmtDate, titleCase };

// ---------------------------------------------------------------- Personenauswahl (Personenakte)
export const personPickerMarkup = (name = 'personId', label = 'Person record', hint = '') => h`
  <div class="field picker" data-picker="${name}">
    <label for="picker-${name}">${label} <span class="muted small">(optional)</span></label>
    <input id="picker-${name}" type="search" placeholder="Type at least two letters of a name, alias or person number" autocomplete="off">
    <input type="hidden" name="${name}" data-type="int">
    <div class="picker__list" hidden></div>
    <div class="picker__chosen muted small"></div>
    ${hint ? h`<div class="field__hint">${hint}</div>` : ''}
  </div>`;

/** Personenauswahl binden; onPick(person) optional (z. B. Namen übernehmen). */
export function bindPersonPicker(root, name = 'personId', onPick = null) {
  const box = root.querySelector(`[data-picker="${name}"]`);
  if (!box) return;
  const input = box.querySelector('input[type=search]');
  const hidden = box.querySelector('input[type=hidden]');
  const list = box.querySelector('.picker__list');
  const chosen = box.querySelector('.picker__chosen');
  let timer;
  let found = [];
  input.addEventListener('input', () => {
    clearTimeout(timer);
    hidden.value = '';
    chosen.textContent = '';
    const q = input.value.trim();
    if (q.length < 2) { list.hidden = true; return; }
    timer = setTimeout(async () => {
      try {
        found = (await api.get(`/api/persons${qs({ q, limit: 10 })}`)).items;
        list.innerHTML = found.length
          ? String(h`${found.map((p) => h`<button type="button" data-id="${p.id}"><strong>${p.fullName}</strong> <span class="muted">${p.personNo}</span>
              <div class="small muted">${[p.dateOfBirth ? `born ${p.dateOfBirth}` : '', p.aliases].filter(Boolean).join(' · ')}</div></button>`)}`)
          : '<div class="empty small">No matching person records.</div>';
        list.hidden = false;
      } catch (err) { showError(err); }
    }, 250);
  });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    const person = found.find((p) => String(p.id) === b.dataset.id);
    hidden.value = b.dataset.id;
    input.value = person?.fullName ?? '';
    chosen.textContent = `Selected: ${person?.fullName} (${person?.personNo})`;
    list.hidden = true;
    onPick?.(person);
  });
}
