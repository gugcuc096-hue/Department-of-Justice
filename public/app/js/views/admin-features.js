/**
 * Rechtsgrundlage & Funktionen (ADR-012, LEGAL_AUTHORITY_MATRIX.md).
 * Funktionen mit nicht verifizierter Rechtsgrundlage lassen sich hier sperren oder freischalten.
 */
import { api } from '../api.js';
import { h, fmtDate } from '../html.js';
import { navigate } from '../router.js';
import { state } from '../state.js';
import { table, badge, formDialog, field, showError } from '../ui.js';

export async function view() {
  const flags = await api.get('/api/feature-flags');
  return {
    title: 'Legal basis & features',
    html: h`<div class="page-head"><div class="page-head__title"><h1>Legal basis & features</h1>
      <p>The ModernV legal sources have not been provided yet. Functions marked "not verified" are available but flagged in the interface;
      disabled functions cannot be used until their legal basis is confirmed.</p></div></div>
      <div class="card">${table([
        { label: 'Function', render: (f) => h`<strong>${f.name}</strong><div class="small muted mono">${f.code}</div>` },
        { label: 'Status', render: (f) => (f.enabled ? badge('Enabled', 'badge--status-ACTIVE') : badge('Disabled', 'badge--status-DISABLED')) },
        { label: 'Legal basis', render: (f) => (f.legalStatus === 'VERIFIED' ? badge('Verified', 'badge--status-ACTIVE') : badge('Not verified', 'badge--unverified')) },
        { label: 'Note', key: 'note' },
        { label: 'Changed', render: (f) => fmtDate(f.updatedAt) },
        { label: '', render: (f) => h`<button class="btn btn--small" data-flag="${f.code}">Change</button>` },
      ], flags)}</div>`,
    mount(el) {
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-flag]');
        if (!b) return;
        const f = flags.find((x) => x.code === b.dataset.flag);
        formDialog({
          title: f.name,
          body: h`${field({ name: 'enabled', label: 'Function enabled', type: 'checkbox', value: f.enabled })}
            ${field({ name: 'legalStatus', label: 'Legal basis', value: f.legalStatus, options: [{ value: 'NOT_VERIFIED', label: 'Not verified' }, { value: 'VERIFIED', label: 'Verified (documented in the legal authority matrix)' }] })}
            ${field({ name: 'note', label: 'Note', type: 'textarea', value: f.note })}
            ${field({ name: 'reason', label: 'Reason', type: 'textarea', required: true })}`,
          onSubmit: (d) => api.put(`/api/admin/feature-flags/${f.code}`, d),
        }).then(async (r) => {
          if (r) { state.flags = await api.get('/api/feature-flags'); navigate('/app/admin/features', { replace: true }); }
        }).catch(showError);
      });
    },
  };
}
