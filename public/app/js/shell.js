/**
 * Anwendungsrahmen: Sidebar (serverseitige Navigation), Kopfzeile mit Suche, Department Switcher und
 * Benutzermenü, Kontextleiste (Institution · Office · Rang · Akte · Sicherheitsstufe; prompt.txt 9.3).
 */
import { h, raw } from './html.js';
import { api } from './api.js';
import { state } from './state.js';
import { showError, levelBadge } from './ui.js';

const brand = () => window.USMSBrand;

/** brand_code der aktiven Organisation, sonst der Institution, sonst Plattform. */
function activeBrand() {
  const org = state.me.activeOrg;
  if (!org) return 'SJCS';
  if (org.brandCode) return org.brandCode;
  return 'SJCS';
}

export function renderShell(root) {
  const me = state.me;
  const active = me.memberships.find((m) => m.org?.id === me.activeOrg?.id);
  root.innerHTML = String(h`
  <a class="skip-link" href="#view">Skip to content</a>
  <div class="shell">
    <aside class="sidebar" aria-label="Main navigation">
      <div class="sidebar__brand">${raw(brand().html.lockup('sidebar', { href: '/app/', institution: activeBrand() }))}</div>
      <nav>${state.nav.sections.map((s) => h`
        <div class="nav-section"><div class="nav-section__label">${s.label}</div>
          ${s.items.map((i) => i.disabled
            ? h`<span class="nav-link" aria-disabled="true" title="${i.hint ?? ''}">${i.label}</span>`
            : h`<a class="nav-link" href="${i.path}" data-nav="${i.path}">${i.label}</a>`)}
        </div>`)}
      </nav>
      <div class="sidebar__foot">${brand().config.rpNotice}</div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="btn btn--ghost topbar__menu" type="button" aria-label="Open navigation" data-menu>☰</button>
        <form class="topbar__search" role="search" data-search>
          <label class="visually-hidden" for="global-search">Search</label>
          <input id="global-search" type="search" name="q" placeholder="Search persons, cases, documents, companies …">
        </form>
        <div class="topbar__right">
          ${me.memberships.length > 1 ? h`
            <label class="visually-hidden" for="dept-switch">Active organization</label>
            <select id="dept-switch" data-switch>
              ${me.memberships.map((m) => h`<option value="${m.org.id}" ${m.org.id === me.activeOrg?.id ? raw('selected') : ''}>
                ${m.org.institution && m.org.institution.id !== m.org.id ? `${m.org.institution.name} · ` : ''}${m.org.shortName}</option>`)}
            </select>` : ''}
          <a class="btn btn--ghost counter-link" href="/app/messages" data-counter-link="messages" aria-label="Messages">Messages <span class="counter" data-counter="messages" hidden></span></a>
          <a class="btn btn--ghost counter-link" href="/app/notifications" data-counter-link="notifications" aria-label="Notifications">🔔 <span class="counter" data-counter="notifications" hidden></span></a>
          <a class="btn btn--ghost" href="/app/profile" title="Your profile">${me.displayName}</a>
          <button class="btn" type="button" data-logout>Sign out</button>
        </div>
      </header>
      <div class="context-bar" aria-label="Current context">
        <span><strong>${me.activeOrg?.institution?.name ?? me.activeOrg?.name ?? 'No organization'}</strong></span>
        ${me.activeOrg?.institution && me.activeOrg.institution.id !== me.activeOrg.id ? h`<span class="context-bar__sep">/</span><span>${me.activeOrg.name}</span>` : ''}
        ${active?.rank ? h`<span class="context-bar__sep">/</span><span>${active.rank}</span>` : ''}
        <span data-context-case></span>
        <span class="spacer"></span>
        <span>Clearance: ${levelBadge(me.clearance)}</span>
      </div>
      <main class="content" id="view" tabindex="-1"></main>
    </div>
  </div>`);

  root.querySelector('[data-logout]').addEventListener('click', () => window.dispatchEvent(new Event('sjcs:logout')));
  root.querySelector('[data-menu]').addEventListener('click', () => root.querySelector('.shell').classList.toggle('nav-open'));
  root.querySelector('[data-search]').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = e.target.elements.q.value.trim();
    window.dispatchEvent(new CustomEvent('sjcs:navigate', { detail: `/app/search${q ? `?q=${encodeURIComponent(q)}` : ''}` }));
  });
  root.querySelector('[data-switch]')?.addEventListener('change', async (e) => {
    try {
      state.me = await api.put('/api/me/active-org', { orgId: Number(e.target.value) });
      renderShell(root);
      window.dispatchEvent(new CustomEvent('sjcs:navigate', { detail: location.pathname + location.search }));
    } catch (err) { showError(err); }
  });
}

let counterTimer = null;
/** Zähler für ungelesene Benachrichtigungen/Nachrichten (alle 60 s und nach relevanten Aktionen). */
export async function refreshCounters() {
  try {
    const c = await api.get('/api/me/counters');
    for (const [k, v] of Object.entries(c)) {
      const el = document.querySelector(`[data-counter="${k}"]`);
      if (!el) continue;
      el.hidden = !v;
      el.textContent = v > 99 ? '99+' : String(v);
      el.closest('a')?.setAttribute('aria-label', `${k === 'messages' ? 'Messages' : 'Notifications'}${v ? `, ${v} unread` : ''}`);
    }
  } catch { /* Zähler sind Komfort – Fehler hier nicht anzeigen */ }
  clearTimeout(counterTimer);
  counterTimer = setTimeout(refreshCounters, 60_000);
}
window.addEventListener('sjcs:counters', () => refreshCounters());

export function setActiveNav(pathname) {
  let best = null;
  document.querySelectorAll('[data-nav]').forEach((a) => {
    a.removeAttribute('aria-current');
    const p = a.dataset.nav;
    const hit = p === '/app/' ? pathname === '/app/' || pathname === '/app' : pathname === p || pathname.startsWith(p + '/');
    if (hit && (!best || p.length > best.dataset.nav.length)) best = a;
  });
  best?.setAttribute('aria-current', 'page');
}

/** Aktuelle Akte und Sicherheitsstufe in der Kontextleiste anzeigen. */
export function setContext({ caseNumber, level } = {}) {
  const el = document.querySelector('[data-context-case]');
  if (!el) return;
  el.innerHTML = caseNumber ? String(h`<span class="context-bar__sep">/</span> Case <strong>${caseNumber}</strong> ${level ? levelBadge(level) : ''}`) : '';
}
