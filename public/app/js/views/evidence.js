/**
 * Beweismittel und Chain of Custody: eigener Gewahrsam, Detail mit lückenloser Übergabekette, Registrierung.
 * Übergaben sind zweiseitig: abgebende Person leitet ein, empfangende Person bestätigt.
 */
import { api, qs, uploadFile } from '../api.js';
import { h, fmtDate, titleCase } from '../html.js';
import { navigate } from '../router.js';
import { setContext } from '../shell.js';
import { table, pagination, levelBadge, badge, demoBadge, field, formDialog, reasonDialog, toast, showError, userPickerMarkup, bindUserPicker } from '../ui.js';

const STATUS = { IN_CUSTODY: 'In custody', IN_TRANSFER: 'Transfer pending', RELEASED: 'Released', DISPOSED: 'Disposed' };
const statusBadge = (s) => badge(STATUS[s] ?? titleCase(s), s === 'IN_CUSTODY' ? 'badge--status-ACTIVE' : s === 'IN_TRANSFER' ? 'badge--unverified' : 'badge--status-CLOSED');
const KIND = { COLLECTED: 'Collected', TRANSFER: 'Transfer', TRANSFER_REJECTED: 'Transfer rejected', TRANSFER_CANCELLED: 'Transfer withdrawn',
  LOCATION_CHANGE: 'Location changed', RELEASED: 'Released', DISPOSED: 'Disposed' };
const localNow = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };

export const evidenceColumns = [
  { label: 'Item', render: (e) => h`<a href="/app/evidence/${e.id}">${e.evidenceNo}</a>${e.awaitingMyAcceptance ? h` ${badge('Awaiting your confirmation', 'badge--unverified')}` : ''}` },
  { label: 'Description', key: 'description' },
  { label: 'Category', render: (e) => titleCase(e.category) },
  { label: 'Holder', key: 'holder' },
  { label: 'Location', key: 'location' },
  { label: 'Status', render: (e) => statusBadge(e.status) },
];

// ---------------------------------------------------------------- Liste
export async function listView({ query }) {
  const f = { mine: query.mine ?? '1', limit: 50, offset: Number(query.offset ?? 0) };
  const data = await api.get(`/api/evidence${qs({ ...f, mine: f.mine === '1' ? '1' : '' })}`);
  return {
    title: 'Evidence custody',
    html: h`<div class="page-head"><div class="page-head__title"><h1>Evidence custody</h1>
        <p>${f.mine === '1' ? 'Items in your custody and transfers awaiting your confirmation.' : 'All items available to you.'} New items are registered within a case.</p></div>
        <div class="page-head__actions"><a class="btn" href="/app/evidence${f.mine === '1' ? '?mine=0' : ''}">${f.mine === '1' ? 'Show all available items' : 'Show my custody'}</a></div></div>
      <div class="card">${table(evidenceColumns, data.items, f.mine === '1' ? 'No items in your custody.' : 'No evidence available to you.')}
        ${pagination({ total: data.total, limit: f.limit, offset: f.offset, baseQuery: { mine: f.mine }, path: '/app/evidence' })}</div>`,
  };
}

// ---------------------------------------------------------------- Registrierung
export async function newEvidenceDialog(caseId) {
  const categories = await api.get('/api/evidence-categories');
  const result = await formDialog({
    title: 'Register evidence', submitLabel: 'Register',
    body: h`${field({ name: 'description', label: 'Description', type: 'textarea', required: true })}
      ${field({ name: 'category', label: 'Category', options: categories.map((c) => ({ value: c, label: titleCase(c) })) })}
      ${field({ name: 'location', label: 'Place of collection', required: true })}
      ${field({ name: 'collectedAt', label: 'Collected at', type: 'datetime-local', value: localNow() })}
      <p class="muted small">You are recorded as the first custodian. Every later handover must be confirmed by the recipient.</p>`,
    onSubmit: (d) => api.post('/api/evidence', { caseId, description: d.description, category: d.category, location: d.location, collectedAt: d.collectedAt || undefined }),
  });
  if (result?.id) { toast(`Evidence ${result.evidenceNo} registered.`); navigate(`/app/evidence/${result.id}`); }
  return result;
}

// ---------------------------------------------------------------- Detail
export async function detailView({ params }) {
  const e = await api.get(`/api/evidence/${Number(params.id)}`);
  const cap = e.capabilities;
  if (e.case) setContext({ caseNumber: e.case.caseNumber, level: e.securityLevel });
  const pt = e.pendingTransfer;
  const actions = [
    cap.transfer && h`<button class="btn btn--primary" data-act="transfer">Hand over</button>`,
    cap.move && h`<button class="btn" data-act="move">Change location</button>`,
    cap.addFile && h`<button class="btn" data-act="file">Add photo / file</button>`,
    cap.dispose && h`<button class="btn" data-act="release">Release</button>`,
    cap.dispose && h`<button class="btn btn--danger" data-act="dispose">Dispose</button>`,
  ].filter(Boolean);

  return {
    title: e.evidenceNo,
    html: h`<div class="page-head"><div class="page-head__title"><p class="small muted">${titleCase(e.category)} · ${e.owningOrg?.name}</p>
        <h1>${e.evidenceNo} – ${e.description}</h1>
        <div class="row">${statusBadge(e.status)} ${levelBadge(e.securityLevel)} ${demoBadge(e.isDemo)}
          ${e.integrity.ok ? badge('Chain intact', 'badge--status-ACTIVE') : badge('Integrity failure', 'badge--sealed')}</div></div>
        ${actions.length ? h`<div class="page-head__actions">${actions}</div>` : ''}</div>
      ${!e.integrity.ok ? h`<div class="notice notice--error">The chain of custody failed its integrity check at entry ${e.integrity.brokenAtSeq}. Inform your supervisor; the record may have been tampered with.</div>` : ''}
      ${pt ? h`<div class="notice notice--warn"><strong>Handover pending:</strong> ${pt.from.name} → ${pt.to.name}, to ${pt.location} (${pt.reason}), initiated ${fmtDate(pt.createdAt)}.
        ${cap.accept ? h`<div class="row"><button class="btn btn--primary" data-act="accept">Confirm receipt</button><button class="btn btn--danger" data-act="reject">Reject</button></div>` : ''}
        ${cap.cancel ? h`<div class="row"><button class="btn" data-act="cancel">Withdraw handover</button></div>` : ''}</div>` : ''}
      <div class="grid grid--2">
        <div class="card"><div class="card__head"><h2>Item</h2></div><div class="card__body"><dl class="fields">
          <dt>Category</dt><dd>${titleCase(e.category)}</dd>
          <dt>Collected</dt><dd>${fmtDate(e.collectedAt)} by ${e.collectedBy}</dd>
          <dt>Place of collection</dt><dd>${e.collectedLocation}</dd>
          <dt>Current custodian</dt><dd><strong>${e.holder.name}</strong></dd>
          <dt>Current location</dt><dd>${e.location}</dd>
          <dt>Case</dt><dd>${e.case ? h`<a href="/app/cases/${e.case.id}">${e.case.caseNumber}</a>` : h`<span class="muted">not available to you</span>`}</dd></dl></div></div>
        <div class="card"><div class="card__head"><h2>Photos & files</h2></div>
          ${table([{ label: 'File', render: (f) => h`<a href="/api/files/${f.id}" download>${f.name}</a>` }, { label: 'Caption', key: 'caption' }, { label: 'Added', render: (f) => fmtDate(f.addedAt) }],
            e.files, 'No files attached.')}</div>
      </div>
      <div class="card"><div class="card__head"><h2>Chain of custody</h2><span class="muted small">${e.custody.length} entries · append-only, hash-chained</span></div>
        ${table([
          { label: '#', key: 'seq' },
          { label: 'Event', render: (c) => KIND[c.kind] ?? c.kind },
          { label: 'From', render: (c) => c.from?.name ?? '—' },
          { label: 'To', render: (c) => c.to?.name ?? '—' },
          { label: 'Date / time', render: (c) => fmtDate(c.initiatedAt) },
          { label: 'Location', key: 'location' },
          { label: 'Reason', key: 'reason' },
          { label: 'Confirmed', render: (c) => (c.confirmedAt ? fmtDate(c.confirmedAt) : '—') },
          { label: 'Hash', render: (c) => h`<span class="hash" title="${c.hash}">${c.hash.slice(0, 12)}…</span>` },
        ], e.custody)}</div>`,
    mount(el) {
      el.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-act]');
        if (!b) return;
        act(b.dataset.act).then((r) => {
          if (r?.declined) { toast('Handover rejected.'); navigate('/app/evidence'); } else if (r) navigate(`/app/evidence/${e.id}`, { replace: true });
        }).catch(showError);
      });
    },
  };

  async function act(action) {
    const base = `/api/evidence/${e.id}`;
    switch (action) {
      case 'transfer':
        return formDialog({ title: `Hand over ${e.evidenceNo}`, submitLabel: 'Initiate handover',
          body: h`<p>Custody changes only after the recipient confirms receipt.</p>${userPickerMarkup('toUserId', 'Recipient')}
            ${field({ name: 'location', label: 'New location', required: true })}${field({ name: 'reason', label: 'Reason', type: 'textarea', required: true })}`,
          onOpen: (dlg) => bindUserPicker(dlg, 'toUserId'), onSubmit: (d) => api.post(`${base}/transfer`, d) });
      case 'accept':
        return formDialog({ title: 'Confirm receipt', submitLabel: 'Confirm receipt',
          body: h`<p>You confirm that you have received <strong>${e.evidenceNo}</strong> from ${pt.from.name} at ${pt.location}. You become its custodian.</p>`,
          onSubmit: () => api.post(`${base}/accept`) });
      case 'reject': case 'cancel':
        return reasonDialog({ title: action === 'reject' ? 'Reject handover' : 'Withdraw handover', danger: action === 'reject',
          submitLabel: action === 'reject' ? 'Reject' : 'Withdraw', onSubmit: (d) => api.post(`${base}/${action}`, d) });
      case 'move':
        return formDialog({ title: 'Change location', body: h`${field({ name: 'location', label: 'New location', required: true })}${field({ name: 'reason', label: 'Reason', type: 'textarea', required: true })}`,
          onSubmit: (d) => api.post(`${base}/move`, d) });
      case 'release': case 'dispose':
        return reasonDialog({ title: action === 'release' ? 'Release item' : 'Dispose of item', danger: true, submitLabel: titleCase(action),
          text: 'This is final. The chain of custody is closed.', onSubmit: (d) => api.post(`${base}/${action}`, d) });
      case 'file':
        return formDialog({ title: 'Add photo or file', submitLabel: 'Upload',
          body: h`<div class="field"><label for="ev-file">File</label><input id="ev-file" type="file" name="file" accept="application/pdf,image/png,image/jpeg,image/webp" required>
            <div class="field__hint">PDF, PNG, JPEG or WebP, up to 10 MB.</div></div>${field({ name: 'caption', label: 'Caption' })}`,
          onSubmit: async (d, form) => {
            const file = form.elements.file.files[0];
            if (!file) throw new Error('Choose a file.');
            const up = await uploadFile(file);
            return api.post(`${base}/files`, { fileId: up.id, caption: d.caption });
          } });
      default:
        return false;
    }
  }
}

