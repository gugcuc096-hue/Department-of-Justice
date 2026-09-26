/**
 * Akten: Liste, Anlage, Detail (Übersicht, Beteiligte, Verknüpfungen, Zugriff, Timeline).
 * Welche Aktionen angeboten werden, bestimmt der Server (case.capabilities); die API prüft jede Aktion erneut.
 */
import { api, qs, ApiError } from '../api.js';
import { h, raw, fmtDate, titleCase } from '../html.js';
import { navigate } from '../router.js';
import { setContext } from '../shell.js';
import { docColumns, newDocumentDialog } from './documents.js';
import { appColumns, newApplicationDialog } from './applications.js';
import { evidenceColumns, newEvidenceDialog } from './evidence.js';
import { can } from '../state.js';
import { hearingColumns, deadlineColumns, bindDeadlineActions, newHearingDialog, newDeadlineDialog } from './schedule.js';
import { conversationColumns, requestColumns, newCaseConversationDialog, newRequestDialog } from './communication.js';
import {
  table, pagination, statusBadge, levelBadge, badge, demoBadge, unverifiedBadge, field, formDialog, reasonDialog,
  toast, showError, userPickerMarkup, bindUserPicker, formData, showFieldErrors, personPickerMarkup, bindPersonPicker,
} from '../ui.js';

const PARTICIPANT_ROLES = ['LEAD', 'INVESTIGATOR', 'PROSECUTOR', 'JUDGE', 'CLERK', 'DEPUTY', 'OFFICER', 'REGISTRAR', 'COUNSEL',
  'DEFENDANT', 'PLAINTIFF', 'RESPONDENT', 'APPLICANT', 'VICTIM', 'WITNESS', 'OBSERVER'];
const LINK_TYPES = { RELATED: 'Related', ORIGINATED_FROM: 'Originated from', ESCALATED_TO: 'Escalated to', APPEAL_OF: 'Appeal of', REVIEW_OF: 'Review of' };
const STATUSES = [['', 'Any status'], ['OPEN_OR_ACTIVE', 'Open or active'], ['OPEN', 'Open'], ['ACTIVE', 'Active'], ['CLOSED', 'Closed'], ['ARCHIVED', 'Archived']];

const securityBadges = (c) => h`${levelBadge(c.securityLevel)} ${(c.compartments ?? []).map((x) => badge(x, 'badge--compartment'))}
  ${c.isSealed ? badge('Sealed', 'badge--sealed') : ''} ${c.requiresExplicitAccess ? badge('Explicit access') : ''}`;

// ---------------------------------------------------------------- Liste
export async function listView({ query }) {
  const f = { q: query.q ?? '', type: query.type ?? '', status: query.status ?? '', mine: query.mine ?? '', limit: 25, offset: Number(query.offset ?? 0) };
  const [data, types] = await Promise.all([api.get(`/api/cases${qs(f)}`), api.get('/api/case-types')]);
  return {
    title: 'Cases',
    html: h`
      <div class="page-head"><div class="page-head__title"><h1>Cases</h1><p>All cases available to you. Access is checked for each case.</p></div>
        ${types.length ? h`<div class="page-head__actions"><a class="btn btn--primary" href="/app/cases/new">New case</a></div>` : ''}</div>
      <div class="card"><div class="card__body">
        <form class="row" data-filter>
          <div class="field"><label for="f-q">Search</label><input id="f-q" type="search" name="q" value="${f.q}" placeholder="Number or title"></div>
          <div class="field"><label for="f-status">Status</label><select id="f-status" name="status">
            ${STATUSES.map(([v, l]) => h`<option value="${v}" ${v === f.status ? raw('selected') : ''}>${l}</option>`)}</select></div>
          <div class="field"><label class="checkbox"><input type="checkbox" name="mine" value="1" ${f.mine === '1' ? raw('checked') : ''}> Only cases I participate in</label></div>
          <div class="field"><button class="btn" type="submit">Apply</button></div>
        </form>
      </div>
      ${table([
        { label: 'Case', render: (c) => h`<a href="/app/cases/${c.id}">${c.caseNumber}</a> ${demoBadge(c.isDemo)}` },
        { label: 'Title', key: 'title' },
        { label: 'Type', render: (c) => c.type.name },
        { label: 'Office', render: (c) => c.owningOrg?.shortName },
        { label: 'Status', render: (c) => statusBadge(c.status) },
        { label: 'Security', render: (c) => h`${levelBadge(c.securityLevel)} ${c.isSealed ? badge('Sealed', 'badge--sealed') : ''}` },
        { label: 'Updated', render: (c) => fmtDate(c.updatedAt) },
      ], data.items, 'No cases match your filters.')}
      ${pagination({ total: data.total, limit: f.limit, offset: f.offset, baseQuery: { ...f, offset: undefined, limit: undefined }, path: '/app/cases' })}
      </div>`,
    mount(el) {
      el.querySelector('[data-filter]').addEventListener('submit', (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        navigate(`/app/cases${qs({ q: fd.get('q'), status: fd.get('status'), mine: fd.get('mine') ? '1' : '' })}`);
      });
    },
  };
}

// ---------------------------------------------------------------- Anlage
export async function createView() {
  const [types, profiles] = await Promise.all([api.get('/api/case-types'), api.get('/api/security-profiles')]);
  if (!types.length) {
    return { title: 'New case', html: h`<h1>New case</h1><div class="notice notice--info">You are not permitted to create cases.</div>` };
  }
  const enabled = types.filter((t) => t.enabled);
  const typeOptions = types.map((t) => ({ value: t.code, label: `${t.name}${t.enabled ? '' : ' – disabled (legal basis not verified)'}` }));
  return {
    title: 'New case',
    html: h`
      <div class="page-head"><div class="page-head__title"><h1>New case</h1><p>The case number is assigned automatically.</p></div></div>
      <div class="card"><div class="card__body">
        <form novalidate data-create>
          <div class="grid grid--2">
            ${field({ name: 'typeCode', label: 'Case type', required: true, options: typeOptions, value: enabled[0]?.code })}
            ${field({ name: 'orgId', label: 'Office', required: true, options: [], attrs: 'data-type="int"' })}
          </div>
          <div data-type-note></div>
          ${field({ name: 'title', label: 'Title', required: true, attrs: 'maxlength="200"' })}
          ${field({ name: 'summary', label: 'Summary', type: 'textarea', attrs: 'maxlength="10000"' })}
          ${field({ name: 'securityProfile', label: 'Security profile', options: [], hint: 'Defaults to the minimum required for the case type. You can only choose profiles you are cleared for.' })}
          <div class="form-error" role="alert"></div>
          <div class="form-actions"><a class="btn" href="/app/cases">Cancel</a><button class="btn btn--primary" type="submit">Create case</button></div>
        </form></div></div>`,
    mount(el) {
      const form = el.querySelector('[data-create]');
      const update = () => {
        const t = types.find((x) => x.code === form.elements.typeCode.value);
        form.elements.orgId.innerHTML = String(h`${t.orgs.map((o) => h`<option value="${o.id}">${o.name} (${o.numberPrefix})</option>`)}`);
        form.elements.securityProfile.innerHTML = String(h`${profiles.map((p) => h`<option value="${p.code}" ${p.code === t.defaultSecurityProfile ? raw('selected') : ''}>
          ${p.name} – ${titleCase(p.level)}${p.compartments.length ? ` [${p.compartments.join(', ')}]` : ''}</option>`)}`);
        el.querySelector('[data-type-note]').innerHTML = String(h`${!t.enabled ? h`<div class="notice notice--warn">This case type is disabled because its legal basis has not been verified.</div>`
          : t.legalStatus === 'NOT_VERIFIED' ? h`<p>${unverifiedBadge(t.legalStatus)}</p>` : ''}`);
        form.querySelector('[type=submit]').disabled = !t.enabled;
      };
      form.elements.typeCode.addEventListener('change', update);
      update();
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const c = await api.post('/api/cases', formData(form));
          toast(`Case ${c.caseNumber} created.`);
          navigate(`/app/cases/${c.id}`);
        } catch (err) {
          if (!showFieldErrors(form, err)) form.querySelector('.form-error').innerHTML = String(h`<div class="notice notice--error">${err.message}</div>`);
        }
      });
    },
  };
}

// ---------------------------------------------------------------- Detail
export async function detailView({ params, query }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(404, null);
  const c = await api.get(`/api/cases/${id}`);
  const tab = query.tab ?? 'overview';
  const timeline = tab === 'timeline' ? await api.get(`/api/cases/${id}/timeline`) : null;
  const docs = tab === 'documents' ? await api.get(`/api/documents${qs({ caseId: id, limit: 100 })}`) : null;
  const evidence = tab === 'evidence' ? await api.get(`/api/evidence${qs({ caseId: id, limit: 100 })}`) : null;
  const schedule = tab === 'schedule' ? await Promise.all([api.get(`/api/hearings${qs({ caseId: id })}`), api.get(`/api/deadlines${qs({ caseId: id, state: 'all' })}`)]) : null;
  const comm = tab === 'communication' ? await Promise.all([api.get(`/api/conversations${qs({ caseId: id })}`), api.get(`/api/requests${qs({ caseId: id, box: 'all' })}`)]) : null;
  let apps = null;
  if (tab === 'applications') {
    const [asSource, asCourt, opts] = await Promise.all([api.get(`/api/applications${qs({ sourceCaseId: id, limit: 100 })}`),
      api.get(`/api/applications${qs({ courtCaseId: id, limit: 100 })}`), api.get(`/api/application-options${qs({ caseId: id })}`)]);
    apps = { items: [...asSource.items, ...asCourt.items], canFile: opts.kinds.length > 0 };
  }
  const cap = c.capabilities;
  setContext({ caseNumber: c.caseNumber, level: c.securityLevel });

  const actions = [
    cap.edit && h`<button class="btn" data-act="edit">Edit</button>`,
    cap.assign && h`<button class="btn" data-act="participant">Add participant</button>`,
    cap.share && h`<button class="btn" data-act="share">Grant access</button>`,
    cap.link && h`<button class="btn" data-act="link">Link case</button>`,
    cap.seal && h`<button class="btn btn--danger" data-act="seal">Seal</button>`,
    cap.unseal && h`<button class="btn" data-act="unseal">Unseal</button>`,
    cap.security && h`<button class="btn" data-act="security">Security profile</button>`,
    cap.transfer && h`<button class="btn" data-act="transfer">Transfer</button>`,
    cap.close && h`<button class="btn" data-act="close">Close case</button>`,
    cap.reopen && h`<button class="btn" data-act="reopen">Reopen</button>`,
    cap.archive && h`<button class="btn" data-act="archive">Archive</button>`,
  ].filter(Boolean);

  const tabs = [['overview', 'Overview'], ['documents', 'Documents'], ['applications', 'Applications'], ['evidence', 'Evidence'], ['schedule', 'Schedule'], ['communication', 'Communication'], ['timeline', 'Timeline'], ...(c.access ? [['access', 'Access']] : [])];

  return {
    title: c.caseNumber,
    html: h`
      <div class="page-head">
        <div class="page-head__title">
          <p class="small muted">${c.type.name} · ${c.owningOrg?.name}</p>
          <h1>${c.caseNumber} – ${c.title}</h1>
          <div class="row">${statusBadge(c.status)} ${securityBadges(c)} ${demoBadge(c.isDemo)} ${unverifiedBadge(c.legalStatus)}</div>
        </div>
        ${actions.length ? h`<div class="page-head__actions">${actions}</div>` : ''}
      </div>
      ${c.isSealed ? h`<div class="notice notice--warn">This case is sealed. Only explicitly authorized users can see it; it does not appear for others in lists, search or links.</div>` : ''}
      <div class="tabs" role="tablist">${tabs.map(([k, l]) => h`<button role="tab" aria-selected="${k === tab}" data-tab="${k}">${l}</button>`)}</div>
      ${tab === 'overview' ? overview(c) : tab === 'documents' ? documentsTab(c, docs) : tab === 'applications' ? applicationsTab(apps) : tab === 'evidence' ? evidenceTab(c, evidence) : tab === 'schedule' ? scheduleTab(c, schedule) : tab === 'communication' ? communicationTab(c, comm) : tab === 'timeline' ? timelineTab(timeline) : accessTab(c)}`,
    mount(el) {
      el.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => navigate(`/app/cases/${id}${b.dataset.tab === 'overview' ? '' : `?tab=${b.dataset.tab}`}`, { replace: true })));
      bindDeadlineActions(el, () => navigate(location.pathname + location.search, { replace: true }));
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        runAction(b.dataset.act, c, b.dataset).then((changed) => { if (changed) navigate(location.pathname + location.search, { replace: true }); })
          .catch(showError);
      });
    },
  };
}

function overview(c) {
  return h`<div class="grid grid--2">
    <div class="card"><div class="card__head"><h2>Details</h2></div><div class="card__body">
      <dl class="fields">
        <dt>Case number</dt><dd class="mono">${c.caseNumber}</dd>
        <dt>Type</dt><dd>${c.type.name}</dd>
        <dt>Office</dt><dd>${c.owningOrg?.name}</dd>
        <dt>Security profile</dt><dd>${c.securityProfile}</dd>
        <dt>Created</dt><dd>${fmtDate(c.createdAt)}${c.createdBy ? ` by ${c.createdBy.name}` : ''}</dd>
        <dt>Last update</dt><dd>${fmtDate(c.updatedAt)}</dd>
        ${c.closedAt ? h`<dt>Closed</dt><dd>${fmtDate(c.closedAt)}</dd>` : ''}
      </dl>
      <h3 class="small muted">Summary</h3><p class="pre">${c.summary || '—'}</p>
    </div></div>
    <div class="card"><div class="card__head"><h2>Participants</h2></div>
      ${table([
        { label: 'Name', render: (p) => h`${p.user ? p.user.name : p.personId ? h`<a href="/app/persons/${p.personId}">${p.partyName}</a>` : p.partyName}${p.isPresiding ? h` ${badge('Presiding')}` : ''}${!p.user ? h` <span class="muted small">(external party)</span>` : ''}` },
        { label: 'Role', render: (p) => titleCase(p.role) },
        { label: 'Access', render: (p) => (p.user ? h`${p.grantsAccess ? 'Yes' : 'No'}${p.sealedAccess ? h` ${badge('Sealed', 'badge--sealed')}` : ''}` : '—') },
        { label: '', render: (p) => (c.capabilities.assign ? h`<button class="btn btn--small btn--danger" data-act="removeParticipant" data-id="${p.id}">Remove</button>` : '') },
      ], c.participants, 'No participants.')}
    </div>
  </div>
  <div class="card"><div class="card__head"><h2>Linked cases</h2></div>
    ${table([
      { label: 'Case', render: (l) => h`<a href="/app/cases/${l.case.id}">${l.case.caseNumber}</a>` },
      { label: 'Title', render: (l) => l.case.title },
      { label: 'Relation', render: (l) => `${LINK_TYPES[l.linkType] ?? l.linkType}${l.direction === 'INCOMING' ? ' (incoming)' : ''}` },
      { label: 'Status', render: (l) => statusBadge(l.case.status) },
      { label: '', render: (l) => (c.capabilities.link ? h`<button class="btn btn--small" data-act="unlink" data-id="${l.id}">Remove link</button>` : '') },
    ], c.links, 'No linked cases available to you.')}
  </div>`;
}

function documentsTab(c, docs) {
  return h`<div class="card"><div class="card__head"><h2>Documents</h2>
      ${c.capabilities.addDocument ? h`<button class="btn btn--primary btn--small" data-act="newDocument">New document</button>` : ''}</div>
    ${table(docColumns, docs.items, 'No documents in this case.')}</div>`;
}

function applicationsTab(apps) {
  return h`<div class="card"><div class="card__head"><h2>Court applications</h2>
      ${apps.canFile ? h`<button class="btn btn--primary btn--small" data-act="newApplication">New application</button>` : ''}</div>
    ${table(appColumns, apps.items, 'No applications for this case.')}</div>`;
}

function evidenceTab(c, evidence) {
  return h`<div class="card"><div class="card__head"><h2>Evidence</h2>
      ${c.capabilities.addDocument && can('EVIDENCE_CREATE') ? h`<button class="btn btn--primary btn--small" data-act="newEvidence">Register evidence</button>` : ''}</div>
    ${table(evidenceColumns, evidence.items, 'No evidence registered in this case.')}</div>`;
}

function scheduleTab(c, [hearings, deadlines]) {
  const court = ['COURT', 'AUTHORITY'].includes(c.owningOrg?.kind);
  const canPlan = c.capabilities.addDocument || c.capabilities.assign;
  return h`<div class="card"><div class="card__head"><h2>Hearings</h2>
      ${court && canPlan && can('HEARING_SCHEDULE') ? h`<button class="btn btn--primary btn--small" data-act="newHearing">Schedule hearing</button>` : ''}</div>
    ${table(hearingColumns, hearings.items, court ? 'No hearings scheduled.' : 'Hearings are scheduled by the court.')}</div>
  <div class="card"><div class="card__head"><h2>Deadlines</h2>
      ${canPlan && can('DEADLINE_MANAGE') ? h`<button class="btn btn--primary btn--small" data-act="newDeadline">Set deadline</button>` : ''}</div>
    ${table(deadlineColumns.filter((x) => x.label !== 'Case'), deadlines.items, 'No deadlines.')}</div>`;
}

function communicationTab(c, [conversations, requests]) {
  const working = c.capabilities.edit || c.capabilities.addDocument;
  return h`<div class="card"><div class="card__head"><h2>Case conversations</h2>
      ${can('MESSAGE_SEND') ? h`<button class="btn btn--primary btn--small" data-act="newConversation">New conversation</button>` : ''}</div>
    ${table(conversationColumns, conversations.items, 'No conversations about this case.')}</div>
  <div class="card"><div class="card__head"><h2>Official requests</h2>
      ${working && can('REQUEST_CREATE') ? h`<button class="btn btn--primary btn--small" data-act="newRequest">New request</button>` : ''}</div>
    ${table(requestColumns, requests.items, 'No official requests for this case.')}</div>`;
}

function timelineTab(events) {
  if (!events.length) return h`<div class="empty">No events.</div>`;
  return h`<div class="card"><div class="card__body"><ol class="timeline">${events.map((e) => h`<li>
    <div><strong>${e.summary || titleCase(e.type)}</strong></div>
    <div class="timeline__meta">${fmtDate(e.createdAt)}${e.actor ? ` · ${e.actor.name}` : ''} · ${titleCase(e.type)}</div></li>`)}</ol></div></div>`;
}

function accessTab(c) {
  return h`<div class="card"><div class="card__head"><h2>Access grants</h2></div>
    <div class="card__body"><p class="muted small">Participants with access are listed on the overview. Office visibility applies to all members of the owning office unless the case is sealed or requires explicit access.</p></div>
    ${table([
      { label: 'Granted to', render: (a) => h`${titleCase(a.subjectType)}: ${a.subject ?? a.subjectId}${a.isDefault ? h` ${badge('Office default')}` : ''}` },
      { label: 'Level', render: (a) => titleCase(a.level) },
      { label: 'Sealed content', render: (a) => (a.sealedAccess ? 'Yes' : 'No') },
      { label: 'Expires', render: (a) => (a.expiresAt ? fmtDate(a.expiresAt) : 'Never') },
      { label: 'Reason', key: 'reason' },
      { label: '', render: (a) => (c.capabilities.share ? h`<button class="btn btn--small btn--danger" data-act="revokeAccess" data-id="${a.id}">Revoke</button>` : '') },
    ], c.access, 'No access grants.')}
  </div>`;
}

// ---------------------------------------------------------------- Aktionen
async function runAction(act, c, data) {
  const base = `/api/cases/${c.id}`;
  switch (act) {
    case 'newDocument':
      await newDocumentDialog({ caseId: c.id });
      return false;
    case 'newApplication':
      await newApplicationDialog(c.id);
      return false;
    case 'newEvidence':
      await newEvidenceDialog(c.id);
      return false;
    case 'newConversation':
      await newCaseConversationDialog(c.id);
      return false;
    case 'newRequest':
      await newRequestDialog({ caseId: c.id });
      return false;
    case 'newHearing':
      await newHearingDialog(c.id);
      return false;
    case 'newDeadline':
      return newDeadlineDialog(c.id);
    case 'edit':
      return formDialog({
        title: 'Edit case',
        body: h`${field({ name: 'title', label: 'Title', value: c.title, required: true })}${field({ name: 'summary', label: 'Summary', type: 'textarea', value: c.summary })}`,
        onSubmit: (d) => api.patch(base, d),
      });
    case 'participant':
      return formDialog({
        title: 'Add participant', submitLabel: 'Add',
        body: h`<p class="muted small">Add a user of the platform, a person from the person file, or an external party by name.</p>
          ${userPickerMarkup('userId', 'User')}
          ${personPickerMarkup('personId', 'or person record', 'Links the case to the central person file.')}
          ${field({ name: 'partyName', label: 'or external party (name only)', hint: 'Leave empty when a user or person record is selected.' })}
          ${field({ name: 'role', label: 'Role', required: true, options: PARTICIPANT_ROLES.map((r) => ({ value: r, label: titleCase(r) })) })}
          ${field({ name: 'grantsAccess', label: 'User may access this case', type: 'checkbox', value: true })}
          ${field({ name: 'isPresiding', label: 'Presiding', type: 'checkbox' })}
          ${c.isSealed ? field({ name: 'sealedAccess', label: 'Grant access to this sealed case', type: 'checkbox' }) : ''}`,
        onOpen: (dlg) => { bindUserPicker(dlg, 'userId'); bindPersonPicker(dlg, 'personId'); },
        onSubmit: (d) => {
          const body = { role: d.role, grantsAccess: d.grantsAccess, isPresiding: d.isPresiding, sealedAccess: Boolean(d.sealedAccess) };
          if (d.userId) body.userId = d.userId; else if (d.personId) body.personId = d.personId; else if (d.partyName) body.partyName = d.partyName;
          return api.post(`${base}/participants`, body);
        },
      });
    case 'removeParticipant':
      return reasonDialog({ title: 'Remove participant', danger: true, submitLabel: 'Remove', onSubmit: (d) => api.post(`${base}/participants/${data.id}/remove`, d) });
    case 'share': {
      const orgs = await api.get('/api/orgs');
      return formDialog({
        title: 'Grant access', submitLabel: 'Grant',
        body: h`${field({ name: 'subjectType', label: 'Grant to', options: [{ value: 'USER', label: 'A user' }, { value: 'ORG', label: 'An office / organization' }] })}
          <div data-when="USER">${userPickerMarkup('subjectUser', 'User')}
            ${field({ name: 'level', label: 'Level', options: [{ value: 'VIEW', label: 'View' }, { value: 'EDIT', label: 'Edit' }, { value: 'MANAGE', label: 'Manage' }] })}</div>
          <div data-when="ORG" hidden>${field({ name: 'subjectOrg', label: 'Organization', options: orgs.filter((o) => o.kind !== 'PLATFORM').map((o) => ({ value: o.id, label: o.name })), attrs: 'data-type="int"' })}</div>
          ${field({ name: 'expiresAt', label: 'Expires', type: 'datetime-local', hint: 'Leave empty for permanent access.' })}
          ${field({ name: 'reason', label: 'Reason', type: 'textarea', required: true })}`,
        onOpen: (dlg) => {
          bindUserPicker(dlg, 'subjectUser');
          const sel = dlg.querySelector('[name=subjectType]');
          const sync = () => dlg.querySelectorAll('[data-when]').forEach((x) => { x.hidden = x.dataset.when !== sel.value; });
          sel.addEventListener('change', sync);
        },
        onSubmit: (d) => api.post(`${base}/access`, {
          subjectType: d.subjectType, subjectId: d.subjectType === 'USER' ? d.subjectUser : d.subjectOrg,
          level: d.subjectType === 'USER' ? d.level : 'VIEW', expiresAt: d.expiresAt, reason: d.reason,
        }),
      });
    }
    case 'revokeAccess':
      return reasonDialog({ title: 'Revoke access', danger: true, submitLabel: 'Revoke', onSubmit: (d) => api.post(`${base}/access/${data.id}/revoke`, d) });
    case 'link':
      return formDialog({
        title: 'Link case', submitLabel: 'Link',
        body: h`${field({ name: 'caseNumber', label: 'Case number', required: true, hint: 'Only cases available to you can be linked.' })}
          ${field({ name: 'linkType', label: 'Relation', options: Object.entries(LINK_TYPES).map(([value, label]) => ({ value, label })) })}`,
        onSubmit: async (d) => {
          const found = await api.get(`/api/cases${qs({ q: d.caseNumber, limit: 5 })}`);
          const target = found.items.find((x) => x.caseNumber.toLowerCase() === d.caseNumber.trim().toLowerCase());
          if (!target) throw Object.assign(new Error('No case with this number is available to you.'), { details: [] });
          return api.post(`${base}/links`, { toCaseId: target.id, linkType: d.linkType });
        },
      });
    case 'unlink':
      return api.del(`${base}/links/${data.id}`).then(() => true);
    case 'seal': {
      const users = c.participants.filter((p) => p.user && p.grantsAccess);
      return reasonDialog({
        title: 'Seal case', danger: true, submitLabel: 'Seal',
        text: 'After sealing, office colleagues and supervisors lose access. You keep access; select further participants who should keep it.',
        extra: h`${users.map((p) => field({ name: `keep_${p.user.id}`, label: `${p.user.name} (${titleCase(p.role)})`, type: 'checkbox' }))}`,
        onSubmit: (d) => api.post(`${base}/seal`, { reason: d.reason, keepUserIds: users.filter((p) => d[`keep_${p.user.id}`]).map((p) => p.user.id) }),
      });
    }
    case 'unseal':
      return reasonDialog({ title: 'Unseal case', submitLabel: 'Unseal', onSubmit: (d) => api.post(`${base}/unseal`, d) });
    case 'security': {
      const profiles = await api.get('/api/security-profiles');
      return formDialog({
        title: 'Security profile',
        body: h`${field({ name: 'profile', label: 'Profile', value: c.securityProfile, options: profiles.map((p) => ({ value: p.code, label: `${p.name} – ${titleCase(p.level)}${p.compartments.length ? ` [${p.compartments.join(', ')}]` : ''}` })) })}
          ${field({ name: 'reason', label: 'Reason', type: 'textarea', required: true })}`,
        onSubmit: (d) => api.put(`${base}/security`, d),
      });
    }
    case 'transfer':
      return formDialog({
        title: 'Transfer case', submitLabel: 'Transfer',
        body: h`${field({ name: 'orgId', label: 'Transfer to', options: (c.transferTargets ?? []).map((o) => ({ value: o.id, label: o.name })), attrs: 'data-type="int"' })}
          <p class="muted small">Office visibility moves to the new office. Participants keep their access.</p>
          ${field({ name: 'reason', label: 'Reason', type: 'textarea', required: true })}`,
        onSubmit: async (d) => {
          const res = await api.post(`${base}/transfer`, d);
          if (res.transferred) { toast('Case transferred. It is no longer available to you.'); navigate('/app/cases'); return false; }
          return res;
        },
      });
    case 'close': case 'reopen': case 'archive':
      return reasonDialog({ title: `${titleCase(act)} case`, submitLabel: titleCase(act), onSubmit: (d) => api.post(`${base}/${act}`, d) });
    default:
      return false;
  }
}
