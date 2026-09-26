/**
 * Administration: Benutzer, Mitgliedschaften, Rollen, Permissions, Clearance, Compartments.
 * Welche Organisationen und Rechte vergeben werden dürfen, entscheidet der Server (Vergaberegeln, PERMISSIONS.md 3).
 */
import { api, qs } from '../api.js';
import { h, fmtDate, titleCase } from '../html.js';
import { navigate } from '../router.js';
import { can, state } from '../state.js';
import {
  table, pagination, badge, statusBadge, levelBadge, demoBadge, formDialog, reasonDialog, secretDialog, field, showError,
} from '../ui.js';

const orgOptions = (orgs, withGlobal = false) => [
  ...(withGlobal ? [{ value: '', label: 'Global (all organizations)' }] : []),
  ...orgs.filter((o) => o.kind !== 'PLATFORM').map((o) => ({ value: o.id, label: `${'— '.repeat(depth(orgs, o))}${o.name}` })),
];
function depth(orgs, o) {
  let d = 0;
  for (let p = o.parentId; p; p = orgs.find((x) => x.id === p)?.parentId) d++;
  return Math.max(0, d - 1);
}

// ---------------------------------------------------------------- Liste
export async function listView({ query }) {
  const f = { q: query.q ?? '', orgId: query.orgId ?? '', status: query.status ?? '', limit: 50, offset: Number(query.offset ?? 0) };
  const [data, orgs] = await Promise.all([api.get(`/api/admin/users${qs(f)}`), api.get('/api/orgs')]);
  return {
    title: 'Users',
    html: h`
      <div class="page-head"><div class="page-head__title"><h1>Users</h1><p>Users within your administrative scope.</p></div>
        ${can('USER_CREATE') ? h`<div class="page-head__actions"><button class="btn btn--primary" data-new>New user</button></div>` : ''}</div>
      <div class="card"><div class="card__body"><form class="row" data-filter>
        <div class="field"><label for="u-q">Search</label><input id="u-q" type="search" name="q" value="${f.q}" placeholder="Name, username or badge"></div>
        ${field({ name: 'orgId', label: 'Organization', value: f.orgId, plain: true, options: [{ value: '', label: 'All' }, ...orgOptions(orgs)] })}
        ${field({ name: 'status', label: 'Status', value: f.status, plain: true, options: [{ value: '', label: 'All' }, { value: 'ACTIVE', label: 'Active' }, { value: 'DISABLED', label: 'Disabled' }] })}
        <div class="field"><button class="btn" type="submit">Apply</button></div></form></div>
      ${table([
        { label: 'Name', render: (u) => h`<a href="/app/admin/users/${u.id}">${u.displayName}</a> ${demoBadge(u.isDemo)}` },
        { label: 'Username', render: (u) => h`<span class="mono">${u.username}</span>` },
        { label: 'Organizations', render: (u) => u.memberships.map((m) => `${m.org?.shortName}${m.rank ? ` (${m.rank})` : ''}`).join(', ') || '—' },
        { label: 'Clearance', render: (u) => levelBadge(u.clearance) },
        { label: 'Status', render: (u) => statusBadge(u.status) },
        { label: 'Last sign-in', render: (u) => fmtDate(u.lastLoginAt) },
      ], data.items, 'No users found.')}
      ${pagination({ total: data.total, limit: f.limit, offset: f.offset, baseQuery: { q: f.q, orgId: f.orgId, status: f.status }, path: '/app/admin/users' })}
      </div>`,
    mount(el) {
      el.querySelector('[data-filter]').addEventListener('submit', (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        navigate(`/app/admin/users${qs({ q: fd.get('q'), orgId: fd.get('orgId'), status: fd.get('status') })}`);
      });
      el.querySelector('[data-new]')?.addEventListener('click', async () => {
        const result = await formDialog({
          title: 'New user', submitLabel: 'Create user',
          body: h`${field({ name: 'displayName', label: 'Full name', required: true })}
            ${field({ name: 'username', label: 'Username', required: true, hint: 'Letters, digits, dot, underscore, hyphen.', attrs: 'autocapitalize="off"' })}
            ${field({ name: 'badgeNo', label: 'Badge / ID' })}
            ${field({ name: 'orgId', label: 'Organization', required: true, options: orgOptions(orgs), attrs: 'data-type="int"' })}
            ${field({ name: 'rankId', label: 'Rank', options: [{ value: '', label: 'No rank' }], attrs: 'data-type="int"' })}`,
          onOpen: (dlg) => {
            const org = dlg.querySelector('[name=orgId]');
            const sync = () => {
              const o = orgs.find((x) => x.id === Number(org.value));
              dlg.querySelector('[name=rankId]').innerHTML = String(h`<option value="">No rank</option>${(o?.ranks ?? []).filter((r) => r.isActive).map((r) => h`<option value="${r.id}">${r.name}</option>`)}`);
            };
            org.addEventListener('change', sync);
            sync();
          },
          onSubmit: (d) => api.post('/api/admin/users', d),
        });
        if (result?.user) {
          await secretDialog({ title: 'User created', text: `Temporary password for ${result.user.username}. The user must change it at first sign-in.`, secret: result.temporaryPassword });
          navigate(`/app/admin/users/${result.user.id}`);
        }
      });
    },
  };
}

// ---------------------------------------------------------------- Detail
export async function detailView({ params }) {
  const id = Number(params.id);
  const [u, orgs, roles, levels, compartments, permissions] = await Promise.all([
    api.get(`/api/admin/users/${id}`), api.get('/api/orgs'), api.get('/api/admin/roles'),
    api.get('/api/admin/security-levels'), api.get('/api/admin/compartments'), api.get('/api/admin/permissions'),
  ]);
  const self = u.id === state.me.id;
  const edit = u.canEdit;

  return {
    title: u.displayName,
    html: h`
      <div class="page-head"><div class="page-head__title"><p class="small muted"><a href="/app/admin/users">Users</a></p>
        <h1>${u.displayName}</h1><div class="row">${statusBadge(u.status)} ${levelBadge(u.clearance)} ${demoBadge(u.isDemo)}
          ${u.mustChangePassword ? badge('Password change pending') : ''} ${u.lockedUntil ? badge('Locked', 'badge--sealed') : ''}</div></div>
        ${!self && edit ? h`<div class="page-head__actions">
          <button class="btn" data-act="edit">Edit</button>
          <button class="btn" data-act="reset">Reset password</button>
          ${u.status === 'ACTIVE' ? h`<button class="btn btn--danger" data-act="disable">Disable</button>` : h`<button class="btn" data-act="enable">Enable</button>`}
        </div>` : ''}</div>
      ${self ? h`<div class="notice notice--info">This is your own account. You cannot change your own access rights.</div>` : ''}
      <div class="grid grid--2">
        <div class="card"><div class="card__head"><h2>Account</h2></div><div class="card__body"><dl class="fields">
          <dt>Username</dt><dd class="mono">${u.username}</dd>
          <dt>Badge / ID</dt><dd>${u.badgeNo || '—'}</dd>
          <dt>Contact</dt><dd>${u.contact || '—'}</dd>
          <dt>Created</dt><dd>${fmtDate(u.createdAt)}</dd>
          <dt>Last sign-in</dt><dd>${fmtDate(u.lastLoginAt)}</dd>
        </dl></div></div>
        <div class="card"><div class="card__head"><h2>Security</h2>
          ${!self ? h`<button class="btn btn--small" data-act="clearance">Set clearance</button><button class="btn btn--small" data-act="compartment">Grant compartment</button>` : ''}</div>
          <div class="card__body"><dl class="fields">
            <dt>Clearance</dt><dd>${levelBadge(u.clearance)}</dd>
            <dt>Compartments</dt><dd>${u.compartments.length ? u.compartments.map((c) => h`${badge(c.code, 'badge--compartment')}
              ${!self ? h`<button class="btn btn--small btn--ghost" data-act="revokeCompartment" data-code="${c.code}" aria-label="Revoke ${c.code}">✕</button>` : ''}`)
              : h`<span class="muted">None visible to you</span>`}</dd>
          </dl></div></div>
      </div>
      <div class="card"><div class="card__head"><h2>Memberships & ranks</h2>${!self ? h`<button class="btn btn--small" data-act="membership">Add membership</button>` : ''}</div>
        ${table([
          { label: 'Organization', render: (m) => m.org?.name },
          { label: 'Rank', render: (m) => m.rank ?? '—' },
          { label: 'Supervisor', render: (m) => m.supervisor?.name ?? '—' },
          { label: '', render: (m) => h`${m.isPrimary ? badge('Primary') : ''}` },
          { label: '', render: (m) => (!self ? h`<button class="btn btn--small" data-act="rank" data-id="${m.id}" data-org="${m.org?.id}">Change rank</button>
            <button class="btn btn--small btn--danger" data-act="removeMembership" data-id="${m.id}">Remove</button>` : '') },
        ], u.memberships, 'No memberships.')}</div>
      <div class="card"><div class="card__head"><h2>Roles</h2>${!self ? h`<button class="btn btn--small" data-act="role">Assign role</button>` : ''}</div>
        ${table([
          { label: 'Role', render: (r) => r.name },
          { label: 'Scope', render: (r) => r.scope?.name ?? 'Global' },
          { label: 'Reason', key: 'reason' },
          { label: 'Since', render: (r) => fmtDate(r.grantedAt, false) },
          { label: '', render: (r) => (!self ? h`<button class="btn btn--small btn--danger" data-act="revokeRole" data-id="${r.id}">Revoke</button>` : '') },
        ], u.roles, 'No roles assigned.')}</div>
      <div class="card"><div class="card__head"><h2>Individual permissions</h2>${!self && can('PERMISSION_ASSIGN') ? h`<button class="btn btn--small" data-act="permission">Grant permission</button>` : ''}</div>
        ${table([
          { label: 'Permission', render: (x) => h`<span class="mono">${x.code}</span>` },
          { label: 'Scope', render: (x) => x.scope?.name ?? 'Global' },
          { label: 'Expires', render: (x) => (x.expiresAt ? fmtDate(x.expiresAt) : 'Never') },
          { label: 'Reason', key: 'reason' },
          { label: '', render: (x) => (!self ? h`<button class="btn btn--small btn--danger" data-act="revokePermission" data-id="${x.id}">Revoke</button>` : '') },
        ], u.permissions, 'No individual permissions.')}</div>`,
    mount(el) {
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        act(b.dataset.act, b.dataset).then((changed) => { if (changed) navigate(`/app/admin/users/${id}`, { replace: true }); }).catch(showError);
      });
    },
  };

  async function act(action, data) {
    const base = `/api/admin/users/${id}`;
    const scopeOptions = orgOptions(orgs, can('ROLE_ASSIGN'));
    switch (action) {
      case 'edit':
        return formDialog({ title: 'Edit user', body: h`${field({ name: 'displayName', label: 'Full name', value: u.displayName, required: true })}
          ${field({ name: 'badgeNo', label: 'Badge / ID', value: u.badgeNo })}${field({ name: 'contact', label: 'Contact', value: u.contact })}`,
        onSubmit: (d) => api.patch(base, d) });
      case 'reset': {
        const ok = await formDialog({ title: 'Reset password', submitLabel: 'Reset', danger: true,
          body: h`<p>A new temporary password is generated. All sessions of this user are ended.</p>`,
          onSubmit: () => api.post(`${base}/reset-password`) });
        if (ok?.temporaryPassword) await secretDialog({ title: 'Temporary password', text: `New temporary password for ${u.username}:`, secret: ok.temporaryPassword });
        return Boolean(ok);
      }
      case 'disable': case 'enable':
        return reasonDialog({ title: `${titleCase(action)} user`, danger: action === 'disable', submitLabel: titleCase(action), onSubmit: (d) => api.post(`${base}/${action}`, d) });
      case 'clearance':
        return formDialog({ title: 'Set clearance', body: h`${field({ name: 'level', label: 'Clearance', value: u.clearance, options: levels.map((l) => ({ value: l.code, label: l.name })) })}
          ${field({ name: 'reason', label: 'Reason', type: 'textarea', required: true })}`,
        onSubmit: (d) => api.put(`${base}/clearance`, d) });
      case 'compartment':
        return formDialog({ title: 'Grant compartment', submitLabel: 'Grant',
          body: h`<p class="muted small">Only holders of a compartment can grant it. The user needs the corresponding access role first.</p>
            ${field({ name: 'code', label: 'Compartment', options: compartments.map((c) => ({ value: c.code, label: `${c.code} – ${c.name}` })) })}
            ${field({ name: 'expiresAt', label: 'Expires', type: 'datetime-local' })}
            ${field({ name: 'reason', label: 'Reason', type: 'textarea', required: true })}`,
          onSubmit: (d) => api.post(`${base}/compartments`, d) });
      case 'revokeCompartment':
        return reasonDialog({ title: `Revoke compartment ${data.code}`, danger: true, submitLabel: 'Revoke', onSubmit: (d) => api.post(`${base}/compartments/${data.code}/revoke`, d) });
      case 'membership':
        return formDialog({ title: 'Add membership', submitLabel: 'Add',
          body: h`${field({ name: 'orgId', label: 'Organization', options: orgOptions(orgs), attrs: 'data-type="int"' })}
            ${field({ name: 'rankId', label: 'Rank', options: [{ value: '', label: 'No rank' }], attrs: 'data-type="int"' })}
            ${field({ name: 'isPrimary', label: 'Primary organization', type: 'checkbox' })}`,
          onOpen: (dlg) => {
            const org = dlg.querySelector('[name=orgId]');
            const sync = () => {
              const o = orgs.find((x) => x.id === Number(org.value));
              dlg.querySelector('[name=rankId]').innerHTML = String(h`<option value="">No rank</option>${(o?.ranks ?? []).filter((r) => r.isActive).map((r) => h`<option value="${r.id}">${r.name}</option>`)}`);
            };
            org.addEventListener('change', sync); sync();
          },
          onSubmit: (d) => api.post(`${base}/memberships`, d) });
      case 'rank': {
        const o = orgs.find((x) => x.id === Number(data.org));
        return formDialog({ title: 'Change rank', body: field({ name: 'rankId', label: 'Rank', attrs: 'data-type="int"',
          options: [{ value: '', label: 'No rank' }, ...(o?.ranks ?? []).filter((r) => r.isActive).map((r) => ({ value: r.id, label: r.name }))] }),
        onSubmit: (d) => api.patch(`${base}/memberships/${data.id}`, { rankId: d.rankId }) });
      }
      case 'removeMembership':
        return formDialog({ title: 'Remove membership', danger: true, submitLabel: 'Remove', body: h`<p>Roles scoped to this organization remain assigned and must be revoked separately.</p>`,
          onSubmit: () => api.del(`${base}/memberships/${data.id}`) });
      case 'role':
        return formDialog({ title: 'Assign role', submitLabel: 'Assign',
          body: h`${field({ name: 'roleId', label: 'Role', options: roles.map((r) => ({ value: r.id, label: r.name })), attrs: 'data-type="int"' })}
            ${field({ name: 'scopeOrgId', label: 'Scope', options: scopeOptions, attrs: 'data-type="int"', hint: 'The role applies to this organization and its units. The user must be a member there.' })}
            ${field({ name: 'reason', label: 'Reason', type: 'textarea', required: true })}`,
          onSubmit: (d) => api.post(`${base}/roles`, { ...d, scopeOrgId: d.scopeOrgId || null }) });
      case 'revokeRole':
        return reasonDialog({ title: 'Revoke role', danger: true, submitLabel: 'Revoke', onSubmit: (d) => api.post(`${base}/roles/${data.id}/revoke`, d) });
      case 'permission':
        return formDialog({ title: 'Grant individual permission', submitLabel: 'Grant',
          body: h`<p class="muted small">You can only grant permissions you hold yourself in the chosen scope.</p>
            ${field({ name: 'code', label: 'Permission', options: permissions.map((p) => ({ value: p.code, label: `${p.code} – ${p.description}` })) })}
            ${field({ name: 'scopeOrgId', label: 'Scope', options: orgOptions(orgs, true), attrs: 'data-type="int"' })}
            ${field({ name: 'expiresAt', label: 'Expires', type: 'datetime-local' })}
            ${field({ name: 'reason', label: 'Reason', type: 'textarea', required: true })}`,
          onSubmit: (d) => api.post(`${base}/permissions`, { ...d, scopeOrgId: d.scopeOrgId || null }) });
      case 'revokePermission':
        return reasonDialog({ title: 'Revoke permission', danger: true, submitLabel: 'Revoke', onSubmit: (d) => api.post(`${base}/permissions/${data.id}/revoke`, d) });
      default:
        return false;
    }
  }
}

