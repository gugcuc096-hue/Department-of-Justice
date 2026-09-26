/**
 * Dashboard: ausschließlich echte, serverseitig gefilterte Daten.
 * Fachspezifische Dashboards (USMS, Prosecution, Judiciary …) folgen mit den jeweiligen Modulen.
 */
import { api } from '../api.js';
import { h, fmtDate } from '../html.js';
import { state, can } from '../state.js';
import { table, statusBadge, levelBadge, badge, demoBadge } from '../ui.js';
import { hearingColumns, deadlineColumns, bindDeadlineActions } from './schedule.js';
import { navigate } from '../router.js';

const caseColumns = [
  { label: 'Case', render: (c) => h`<a href="/app/cases/${c.id}">${c.caseNumber}</a> ${demoBadge(c.isDemo)}` },
  { label: 'Title', key: 'title' },
  { label: 'Type', render: (c) => c.type.name },
  { label: 'Status', render: (c) => statusBadge(c.status) },
  { label: 'Security', render: (c) => h`${levelBadge(c.securityLevel)} ${c.isSealed ? badge('Sealed', 'badge--sealed') : ''}` },
  { label: 'Updated', render: (c) => fmtDate(c.updatedAt) },
];

export async function view() {
  const me = state.me;
  const canCases = can('CASE_VIEW') || can('CASE_VIEW_ORG');
  const in14 = new Date(Date.now() + 14 * 86_400_000).toISOString();
  const [mine, open, delegations, hearings, deadlines] = await Promise.all([
    canCases ? api.get('/api/cases?mine=1&status=OPEN_OR_ACTIVE&limit=5') : null,
    canCases ? api.get('/api/cases?status=OPEN_OR_ACTIVE&limit=8') : null,
    api.get('/api/delegations'),
    canCases ? api.get(`/api/hearings?mine=1&status=SCHEDULED&from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(in14)}`) : { items: [] },
    canCases ? api.get('/api/deadlines?mine=1&state=open') : { items: [] },
  ]);
  const overdue = deadlines.items.filter((d) => d.state === 'OVERDUE').length;
  const adminLinks = state.nav.sections.find((s) => s.id === 'admin');

  return {
    title: 'Dashboard',
    mount(el) { bindDeadlineActions(el, () => navigate('/app/', { replace: true })); },
    html: h`
      <div class="page-head">
        <div class="page-head__title"><h1>Welcome, ${me.displayName}</h1>
          <p>${me.activeOrg ? me.activeOrg.name : 'You are not assigned to an organization yet.'}</p></div>
        ${can('CASE_CREATE') ? h`<div class="page-head__actions"><a class="btn btn--primary" href="/app/cases/new">New case</a></div>` : ''}
      </div>
      <div class="grid grid--stats">
        ${canCases ? h`
          <div class="card stat"><div class="stat__value">${mine.total}</div><div class="stat__label">My open cases</div></div>
          <div class="card stat"><div class="stat__value">${open.total}</div><div class="stat__label">Open cases available to me</div></div>` : ''}
        ${canCases ? h`<div class="card stat"><div class="stat__value">${deadlines.items.length}</div><div class="stat__label">My open deadlines${overdue ? h` · <strong class="badge badge--sealed">${overdue} overdue</strong>` : ''}</div></div>` : ''}
        <div class="card stat"><div class="stat__value">${delegations.toApprove.length}</div><div class="stat__label">Delegations awaiting my approval</div></div>
        <div class="card stat"><div class="stat__value">${delegations.mine.filter((d) => d.status === 'ACTIVE').length}</div><div class="stat__label">Active delegations involving me</div></div>
      </div>
      ${canCases && (hearings.items.length || deadlines.items.length) ? h`<div class="grid grid--2">
        <div class="card"><div class="card__head"><h2>My hearings (next 14 days)</h2><a class="btn btn--small" href="/app/calendar">Calendar</a></div>
          ${table(hearingColumns, hearings.items, 'No upcoming hearings.')}</div>
        <div class="card"><div class="card__head"><h2>My deadlines</h2></div>
          ${table(deadlineColumns.filter((c) => c.label !== 'Responsible'), deadlines.items.slice(0, 8), 'No open deadlines.')}</div></div>` : ''}
      ${canCases ? h`
        <div class="card"><div class="card__head"><h2>My open cases</h2><a class="btn btn--small" href="/app/cases?mine=1">All</a></div>
          ${table(caseColumns, mine.items, 'You are not participating in any open case.')}</div>
        <div class="card"><div class="card__head"><h2>Recently updated</h2><a class="btn btn--small" href="/app/cases">All cases</a></div>
          ${table(caseColumns, open.items, 'No open cases are available to you.')}</div>` : ''}
      ${adminLinks ? h`<div class="card"><div class="card__head"><h2>Administration</h2></div><div class="card__body row">
          ${adminLinks.items.map((i) => h`<a class="btn" href="${i.path}">${i.label}</a>`)}</div></div>` : ''}
      ${!canCases && !adminLinks ? h`<div class="notice notice--info">Your account has no roles yet. Please contact your administrator.</div>` : ''}`,
  };
}
