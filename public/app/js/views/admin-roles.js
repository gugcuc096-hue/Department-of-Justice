/**
 * Rollen und ihre Permissions (PERMISSIONS.md 2–4). Änderungen wirken sofort für alle Inhaber der Rolle.
 */
import { api } from '../api.js';
import { h, raw } from '../html.js';
import { navigate } from '../router.js';
import { can } from '../state.js';
import { badge, formDialog, field, showError } from '../ui.js';

export async function view({ query }) {
  const [roles, permissions] = await Promise.all([api.get('/api/admin/roles'), api.get('/api/admin/permissions')]);
  const selected = roles.find((r) => r.code === query.role) ?? roles[0];
  const categories = [...new Set(permissions.map((p) => p.category))];
  const manage = can('ROLE_MANAGE');

  return {
    title: 'Roles & permissions',
    html: h`<div class="page-head"><div class="page-head__title"><h1>Roles & permissions</h1>
        <p>Roles bundle permissions. They take effect within the scope assigned to a user.</p></div>
        ${manage ? h`<div class="page-head__actions"><button class="btn btn--primary" data-new>New role</button></div>` : ''}</div>
      <div class="grid grid--2">
        <div class="card"><div class="card__head"><h2>Roles</h2></div><div class="card__body">
          <ul>${roles.map((r) => h`<li><a href="/app/admin/roles?role=${r.code}" ${r.code === selected.code ? raw('aria-current="true"') : ''}>${r.name}</a>
            ${r.isSystem ? badge('System') : ''} <span class="muted small">${r.permissions.length} permissions</span></li>`)}</ul></div></div>
        <div class="card"><div class="card__head"><h2>${selected.name}</h2></div><div class="card__body">
          <p class="muted">${selected.description || 'No description.'}</p>
          <form data-perms>
            ${categories.map((cat) => h`<div class="perm-group"><h3>${cat}</h3><div class="perm-grid">
              ${permissions.filter((p) => p.category === cat).map((p) => h`<label class="checkbox" title="${p.description}">
                <input type="checkbox" name="${p.code}" ${selected.permissions.includes(p.code) ? raw('checked') : ''} ${!manage ? raw('disabled') : ''}>
                <span class="mono small">${p.code}</span></label>`)}</div></div>`)}
            ${manage ? h`<div class="form-actions"><button class="btn btn--primary" type="submit">Save permissions…</button></div>` : ''}
          </form></div></div>
      </div>`,
    mount(el) {
      el.querySelector('[data-perms]').addEventListener('submit', (e) => {
        e.preventDefault();
        const chosen = [...e.target.querySelectorAll('input[type=checkbox]:checked')].map((i) => i.name);
        formDialog({ title: `Change permissions of ${selected.name}`, submitLabel: 'Save', danger: true,
          body: h`<p>The change applies immediately to every user holding this role.</p>${field({ name: 'reason', label: 'Reason', type: 'textarea', required: true })}`,
          onSubmit: (d) => api.put(`/api/admin/roles/${selected.id}/permissions`, { permissions: chosen, reason: d.reason }),
        }).then((r) => { if (r) navigate(`/app/admin/roles?role=${selected.code}`, { replace: true }); }).catch(showError);
      });
      el.querySelector('[data-new]')?.addEventListener('click', () => formDialog({
        title: 'New role', submitLabel: 'Create',
        body: h`${field({ name: 'name', label: 'Name', required: true })}${field({ name: 'code', label: 'Code', required: true, hint: 'Uppercase letters, digits and underscores.' })}
          ${field({ name: 'description', label: 'Description', type: 'textarea' })}`,
        onSubmit: (d) => api.post('/api/admin/roles', d).then(() => d.code),
      }).then((code) => { if (code) navigate(`/app/admin/roles?role=${code}`); }).catch(showError));
    },
  };
}
