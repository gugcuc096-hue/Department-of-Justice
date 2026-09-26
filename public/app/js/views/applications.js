/**
 * Anträge an Gerichte (Haftbefehl, Durchsuchung, Vorladung) – Liste, Detail mit Verfahrensschritten, Anlage.
 * Welche Schritte angeboten werden, liefert der Server (actions); jeder wird serverseitig erneut geprüft.
 * Rechtlich erhebliche Entscheidungen trifft ausschließlich der zugewiesene Richter.
 */
import { api, qs } from '../api.js';
import { h, raw, fmtDate, titleCase } from '../html.js';
import { navigate } from '../router.js';
import { setContext } from '../shell.js';
import { table, pagination, levelBadge, badge, unverifiedBadge, field, formDialog, reasonDialog, toast, showError, personPickerMarkup, bindPersonPicker } from '../ui.js';

const STATUS_CLASS = { ISSUED: 'badge--status-ACTIVE', APPROVED: 'badge--status-ACTIVE', DENIED: 'badge--sealed', WITHDRAWN: 'badge--status-DISABLED', CLOSED: 'badge--status-CLOSED' };
const appStatus = (a) => badge(a.statusLabel ?? titleCase(a.status), STATUS_CLASS[a.status] ?? '');
const ACTION_LABEL = {
  submit: 'Submit to court', withdraw: 'Withdraw', accept: 'Accept & assign judge', request_revision: 'Request revision',
  approve: 'Approve', deny: 'Deny', issue: 'Issue',
};

export const appColumns = [
  { label: 'Application', render: (a) => h`<a href="/app/applications/${a.id}">${a.applicationNo}</a>` },
  { label: 'Kind', render: (a) => a.kindLabel },
  { label: 'Title', key: 'title' },
  { label: 'Court', render: (a) => a.targetCourt?.shortName },
  { label: 'Status', render: appStatus },
  { label: 'Updated', render: (a) => fmtDate(a.updatedAt) },
];

// ---------------------------------------------------------------- Liste
export async function listView({ query }) {
  const f = { awaiting: query.awaiting ?? '', status: query.status ?? '', limit: 25, offset: Number(query.offset ?? 0) };
  const data = await api.get(`/api/applications${qs(f)}`);
  return {
    title: 'Court applications',
    html: h`<div class="page-head"><div class="page-head__title"><h1>Court applications</h1>
        <p>Applications for warrants and subpoenas. New applications are filed from within a case.</p></div></div>
      <div class="card"><div class="card__body"><form class="row" data-filter>
        ${field({ name: 'status', label: 'Status', value: f.status, plain: true, options: [{ value: '', label: 'Any status' },
          ...['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'REVISION_REQUESTED', 'APPROVED', 'ISSUED', 'DENIED', 'WITHDRAWN', 'CLOSED'].map((s) => ({ value: s, label: titleCase(s) }))] })}
        <div class="field"><label class="checkbox"><input type="checkbox" name="awaiting" value="1" ${f.awaiting === '1' ? raw('checked') : ''}> Awaiting my action</label></div>
        <div class="field"><button class="btn" type="submit">Apply</button></div></form></div>
      ${table(appColumns, data.items, 'No applications.')}
      ${pagination({ total: data.total, limit: f.limit, offset: f.offset, baseQuery: { awaiting: f.awaiting, status: f.status }, path: '/app/applications' })}</div>`,
    mount(el) {
      el.querySelector('[data-filter]').addEventListener('submit', (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        navigate(`/app/applications${qs({ status: fd.get('status'), awaiting: fd.get('awaiting') ? '1' : '' })}`);
      });
    },
  };
}

// ---------------------------------------------------------------- Formular (Anlage / Bearbeitung)
const contentFields = (c = {}) => h`
  ${field({ name: 'content.subjectName', label: 'Person concerned', value: c.subjectName ?? '', hint: 'Required for arrest warrants and subpoenas.' })}
  ${field({ name: 'content.offense', label: 'Suspected offense (wegen des Verdachts …)', value: c.offense ?? '', required: true })}
  ${field({ name: 'content.requestedMeasure', label: 'Requested measure', type: 'textarea', value: c.requestedMeasure ?? '', required: true,
    hint: 'Becomes the operative part of the draft decision; the judge may change it.' })}
  ${field({ name: 'content.grounds', label: 'Grounds', type: 'textarea', value: c.grounds ?? '', required: true })}`;

/** Personenakte auswählen; der Name wird in „Person concerned“ übernommen. */
const bindSubject = (dlg) => bindPersonPicker(dlg, 'subjectPersonId', (person) => {
  const input = dlg.querySelector('[name="content.subjectName"]');
  if (input && person) input.value = person.fullName;
});

const collect = (d) => {
  const content = {};
  for (const [k, v] of Object.entries(d)) if (k.startsWith('content.')) content[k.slice(8)] = v;
  return content;
};
const docChecks = (docs, selected = []) => (docs.length
  ? h`<fieldset class="field"><legend class="small"><strong>Attach documents</strong> <span class="muted">(only these are shared with the court)</span></legend>
      ${docs.map((d) => h`<label class="checkbox"><input type="checkbox" name="doc_${d.id}" ${selected.includes(d.id) ? raw('checked') : ''}> ${d.docNumber} – ${d.title}</label>`)}</fieldset>`
  : h`<p class="muted small">This case has no documents to attach.</p>`);
const chosenDocs = (docs, d) => docs.filter((x) => d[`doc_${x.id}`]).map((x) => x.id);

export async function newApplicationDialog(caseId) {
  const opts = await api.get(`/api/application-options${qs({ caseId })}`);
  if (!opts.kinds.length) { toast('You cannot file applications from this case.', 'error'); return null; }
  const result = await formDialog({
    title: 'New court application', submitLabel: 'Save draft',
    body: h`${field({ name: 'kind', label: 'Kind', options: opts.kinds.map((k) => ({ value: k.code, label: `${k.label}${k.enabled ? '' : ' – disabled (legal basis not verified)'}` })) })}
      ${field({ name: 'targetOrgId', label: 'Court', options: opts.courts.map((c) => ({ value: c.id, label: c.name })), attrs: 'data-type="int"' })}
      ${field({ name: 'title', label: 'Short title', required: true })}
      ${personPickerMarkup('subjectPersonId', 'Person concerned (person record)', 'Links the application and any warrant to the central person file.')}
      ${contentFields()}
      ${docChecks(opts.documents)}
      <p class="muted small">The draft is only visible to your office until you submit it.</p>`,
    onOpen: bindSubject,
    onSubmit: (d) => api.post('/api/applications', { sourceCaseId: caseId, kind: d.kind, targetOrgId: d.targetOrgId, title: d.title,
      content: collect(d), documentIds: chosenDocs(opts.documents, d), subjectPersonId: d.subjectPersonId || null }),
  });
  if (result?.id) { toast(`Application ${result.applicationNo} saved as draft.`); navigate(`/app/applications/${result.id}`); }
  return result;
}

// ---------------------------------------------------------------- Detail
export async function detailView({ params }) {
  const a = await api.get(`/api/applications/${Number(params.id)}`);
  const c = a.content ?? {};
  const ctxCase = a.courtCase ?? a.sourceCase;
  if (ctxCase) setContext({ caseNumber: ctxCase.caseNumber, level: a.securityLevel });

  const buttons = [
    a.canEdit && h`<button class="btn" data-act="edit">Edit</button>`,
    ...a.actions.map((x) => h`<button class="btn ${['approve', 'issue', 'submit', 'accept'].includes(x.action) ? 'btn--primary' : ['deny', 'withdraw'].includes(x.action) ? 'btn--danger' : ''}"
      data-act="${x.action}">${ACTION_LABEL[x.action] ?? titleCase(x.action)}</button>`),
  ].filter(Boolean);

  return {
    title: a.applicationNo,
    html: h`<div class="page-head"><div class="page-head__title">
        <p class="small muted">${a.kindLabel} application · ${a.applicant.org?.name} → ${a.targetCourt?.name}</p>
        <h1>${a.applicationNo} – ${a.title}</h1>
        <div class="row">${appStatus(a)} ${levelBadge(a.securityLevel)} ${unverifiedBadge(a.legalStatus)}</div></div>
        ${buttons.length ? h`<div class="page-head__actions">${buttons}</div>` : ''}</div>
      ${a.status === 'REVISION_REQUESTED' && a.decisionReason ? h`<div class="notice notice--warn"><strong>Revision requested by the court:</strong> ${a.decisionReason}</div>` : ''}
      ${a.status === 'DENIED' ? h`<div class="notice notice--error"><strong>Denied:</strong> ${a.decisionReason}</div>` : ''}
      ${a.status === 'APPROVED' && a.issueReady === false ? h`<div class="notice notice--info">Approved. Review and sign the
        ${a.decisionDocumentId ? h`<a href="/app/documents/${a.decisionDocumentId}">draft decision</a>` : 'draft decision'}, then issue it here.</div>` : ''}
      <div class="grid grid--2">
        <div class="card"><div class="card__head"><h2>Application</h2></div><div class="card__body"><dl class="fields">
          <dt>Person concerned</dt><dd>${a.subjectPerson ? h`<a href="/app/persons/${a.subjectPerson.id}">${a.subjectPerson.fullName}</a>` : c.subjectName || '—'}</dd>
          <dt>Suspected offense</dt><dd>${c.offense || '—'}</dd>
          <dt>Requested measure</dt><dd class="pre">${c.requestedMeasure || '—'}</dd>
          <dt>Grounds</dt><dd class="pre">${c.grounds || '—'}</dd></dl></div></div>
        <div class="card"><div class="card__head"><h2>Procedure</h2></div><div class="card__body"><dl class="fields">
          <dt>Applicant</dt><dd>${a.applicant.name} (${a.applicant.org?.shortName})</dd>
          <dt>Court</dt><dd>${a.targetCourt?.name}</dd>
          <dt>Assigned judge</dt><dd>${a.assignedJudge?.name ?? '—'}</dd>
          <dt>Originating case</dt><dd>${a.sourceCase ? h`<a href="/app/cases/${a.sourceCase.id}">${a.sourceCase.caseNumber}</a>` : h`<span class="muted">not available to you</span>`}</dd>
          <dt>Court case</dt><dd>${a.courtCase ? h`<a href="/app/cases/${a.courtCase.id}">${a.courtCase.caseNumber}</a>` : h`<span class="muted">${a.status === 'SUBMITTED' || a.status === 'DRAFT' ? 'not yet opened' : 'not available to you'}</span>`}</dd>
          <dt>Decision</dt><dd>${a.decisionDocumentId ? h`<a href="/app/documents/${a.decisionDocumentId}">Open decision</a>` : '—'}</dd>
          <dt>Warrant</dt><dd>${a.warrant ? h`<a href="/app/warrants/${a.warrant.id}">${a.warrant.warrantNo}</a> ${badge(titleCase(a.warrant.status))}` : '—'}</dd>
          <dt>Submitted</dt><dd>${fmtDate(a.submittedAt)}</dd>
          <dt>Decided</dt><dd>${fmtDate(a.decidedAt)}</dd></dl></div></div>
      </div>
      <div class="grid grid--2">
        <div class="card"><div class="card__head"><h2>Attached documents</h2></div>
          ${table([{ label: 'Document', render: (d) => h`<a href="/app/documents/${d.id}">${d.docNumber}</a>` }, { label: 'Title', key: 'title' }], a.documents, 'No attached documents available to you.')}</div>
        <div class="card"><div class="card__head"><h2>History</h2></div><div class="card__body"><ol class="timeline">
          ${a.history.map((x) => h`<li><div><strong>${ACTION_LABEL[x.action] ?? titleCase(x.action)}</strong> → ${titleCase(x.to)}</div>
            ${x.comment ? h`<div class="small">${x.comment}</div>` : ''}
            <div class="timeline__meta">${fmtDate(x.at)} · ${x.actor ? x.actor.name : 'System'}</div></li>`)}
        </ol></div></div>
      </div>`,
    mount(el) {
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        act(b.dataset.act).then((changed) => { if (changed) navigate(`/app/applications/${a.id}`, { replace: true }); }).catch(showError);
      });
    },
  };

  async function act(action) {
    const base = `/api/applications/${a.id}`;
    switch (action) {
      case 'edit': {
        const opts = a.sourceCase ? await api.get(`/api/application-options${qs({ caseId: a.sourceCase.id })}`) : { documents: [] };
        return formDialog({
          title: `Edit ${a.applicationNo}`,
          body: h`${field({ name: 'title', label: 'Short title', value: a.title, required: true })}
            ${personPickerMarkup('subjectPersonId', 'Person concerned (person record)', a.subjectPerson ? `Currently: ${a.subjectPerson.fullName}. Leave empty to keep.` : '')}
            ${contentFields(c)}${docChecks(opts.documents, a.documents.map((d) => d.id))}`,
          onOpen: bindSubject,
          onSubmit: (d) => api.patch(base, { title: d.title, content: collect(d), documentIds: chosenDocs(opts.documents, d), ...(d.subjectPersonId ? { subjectPersonId: d.subjectPersonId } : {}) }),
        });
      }
      case 'submit':
        return formDialog({ title: 'Submit to court', submitLabel: 'Submit',
          body: h`<p>The application and the attached documents will be sent to <strong>${a.targetCourt?.name}</strong>. The court will not see the rest of the case.</p>`,
          onSubmit: () => api.post(`${base}/submit`, {}) });
      case 'withdraw': case 'request_revision': case 'deny':
        return reasonDialog({ title: ACTION_LABEL[action], submitLabel: ACTION_LABEL[action], danger: action !== 'request_revision',
          text: action === 'deny' ? 'The applicant will be informed of the reasons.' : '', onSubmit: (d) => api.post(`${base}/${action}`, d) });
      case 'accept': {
        const judges = await api.get(`${base}/judges`);
        return formDialog({ title: 'Accept and assign judge', submitLabel: 'Accept',
          body: h`<p>A court case is opened and the application is assigned for judicial review.</p>
            ${judges.length ? field({ name: 'judgeId', label: 'Judge', attrs: 'data-type="int"',
              options: judges.map((j) => ({ value: j.id, label: `${j.name}${j.rank ? ` – ${j.rank}` : ''}${j.cleared ? '' : ' (not cleared for this level)'}` })) })
              : h`<div class="notice notice--warn">No judge of this court can decide on this application.</div>`}`,
          onSubmit: (d) => api.post(`${base}/accept`, { judgeId: d.judgeId }) });
      }
      case 'approve': {
        const subpoena = a.kind === 'SUBPOENA';
        return formDialog({ title: 'Approve application', submitLabel: 'Approve',
          body: h`<p>A draft decision is created from the court template and prefilled from the application. Review it, sign it and then issue it.</p>
            ${subpoena ? h`${field({ name: 'termin', label: 'Date and time of appearance', required: true })}${field({ name: 'ort', label: 'Place', required: true })}` : ''}
            ${field({ name: 'reason', label: 'Note', type: 'textarea' })}`,
          onSubmit: (d) => api.post(`${base}/approve`, { reason: d.reason, fields: subpoena ? { termin: d.termin, ort: d.ort } : undefined }) });
      }
      case 'issue':
        return formDialog({ title: 'Issue decision', submitLabel: 'Issue',
          body: h`${a.issueReady ? h`<p>The signed decision becomes official. ${a.kind !== 'SUBPOENA'
            ? 'A warrant is created and transmitted to the United States Marshals Service for execution. The Marshals Service sees only the warrant and the decision – not the case.' : ''}</p>`
            : h`<div class="notice notice--warn">The decision must be signed first.</div>`}`,
          onSubmit: () => api.post(`${base}/issue`, {}) });
      default:
        return false;
    }
  }
}
