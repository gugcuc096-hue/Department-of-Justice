/**
 * Vertretung / Delegation (prompt.txt 5.8): beantragen, genehmigen, widerrufen.
 */
import { api } from '../api.js';
import { h, fmtDate, titleCase } from '../html.js';
import { state } from '../state.js';
import { table, statusBadge, formDialog, reasonDialog, field, userPickerMarkup, bindUserPicker, showError, toast } from '../ui.js';
import { navigate } from '../router.js';

const NON_DELEGABLE = new Set(['CLEARANCE_ASSIGN', 'COMPARTMENT_ASSIGN', 'ROLE_ASSIGN', 'PERMISSION_ASSIGN', 'DELEGATION_APPROVE',
  'ROLE_MANAGE', 'ORG_MANAGE', 'FEATURE_TOGGLE', 'CONFIG_MANAGE']);

export async function view() {
  const data = await api.get('/api/delegations');
  const me = state.me;
  const cols = (actions) => [
    { label: 'From', render: (d) => d.fromUser.name },
    { label: 'To', render: (d) => d.toUser.name },
    { label: 'Permission', render: (d) => h`<span class="mono">${d.permission}</span>${d.caseId ? h` <a href="/app/cases/${d.caseId}">(single case)</a>` : ''}` },
    { label: 'Period', render: (d) => `${fmtDate(d.startsAt)} – ${fmtDate(d.endsAt)}` },
    { label: 'Status', render: (d) => statusBadge(d.status === 'ACTIVE' && Date.parse(d.endsAt) < Date.now() ? 'EXPIRED' : d.status) },
    { label: 'Reason', key: 'reason' },
    { label: '', render: actions },
  ];
  return {
    title: 'Delegations',
    html: h`
      <div class="page-head"><div class="page-head__title"><h1>Delegations</h1>
        <p>Temporarily delegate one of your permissions. A third person must approve it; it ends automatically.</p></div>
        <div class="page-head__actions"><button class="btn btn--primary" data-new>Request delegation</button></div></div>
      ${data.toApprove.length ? h`<div class="card"><div class="card__head"><h2>Awaiting your approval</h2></div>
        ${table(cols((d) => h`<button class="btn btn--small btn--primary" data-approve="${d.id}">Approve</button> <button class="btn btn--small btn--danger" data-reject="${d.id}">Reject</button>`), data.toApprove)}</div>` : ''}
      <div class="card"><div class="card__head"><h2>Delegations involving me</h2></div>
        ${table(cols((d) => (['PENDING', 'ACTIVE'].includes(d.status) ? h`<button class="btn btn--small" data-revoke="${d.id}">Revoke</button>` : '')), data.mine, 'No delegations.')}</div>`,
    mount(el) {
      const refresh = () => navigate('/app/delegations', { replace: true });
      el.querySelector('[data-new]').addEventListener('click', () => {
        const perms = me.permissions.filter((p) => !NON_DELEGABLE.has(p));
        const scopes = me.memberships.map((m) => ({ value: m.org.id, label: m.org.name }));
        const in1h = new Date(Date.now() + 3600_000);
        const local = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
        formDialog({
          title: 'Request delegation', submitLabel: 'Submit request',
          body: h`${userPickerMarkup('toUserId', 'Delegate to')}
            ${field({ name: 'permission', label: 'Permission', options: perms.map((p) => ({ value: p, label: p })) })}
            ${field({ name: 'scopeOrgId', label: 'Scope', options: scopes, attrs: 'data-type="int"', hint: 'The delegation only applies within this organization.' })}
            ${field({ name: 'startsAt', label: 'From', type: 'datetime-local', value: local(new Date()), required: true })}
            ${field({ name: 'endsAt', label: 'Until', type: 'datetime-local', value: local(in1h), required: true })}
            ${field({ name: 'reason', label: 'Reason', type: 'textarea', required: true })}`,
          onOpen: (dlg) => bindUserPicker(dlg, 'toUserId'),
          onSubmit: (d) => api.post('/api/delegations', d),
        }).then((r) => { if (r) { toast('Delegation requested.'); refresh(); } });
      });
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-approve],[data-reject],[data-revoke]');
        if (!b) return;
        const [kind, id] = b.dataset.approve ? ['approve', b.dataset.approve] : b.dataset.reject ? ['reject', b.dataset.reject] : ['revoke', b.dataset.revoke];
        reasonDialog({ title: `${titleCase(kind)} delegation`, submitLabel: titleCase(kind), danger: kind !== 'approve',
          onSubmit: (d) => api.post(`/api/delegations/${id}/${kind}`, d) })
          .then((r) => { if (r) refresh(); }).catch(showError);
      });
    },
  };
}
