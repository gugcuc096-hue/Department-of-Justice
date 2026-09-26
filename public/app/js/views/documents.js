/**
 * Dokumente: Liste, Detail (Vorschau, Signaturen, Versionen), Druckansicht, Anlage-Dialog.
 * Das gerenderte Dokument-HTML erzeugt der Server aus Vorlage + escapten Werten; es wird unverändert eingesetzt.
 * Aktionen bestimmt der Server (capabilities); jede wird serverseitig erneut geprüft.
 */
import { api, qs, uploadFile, ApiError } from '../api.js';
import { h, raw, fmtDate, titleCase } from '../html.js';
import { navigate } from '../router.js';
import { setContext } from '../shell.js';
import { state } from '../state.js';
import { table, pagination, levelBadge, badge, demoBadge, unverifiedBadge, field, formDialog, reasonDialog, toast, showError } from '../ui.js';

const STATUS_LABEL = { DRAFT: 'Draft', IN_REVIEW: 'In review', APPROVED: 'Approved', REJECTED: 'Rejected', SIGNED: 'Signed', ISSUED: 'Issued', ARCHIVED: 'Archived' };
const docStatusBadge = (s) => badge(STATUS_LABEL[s] ?? titleCase(s), s === 'ISSUED' || s === 'SIGNED' || s === 'APPROVED' ? 'badge--status-ACTIVE' : s === 'REJECTED' ? 'badge--sealed' : '');
const sigBadge = (s) => ({ VALID: badge('Valid', 'badge--status-ACTIVE'), SUPERSEDED: badge('Earlier version'), REVOKED: badge('Revoked', 'badge--status-DISABLED'), INVALID: badge('Integrity failure', 'badge--sealed') })[s];
const fmtSize = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

export const docColumns = [
  { label: 'Document', render: (d) => h`<a href="/app/documents/${d.id}">${d.docNumber}</a> ${demoBadge(d.isDemo)}` },
  { label: 'Title', key: 'title' },
  { label: 'Type', render: (d) => d.type.name },
  { label: 'Status', render: (d) => docStatusBadge(d.status) },
  { label: 'Version', key: 'version' },
  { label: 'Updated', render: (d) => fmtDate(d.updatedAt) },
];

// ---------------------------------------------------------------- Liste
export async function listView({ query }) {
  const f = { q: query.q ?? '', status: query.status ?? '', limit: 25, offset: Number(query.offset ?? 0) };
  const data = await api.get(`/api/documents${qs(f)}`);
  return {
    title: 'Documents',
    html: h`<div class="page-head"><div class="page-head__title"><h1>Documents</h1><p>Documents available to you – in cases and of your office.</p></div>
        <div class="page-head__actions"><button class="btn btn--primary" data-new>New document</button></div></div>
      <div class="card"><div class="card__body"><form class="row" data-filter>
        <div class="field"><label for="d-q">Search</label><input id="d-q" type="search" name="q" value="${f.q}" placeholder="Number or title"></div>
        ${field({ name: 'status', label: 'Status', value: f.status, plain: true, options: [{ value: '', label: 'Any status' }, ...Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }))] })}
        <div class="field"><button class="btn" type="submit">Apply</button></div></form></div>
      ${table([...docColumns.slice(0, 3), { label: 'Case', render: (d) => (d.case ? h`<a href="/app/cases/${d.case.id}">${d.case.caseNumber}</a>` : h`<span class="muted">${d.issuer?.shortName}</span>`) }, ...docColumns.slice(3)],
        data.items, 'No documents match your filters.')}
      ${pagination({ total: data.total, limit: f.limit, offset: f.offset, baseQuery: { q: f.q, status: f.status }, path: '/app/documents' })}</div>`,
    mount(el) {
      el.querySelector('[data-filter]').addEventListener('submit', (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        navigate(`/app/documents${qs({ q: fd.get('q'), status: fd.get('status') })}`);
      });
      el.querySelector('[data-new]').addEventListener('click', () => {
        newDocumentDialog({ orgId: state.me.activeOrg?.id }).catch(showError);
      });
    },
  };
}

// ---------------------------------------------------------------- Anlage
/**
 * @param {{ caseId?: number, orgId?: number }} context
 */
export async function newDocumentDialog(context) {
  const types = await api.get(`/api/document-types${qs(context)}`);
  if (!types.length) { toast('You cannot create documents here.', 'error'); return null; }
  const fieldsFor = (t) => (t.isAttachment
    ? h`<div class="field"><label for="doc-file">File</label><input id="doc-file" type="file" name="file" accept="application/pdf,image/png,image/jpeg,image/webp" required>
        <div class="field__hint">PDF, PNG, JPEG or WebP, up to 10 MB.</div></div>`
    : h`${t.fields.map((f) => field({ name: `content.${f.key}`, label: f.label, type: f.type === 'textarea' ? 'textarea' : 'text', required: f.required }))}`);
  const result = await formDialog({
    title: 'New document', submitLabel: 'Create draft',
    body: h`${field({ name: 'typeCode', label: 'Document type', options: types.map((t) => ({ value: t.code, label: `${t.name}${t.enabled ? '' : ' – disabled (legal basis not verified)'}` })) })}
      <div data-type-note></div>
      ${field({ name: 'title', label: 'Title', required: true })}
      <div data-fields></div>`,
    onOpen: (dlg) => {
      const sel = dlg.querySelector('[name=typeCode]');
      const sync = () => {
        const t = types.find((x) => x.code === sel.value);
        dlg.querySelector('[data-fields]').innerHTML = String(fieldsFor(t));
        dlg.querySelector('[data-type-note]').innerHTML = String(h`${!t.enabled ? h`<div class="notice notice--warn">This document type is disabled because its legal basis has not been verified.</div>`
          : h`<p>${t.templateName ? h`<span class="muted small">Template: ${t.templateName}</span> ` : ''}${unverifiedBadge(t.legalStatus)}</p>`}`);
        dlg.querySelector('[type=submit]').disabled = !t.enabled;
      };
      sel.addEventListener('change', sync);
      sync();
    },
    onSubmit: async (d, form) => {
      const t = types.find((x) => x.code === d.typeCode);
      const body = { typeCode: d.typeCode, title: d.title, caseId: context.caseId ?? null, orgId: context.caseId ? null : context.orgId ?? null, content: {} };
      for (const [k, v] of Object.entries(d)) if (k.startsWith('content.')) body.content[k.slice(8)] = v;
      if (t.isAttachment) {
        const file = form.elements.file.files[0];
        if (!file) throw new ApiError(400, { error: { message: 'Choose a file.', details: [{ field: 'file', message: 'A file is required.' }] } });
        body.fileId = (await uploadFile(file)).id;
      }
      return api.post('/api/documents', body);
    },
  });
  if (result?.id) { toast(`Document ${result.docNumber} created.`); navigate(`/app/documents/${result.id}`); }
  return result;
}

// ---------------------------------------------------------------- Dokument-Blatt (Vorschau & Druck)
function sheet(doc, version) {
  const valid = version.signatures.filter((s) => s.status === 'VALID' || s.status === 'SUPERSEDED');
  const classification = [titleCase(doc.securityLevel), ...doc.compartments, ...(doc.case?.isSealed ? ['Sealed'] : [])].join(' · ');
  const brand = window.USMSBrand;
  return h`<article class="usms-doc doc-sheet">
    ${doc.isDemo ? h`<p class="doc-watermark">Demo – fictitious data</p>` : ''}
    ${!valid.length ? h`<p class="doc-watermark">Entwurf – nicht unterzeichnet</p>` : ''}
    ${version.version !== doc.currentVersion.version ? h`<p class="doc-watermark">Frühere Fassung (Version ${version.version})</p>` : ''}
    ${raw(brand.html.documentHeader({ issuer: doc.issuer?.brandCode, title: doc.type.name, numberLabel: 'Document number', number: doc.docNumber, date: version.createdAt?.slice(0, 10), classification }))}
    <div class="doc-body">
      ${doc.case ? h`<p class="small muted">Aktenzeichen: ${doc.case.caseNumber}</p>` : ''}
      ${raw(version.renderedHtml)}
      ${doc.currentVersion.file && version.version === doc.currentVersion.version ? h`<p>Anlage: ${doc.currentVersion.file.name} (${fmtSize(doc.currentVersion.file.size)})</p>` : ''}
      ${valid.map((s) => h`<div class="doc-signature">
        ${s === valid[0] ? h`<p>Hochachtungsvoll</p>` : ''}
        <p class="doc-signature__name">${s.signer.name}</p>
        <p>${s.signer.rank ? `${s.signer.rank} at the ` : ''}${s.signer.org}${s.capacity ? ` · ${s.capacity}` : ''}</p>
        <p class="doc-signature__meta">Digitally signed ${fmtDate(s.signedAt)} · Version ${s.version} · SHA-256 ${s.sha256.slice(0, 16)}…</p>
      </div>`)}
    </div>
    ${raw(brand.html.documentFooter({ issuer: doc.issuer?.brandCode }))}
  </article>`;
}

// ---------------------------------------------------------------- Detail
export async function detailView({ params }) {
  const doc = await api.get(`/api/documents/${Number(params.id)}`);
  const cap = doc.capabilities;
  const version = { ...doc.currentVersion, signatures: doc.signatures.filter((s) => s.version === doc.currentVersion.version) };
  if (doc.case) setContext({ caseNumber: doc.case.caseNumber, level: doc.securityLevel });

  const actions = [
    cap.edit && h`<button class="btn" data-act="edit">Edit (new version)</button>`,
    cap.submit && h`<button class="btn" data-act="submit">Submit for review</button>`,
    cap.approve && h`<button class="btn btn--primary" data-act="approve">Approve</button>`,
    cap.reject && h`<button class="btn btn--danger" data-act="reject">Reject</button>`,
    cap.sign && h`<button class="btn btn--primary" data-act="sign">Sign</button>`,
    cap.issue && h`<button class="btn btn--primary" data-act="issue">Issue</button>`,
    cap.archive && h`<button class="btn" data-act="archive">Archive</button>`,
    cap.delete && h`<button class="btn btn--danger" data-act="delete">Discard draft</button>`,
    h`<a class="btn" href="/app/documents/${doc.id}/print">Print view</a>`,
  ].filter(Boolean);

  return {
    title: doc.docNumber,
    html: h`<div class="page-head"><div class="page-head__title">
        <p class="small muted">${doc.type.name} · ${doc.issuer?.name}${doc.case ? h` · Case <a href="/app/cases/${doc.case.id}">${doc.case.caseNumber}</a>` : ''}</p>
        <h1>${doc.docNumber} – ${doc.title}</h1>
        <div class="row">${docStatusBadge(doc.status)} ${levelBadge(doc.securityLevel)} ${doc.compartments.map((c) => badge(c, 'badge--compartment'))}
          ${badge(`Version ${doc.currentVersion.version}`)} ${demoBadge(doc.isDemo)} ${unverifiedBadge(doc.legalStatus)}</div></div>
        <div class="page-head__actions">${actions}</div></div>
      <div class="doc-layout">
        <div class="doc-sheet-wrap">${sheet(doc, version)}</div>
        <div class="stack">
          <div class="card"><div class="card__head"><h2>Signatures</h2></div><div class="card__body">
            ${doc.signatures.length ? h`<ul class="sig-list">${doc.signatures.map((s) => h`<li>
              <div class="row"><strong>${s.signer.name}</strong> ${sigBadge(s.status)}</div>
              <div class="small">${s.signer.rank ? `${s.signer.rank}, ` : ''}${s.signer.org}${s.capacity ? ` · ${s.capacity}` : ''}</div>
              <div class="small muted">${fmtDate(s.signedAt)} · Version ${s.version}</div>
              <div class="hash">SHA-256 ${s.sha256}</div>
              ${s.revocation ? h`<div class="small">Revoked ${fmtDate(s.revocation.at)} by ${s.revocation.by}: ${s.revocation.reason}</div>` : ''}
              ${!s.revocation && (cap.revokeAny || s.signer.id === state.me.id) ? h`<button class="btn btn--small btn--danger" data-act="revoke" data-id="${s.id}">Revoke signature</button>` : ''}
            </li>`)}</ul>` : h`<p class="muted">Not signed.</p>`}
            ${doc.type.signable ? '' : h`<p class="muted small">This document type is not signed.</p>`}
          </div></div>
          ${doc.currentVersion.file ? h`<div class="card"><div class="card__head"><h2>File</h2></div><div class="card__body">
            <p><strong>${doc.currentVersion.file.name}</strong><br><span class="small muted">${doc.currentVersion.file.mime} · ${fmtSize(doc.currentVersion.file.size)}</span></p>
            <div class="hash">SHA-256 ${doc.currentVersion.file.sha256}</div>
            ${cap.download ? h`<p><a class="btn btn--small" href="/api/files/${doc.currentVersion.file.id}" download>Download</a></p>` : ''}</div></div>` : ''}
          <div class="card"><div class="card__head"><h2>Versions</h2></div><div class="card__body"><ul class="sig-list">
            ${doc.versions.map((v) => h`<li><div class="row"><strong>Version ${v.version}</strong>${v.version === doc.currentVersion.version ? badge('Current') : ''}
              <span class="spacer"></span><a class="btn btn--small" href="/app/documents/${doc.id}/print?v=${v.version}">View</a></div>
              <div class="small muted">${fmtDate(v.createdAt)} · ${v.createdBy}${v.changeNote ? ` · ${v.changeNote}` : ''}</div>
              <div class="hash">${v.sha256}</div></li>`)}</ul></div></div>
        </div>
      </div>`,
    mount(el) {
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        act(b.dataset.act, b.dataset).then((changed) => { if (changed) navigate(`/app/documents/${doc.id}`, { replace: true }); }).catch(showError);
      });
    },
  };

  async function act(action, data) {
    const base = `/api/documents/${doc.id}`;
    switch (action) {
      case 'edit': {
        const fields = doc.currentVersion.content.fields ?? {};
        return formDialog({
          title: `Edit ${doc.docNumber}`, submitLabel: 'Save as new version',
          body: h`${doc.signatures.some((s) => s.status === 'VALID') ? h`<div class="notice notice--warn">Existing signatures apply to the current version only. The new version will be unsigned.</div>` : ''}
            ${field({ name: 'title', label: 'Title', value: doc.title, required: true })}
            ${doc.templateFields.map((f) => field({ name: `content.${f.key}`, label: f.label, type: f.type === 'textarea' ? 'textarea' : 'text', value: fields[f.key] ?? '', required: f.required }))}
            ${doc.currentVersion.file ? h`<div class="field"><label for="doc-file">Replace file</label><input id="doc-file" type="file" name="file" accept="application/pdf,image/png,image/jpeg,image/webp"></div>` : ''}
            ${field({ name: 'changeNote', label: 'Change note', hint: 'Shown in the version history.' })}`,
          onSubmit: async (d, form) => {
            const body = { title: d.title, changeNote: d.changeNote, content: {} };
            for (const [k, v] of Object.entries(d)) if (k.startsWith('content.')) body.content[k.slice(8)] = v;
            const file = form.elements.file?.files?.[0];
            if (file) body.fileId = (await uploadFile(file)).id;
            if (!doc.templateFields.length) delete body.content;
            return api.patch(base, body);
          },
        });
      }
      case 'submit':
        return api.post(`${base}/submit`).then(() => true);
      case 'approve': case 'reject':
        return reasonDialog({ title: `${titleCase(action)} document`, submitLabel: titleCase(action), danger: action === 'reject', onSubmit: (d) => api.post(`${base}/${action}`, d) });
      case 'sign':
        return formDialog({
          title: `Sign ${doc.docNumber}`, submitLabel: 'Sign',
          body: h`<p>You sign <strong>version ${doc.currentVersion.version}</strong> of this document. Your signature is bound to this exact content:</p>
            <p class="hash">SHA-256 ${doc.currentVersion.sha256}</p>
            <p>Any later change creates a new, unsigned version.</p>
            ${field({ name: 'capacity', label: 'Signing capacity', hint: 'e.g. "Issuing judge", "Presiding judge"' })}`,
          onSubmit: (d) => api.post(`${base}/sign`, d),
        });
      case 'issue':
        return formDialog({ title: `Issue ${doc.docNumber}`, submitLabel: 'Issue', body: h`<p>The signed document becomes official. It can no longer be edited.</p>`,
          onSubmit: () => api.post(`${base}/issue`) });
      case 'archive':
        return reasonDialog({ title: 'Archive document', submitLabel: 'Archive', onSubmit: (d) => api.post(`${base}/archive`, d) });
      case 'delete': {
        const ok = await formDialog({ title: 'Discard draft', danger: true, submitLabel: 'Discard', body: h`<p>The draft is removed from all lists. Its versions remain in the audit trail.</p>`,
          onSubmit: () => api.del(base) });
        if (ok) navigate(doc.case ? `/app/cases/${doc.case.id}?tab=documents` : '/app/documents');
        return false;
      }
      case 'revoke':
        return reasonDialog({ title: 'Revoke signature', danger: true, submitLabel: 'Revoke', onSubmit: (d) => api.post(`${base}/signatures/${data.id}/revoke`, d) });
      default:
        return false;
    }
  }
}

// ---------------------------------------------------------------- Druckansicht
export async function printView({ params, query }) {
  const id = Number(params.id);
  const doc = await api.get(`/api/documents/${id}`);
  const v = query.v ? await api.get(`/api/documents/${id}/versions/${Number(query.v)}`) : { ...doc.currentVersion, signatures: doc.signatures.filter((s) => s.version === doc.currentVersion.version) };
  // Druckmodus blendet den Anwendungsrahmen aus; main.js setzt ihn bei jedem Seitenwechsel zurück
  document.body.classList.add('print-mode');
  return {
    title: `${doc.docNumber} (print)`,
    html: h`<div class="row usms-no-print"><a class="btn" href="/app/documents/${doc.id}">Back</a><span class="spacer"></span>
        <button class="btn btn--primary" data-print>Print or save as PDF</button></div>
      <h1 class="visually-hidden">${doc.docNumber} – ${doc.title}</h1>
      <div class="doc-sheet-wrap">${sheet(doc, v)}</div>`,
    mount(el) {
      el.querySelector('[data-print]').addEventListener('click', () => window.print());
    },
  };
}
