/**
 * Organisationen und Ranghierarchien (prompt.txt 5.9). Nichts ist hartcodiert – der Seed ist nur der Startbestand.
 */
import { api } from '../api.js';
import { h } from '../html.js';
import { navigate } from '../router.js';
import { can } from '../state.js';
import { badge, formDialog, field, showError } from '../ui.js';

const KINDS = ['INSTITUTION', 'OFFICE', 'COURT', 'DIVISION', 'AUTHORITY'];

export async function view() {
  const orgs = await api.get('/api/orgs');
  const children = (id) => orgs.filter((o) => o.parentId === id);
  const root = orgs.find((o) => o.parentId == null);
  const manage = can('ORG_MANAGE');
  const ranksAllowed = can('RANK_MANAGE');

  const node = (o) => h`<li class="tree__node">
    <div class="row"><strong>${o.name}</strong> <span class="muted small">${o.code} · ${o.kind.toLowerCase()}</span>
      ${!o.isActive ? badge('Inactive') : ''}
      <span class="spacer"></span>
      ${manage && o.kind !== 'PLATFORM' ? h`<button class="btn btn--small" data-edit="${o.id}">Edit</button>` : ''}
      ${manage ? h`<button class="btn btn--small" data-child="${o.id}">Add unit</button>` : ''}
      ${ranksAllowed && o.kind !== 'PLATFORM' ? h`<button class="btn btn--small" data-rank="${o.id}">Add rank</button>` : ''}
    </div>
    ${o.subtitle ? h`<div class="small muted">${o.subtitle}</div>` : ''}
    ${o.ranks.length ? h`<div class="small">Ranks (highest first): ${o.ranks.map((r, i) => h`${i ? ' › ' : ''}<button class="btn btn--ghost btn--small" data-rank-edit="${r.id}" data-org="${o.id}" ${!ranksAllowed ? 'disabled' : ''}>${r.name}${!r.isActive ? ' (inactive)' : ''}</button>`)}</div>`
      : o.kind !== 'PLATFORM' && o.kind !== 'INSTITUTION' ? h`<div class="small muted">No ranks defined.</div>` : ''}
    ${children(o.id).length ? h`<ul class="tree">${children(o.id).map(node)}</ul>` : ''}
  </li>`;

  return {
    title: 'Organizations & ranks',
    html: h`<div class="page-head"><div class="page-head__title"><h1>Organizations & ranks</h1>
      <p>Organization tree and rank hierarchies. Ranks describe hierarchy only – they never grant permissions.</p></div></div>
      <div class="card"><div class="card__body"><ul class="tree">${node(root)}</ul></div></div>`,
    mount(el) {
      const refresh = () => navigate('/app/admin/organizations', { replace: true });
      el.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        let p = null;
        if (b.dataset.edit) {
          const o = orgs.find((x) => x.id === Number(b.dataset.edit));
          p = formDialog({ title: `Edit ${o.name}`, body: h`${field({ name: 'name', label: 'Name', value: o.name, required: true })}
            ${field({ name: 'shortName', label: 'Short name', value: o.shortName, required: true })}
            ${field({ name: 'subtitle', label: 'Subtitle', value: o.subtitle })}
            ${field({ name: 'isActive', label: 'Active', type: 'checkbox', value: o.isActive })}`,
          onSubmit: (d) => api.patch(`/api/admin/orgs/${o.id}`, d) });
        } else if (b.dataset.child) {
          p = formDialog({ title: 'Add organizational unit', submitLabel: 'Create',
            body: h`${field({ name: 'name', label: 'Name', required: true })}${field({ name: 'shortName', label: 'Short name', required: true })}
              ${field({ name: 'code', label: 'Code', required: true, hint: 'Uppercase letters, digits and underscores; cannot be changed later.' })}
              ${field({ name: 'kind', label: 'Kind', options: KINDS.map((k) => ({ value: k, label: k.toLowerCase() })) })}
              ${field({ name: 'subtitle', label: 'Subtitle' })}`,
            onSubmit: (d) => api.post('/api/admin/orgs', { ...d, parentId: Number(b.dataset.child) }) });
        } else if (b.dataset.rank) {
          p = formDialog({ title: 'Add rank', submitLabel: 'Create',
            body: h`${field({ name: 'name', label: 'Name', required: true })}
              ${field({ name: 'code', label: 'Code', required: true, hint: 'Uppercase letters, digits and underscores.' })}
              ${field({ name: 'level', label: 'Level', type: 'number', required: true, hint: 'Higher number = higher rank.' })}`,
            onSubmit: (d) => api.post(`/api/admin/orgs/${b.dataset.rank}/ranks`, d) });
        } else if (b.dataset.rankEdit) {
          const r = orgs.find((x) => x.id === Number(b.dataset.org)).ranks.find((x) => x.id === Number(b.dataset.rankEdit));
          p = formDialog({ title: `Edit rank ${r.name}`, body: h`${field({ name: 'name', label: 'Name', value: r.name, required: true })}
            ${field({ name: 'level', label: 'Level', type: 'number', value: r.level, required: true })}
            ${field({ name: 'isActive', label: 'Active', type: 'checkbox', value: r.isActive })}`,
          onSubmit: (d) => api.patch(`/api/admin/ranks/${r.id}`, d) });
        }
        p?.then((r) => { if (r) refresh(); }).catch(showError);
      });
    },
  };
}
