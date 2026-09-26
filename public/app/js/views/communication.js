/**
 * Benachrichtigungen, Nachrichten und offizielle Anfragen.
 * Sichtbarkeit und Berechtigungen prüft der Server; das Frontend zeigt nur, was er liefert.
 */
import { api, qs } from '../api.js';
import { h, fmtDate, titleCase } from '../html.js';
import { navigate } from '../router.js';
import { state, can } from '../state.js';
import { table, badge, levelBadge, field, formDialog, reasonDialog, toast, showError, userPickerMarkup, bindUserPicker } from '../ui.js';

// ---------------------------------------------------------------- Benachrichtigungen
export async function notificationsView() {
  const data = await api.get('/api/notifications?limit=100');
  return {
    title: 'Notifications',
    html: h`<div class="page-head"><div class="page-head__title"><h1>Notifications</h1>
        <p>Only notifications about matters you are still authorized to see are shown.</p></div>
        ${data.items.some((n) => !n.read) ? h`<div class="page-head__actions"><button class="btn" data-all>Mark all as read</button></div>` : ''}</div>
      <div class="card">${data.items.length ? h`<ul class="note-list">${data.items.map((n) => h`<li class="${n.read ? '' : 'is-unread'}">
          <a href="${n.link || '#'}" data-note="${n.id}"><strong>${n.title}</strong></a>
          ${n.body ? h`<div class="small">${n.body}</div>` : ''}<div class="small muted">${fmtDate(n.createdAt)}</div></li>`)}</ul>`
        : h`<div class="empty">No notifications.</div>`}</div>`,
    mount(el) {
      el.querySelector('[data-all]')?.addEventListener('click', () => api.post('/api/notifications/read-all').then(() => {
        window.dispatchEvent(new Event('sjcs:counters'));
        navigate('/app/notifications', { replace: true });
      }).catch(showError));
      // Lesen markieren, bevor der Link öffnet (der Router übernimmt die Navigation)
      el.addEventListener('click', (e) => {
        const a = e.target.closest('[data-note]');
        if (a) api.post('/api/notifications/read', { ids: [Number(a.dataset.note)] }).then(() => window.dispatchEvent(new Event('sjcs:counters'))).catch(() => {});
      }, true);
    },
  };
}

// ---------------------------------------------------------------- Nachrichten
const convLabel = (c) => (c.kind === 'CASE' ? `Case ${c.case?.caseNumber ?? ''}` : c.kind === 'DEPARTMENT'
  ? (c.orgs ?? []).map((o) => o?.shortName).join(' ↔ ') : (c.members ?? []).filter((m) => m.id !== state.me.id).map((m) => m.name).join(', '));

export const conversationColumns = [
  { label: 'Subject', render: (c) => h`<a href="/app/messages/${c.id}">${c.subject}</a> ${c.unread ? badge(`${c.unread} new`, 'badge--unverified') : ''}` },
  { label: 'With', render: (c) => h`<span class="small">${titleCase(c.kind)}</span> · ${convLabel(c)}` },
  { label: 'Last message', render: (c) => (c.lastMessage ? h`<span class="small">${c.lastMessage.sender}: ${c.lastMessage.preview}</span>` : '—') },
  { label: 'Updated', render: (c) => fmtDate(c.updatedAt) },
];

export async function messagesView() {
  const data = await api.get('/api/conversations');
  const deptOrgs = state.me.memberships.map((m) => m.org);
  return {
    title: 'Messages',
    html: h`<div class="page-head"><div class="page-head__title"><h1>Messages</h1><p>Direct messages, case conversations and messages between organizations.</p></div>
        <div class="page-head__actions"><button class="btn btn--primary" data-new="DIRECT">New message</button>
          ${can('MESSAGE_DEPARTMENT') ? h`<button class="btn" data-new="DEPARTMENT">Message to an organization</button>` : ''}</div></div>
      <div class="card">${table(conversationColumns, data.items, 'No conversations.')}</div>`,
    mount(el) {
      el.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-new]');
        if (!b) return;
        const orgs = b.dataset.new === 'DEPARTMENT' ? await api.get('/api/orgs') : [];
        formDialog({
          title: b.dataset.new === 'DIRECT' ? 'New message' : 'Message to an organization', submitLabel: 'Send',
          body: b.dataset.new === 'DIRECT' ? h`${userPickerMarkup('userId', 'To')}${field({ name: 'subject', label: 'Subject', required: true })}${field({ name: 'body', label: 'Message', type: 'textarea', required: true })}`
            : h`${field({ name: 'fromOrgId', label: 'On behalf of', attrs: 'data-type="int"', options: deptOrgs.map((o) => ({ value: o.id, label: o.name })) })}
              ${field({ name: 'toOrgId', label: 'To', attrs: 'data-type="int"', options: orgs.filter((o) => o.kind !== 'PLATFORM').map((o) => ({ value: o.id, label: o.name })) })}
              ${field({ name: 'subject', label: 'Subject', required: true })}${field({ name: 'body', label: 'Message', type: 'textarea', required: true })}`,
          onOpen: (dlg) => bindUserPicker(dlg, 'userId'),
          onSubmit: (d) => api.post('/api/conversations', b.dataset.new === 'DIRECT'
            ? { kind: 'DIRECT', userIds: d.userId ? [d.userId] : [], subject: d.subject, body: d.body }
            : { kind: 'DEPARTMENT', fromOrgId: d.fromOrgId, toOrgId: d.toOrgId, subject: d.subject, body: d.body }),
        }).then((r) => { if (r?.id) navigate(`/app/messages/${r.id}`); }).catch(showError);
      });
    },
  };
}

export async function conversationView({ params }) {
  const c = await api.get(`/api/conversations/${Number(params.id)}`);
  window.dispatchEvent(new Event('sjcs:counters'));
  return {
    title: c.subject,
    html: h`<div class="page-head"><div class="page-head__title"><p class="small muted">${titleCase(c.kind)} conversation · ${convLabel(c)}
        ${c.case ? h` · <a href="/app/cases/${c.case.id}">${c.case.caseNumber}</a>` : ''}</p><h1>${c.subject}</h1>
        <div class="row">${levelBadge(c.securityLevel)}</div></div></div>
      <div class="card"><div class="card__body"><ol class="thread">${c.messages.map((m) => h`<li class="${m.mine ? 'is-mine' : ''}">
          <div class="thread__meta"><strong>${m.sender.name}</strong>${m.onBehalfOf ? h` for ${m.onBehalfOf.name}` : ''} · ${fmtDate(m.at)}</div>
          <div class="pre">${m.body}</div></li>`)}</ol></div>
        ${c.canWrite ? h`<form class="card__body" data-reply>${field({ name: 'body', label: 'Reply', type: 'textarea', required: true })}
          <div class="form-actions"><button class="btn btn--primary" type="submit">Send</button></div></form>`
          : h`<div class="card__body muted small">You can read this conversation but not write on behalf of these organizations.</div>`}</div>`,
    mount(el) {
      el.querySelector('[data-reply]')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = e.target.elements.body.value.trim();
        if (!text) return;
        api.post(`/api/conversations/${c.id}/messages`, { body: text }).then(() => navigate(`/app/messages/${c.id}`, { replace: true })).catch(showError);
      });
    },
  };
}

/** Neue Akten-Unterhaltung (aus dem Akten-Tab). */
export function newCaseConversationDialog(caseId) {
  return formDialog({ title: 'New case conversation', submitLabel: 'Send',
    body: h`<p class="muted small">Everyone who can see this case can read the conversation.</p>
      ${field({ name: 'subject', label: 'Subject', required: true })}${field({ name: 'body', label: 'Message', type: 'textarea', required: true })}`,
    onSubmit: (d) => api.post('/api/conversations', { kind: 'CASE', caseId, subject: d.subject, body: d.body }),
  }).then((r) => { if (r?.id) navigate(`/app/messages/${r.id}`); });
}

// ---------------------------------------------------------------- Offizielle Anfragen
const REQ_STATUS = { OPEN: 'Open', ASSIGNED: 'Assigned', IN_PROGRESS: 'In progress', ANSWERED: 'Answered', DECLINED: 'Declined', CLOSED: 'Closed' };
const reqBadge = (s) => badge(REQ_STATUS[s] ?? s, ['ANSWERED', 'CLOSED'].includes(s) ? 'badge--status-CLOSED' : s === 'DECLINED' ? 'badge--sealed' : 'badge--status-ACTIVE');
const prioBadge = (p) => (p === 'URGENT' || p === 'HIGH' ? badge(titleCase(p), p === 'URGENT' ? 'badge--sealed' : 'badge--unverified') : badge(titleCase(p)));

export const requestColumns = [
  { label: 'Request', render: (r) => h`<a href="/app/requests/${r.id}">${r.requestNo}</a>` },
  { label: 'Subject', key: 'subject' },
  { label: 'From → To', render: (r) => `${r.sender?.shortName} → ${r.receiver?.shortName}` },
  { label: 'Priority', render: (r) => prioBadge(r.priority) },
  { label: 'Due', render: (r) => (r.dueAt ? fmtDate(r.dueAt) : '—') },
  { label: 'Status', render: (r) => reqBadge(r.status) },
];

export async function requestsView({ query }) {
  const box = query.box ?? 'inbox';
  const data = await api.get(`/api/requests${qs({ box, status: query.status })}`);
  return {
    title: 'Official requests',
    html: h`<div class="page-head"><div class="page-head__title"><h1>Official requests</h1><p>Requests between institutions.</p></div>
        <div class="page-head__actions">${can('REQUEST_CREATE') ? h`<button class="btn btn--primary" data-new>New request</button>` : ''}</div></div>
      <div class="tabs" role="tablist">${[['inbox', 'Received'], ['outbox', 'Sent'], ['all', 'All']].map(([k, l]) => h`<button role="tab" aria-selected="${k === box}" data-box="${k}">${l}</button>`)}</div>
      <div class="card">${table(requestColumns, data.items, 'No requests.')}</div>`,
    mount(el) {
      el.querySelectorAll('[data-box]').forEach((b) => b.addEventListener('click', () => navigate(`/app/requests?box=${b.dataset.box}`, { replace: true })));
      el.querySelector('[data-new]')?.addEventListener('click', () => newRequestDialog({}).catch(showError));
    },
  };
}

/** @param {{ caseId?: number }} context */
export async function newRequestDialog(context) {
  const orgs = await api.get('/api/orgs');
  const docs = context.caseId ? (await api.get(`/api/documents${qs({ caseId: context.caseId, limit: 100 })}`)).items : [];
  const mine = state.me.memberships.map((m) => m.org);
  const r = await formDialog({
    title: 'New official request', submitLabel: 'Send request',
    body: h`${field({ name: 'senderOrgId', label: 'From', attrs: 'data-type="int"', options: mine.map((o) => ({ value: o.id, label: o.name })) })}
      ${field({ name: 'receiverOrgId', label: 'To', attrs: 'data-type="int"', options: orgs.filter((o) => o.kind !== 'PLATFORM').map((o) => ({ value: o.id, label: o.name })) })}
      ${field({ name: 'subject', label: 'Subject', required: true })}
      ${field({ name: 'body', label: 'Request', type: 'textarea', required: true })}
      <div class="grid grid--2">${field({ name: 'priority', label: 'Priority', value: 'NORMAL', options: ['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((p) => ({ value: p, label: titleCase(p) })) })}
        ${field({ name: 'dueAt', label: 'Answer by', type: 'datetime-local' })}</div>
      ${docs.length ? h`<fieldset class="field"><legend class="small"><strong>Attach documents</strong> <span class="muted">(shared with the receiving organization only)</span></legend>
        ${docs.map((d) => h`<label class="checkbox"><input type="checkbox" name="doc_${d.id}"> ${d.docNumber} – ${d.title}</label>`)}</fieldset>` : ''}`,
    onSubmit: (d) => api.post('/api/requests', { senderOrgId: d.senderOrgId, receiverOrgId: d.receiverOrgId, subject: d.subject, body: d.body, priority: d.priority,
      dueAt: d.dueAt, caseId: context.caseId ?? null, documentIds: docs.filter((x) => d[`doc_${x.id}`]).map((x) => x.id) }),
  });
  if (r?.id) { toast(`Request ${r.requestNo} sent.`); navigate(`/app/requests/${r.id}`); }
  return r;
}

export async function requestView({ params }) {
  const r = await api.get(`/api/requests/${Number(params.id)}`);
  const cap = r.capabilities;
  const actions = [
    cap.assign && h`<button class="btn" data-act="assign">Assign</button>`,
    cap.start && h`<button class="btn" data-act="start">Start work</button>`,
    cap.respond && h`<button class="btn btn--primary" data-act="respond">Answer</button>`,
    cap.decline && h`<button class="btn btn--danger" data-act="decline">Decline</button>`,
    cap.close && h`<button class="btn" data-act="close">Close</button>`,
  ].filter(Boolean);
  return {
    title: r.requestNo,
    html: h`<div class="page-head"><div class="page-head__title"><p class="small muted">${r.sender?.name} → ${r.receiver?.name}</p>
        <h1>${r.requestNo} – ${r.subject}</h1><div class="row">${reqBadge(r.status)} ${prioBadge(r.priority)} ${levelBadge(r.securityLevel)}</div></div>
        ${actions.length ? h`<div class="page-head__actions">${actions}</div>` : ''}</div>
      <div class="grid grid--2">
        <div class="card"><div class="card__head"><h2>Request</h2></div><div class="card__body">
          <p class="pre">${r.body}</p><dl class="fields">
          <dt>Sent by</dt><dd>${r.createdBy} · ${fmtDate(r.createdAt)}</dd>
          <dt>Answer by</dt><dd>${r.dueAt ? fmtDate(r.dueAt) : '—'}</dd>
          <dt>Assigned to</dt><dd>${r.assignedTo?.name ?? '—'}</dd>
          ${r.case ? h`<dt>Case</dt><dd><a href="/app/cases/${r.case.id}">${r.case.caseNumber}</a></dd>` : ''}</dl></div></div>
        <div class="card"><div class="card__head"><h2>Answer</h2></div><div class="card__body">
          ${r.response ? h`<p class="pre">${r.response}</p><p class="small muted">${r.respondedBy} · ${fmtDate(r.respondedAt)}</p>` : h`<p class="muted">Not answered yet.</p>`}</div></div>
      </div>
      <div class="grid grid--2">
        <div class="card"><div class="card__head"><h2>Attached documents</h2></div>
          ${table([{ label: 'Document', render: (d) => h`<a href="/app/documents/${d.id}">${d.docNumber}</a>` }, { label: 'Title', key: 'title' }], r.documents, 'No documents.')}</div>
        <div class="card"><div class="card__head"><h2>History</h2></div><div class="card__body"><ol class="timeline">
          ${r.history.map((x) => h`<li><strong>${titleCase(x.type)}</strong>${x.comment ? h` – ${x.comment}` : ''}<div class="timeline__meta">${fmtDate(x.at)} · ${x.actor ?? 'System'}</div></li>`)}</ol></div></div>
      </div>`,
    mount(el) {
      el.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        const base = `/api/requests/${r.id}`;
        let p;
        switch (b.dataset.act) {
          case 'assign': {
            const people = await api.get(`${base}/assignees`);
            p = formDialog({ title: 'Assign request', submitLabel: 'Assign', body: field({ name: 'userId', label: 'Assign to', attrs: 'data-type="int"',
              options: people.map((x) => ({ value: x.id, label: x.name })) }), onSubmit: (d) => api.post(`${base}/assign`, d) });
            break;
          }
          case 'start': p = api.post(`${base}/start`).then(() => true); break;
          case 'respond':
            p = formDialog({ title: 'Answer request', submitLabel: 'Send answer', body: field({ name: 'response', label: 'Answer', type: 'textarea', required: true }),
              onSubmit: (d) => api.post(`${base}/respond`, d) });
            break;
          case 'decline': p = reasonDialog({ title: 'Decline request', danger: true, submitLabel: 'Decline', onSubmit: (d) => api.post(`${base}/decline`, d) }); break;
          case 'close': p = api.post(`${base}/close`).then(() => true); break;
          default: return;
        }
        p.then((ok) => { if (ok) navigate(`/app/requests/${r.id}`, { replace: true }); }).catch(showError);
      });
    },
  };
}
