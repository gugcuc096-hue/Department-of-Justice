/**
 * Routen der SPA. Jede View liefert { title, html, mount? }.
 * Menüpunkte entstehen serverseitig (/api/me/navigation) – hier stehen nur die Seiten.
 */
import * as dashboard from './views/dashboard.js';
import * as cases from './views/cases.js';
import * as documents from './views/documents.js';
import * as applications from './views/applications.js';
import * as warrants from './views/warrants.js';
import * as evidence from './views/evidence.js';
import * as schedule from './views/schedule.js';
import * as comm from './views/communication.js';
import * as delegations from './views/delegations.js';
import * as profile from './views/profile.js';
import * as users from './views/admin-users.js';
import * as orgs from './views/admin-orgs.js';
import * as roles from './views/admin-roles.js';
import * as features from './views/admin-features.js';
import * as persons from './views/persons.js';
import { h } from './html.js';

export const routes = [
  { path: '/app', view: dashboard.view },
  { path: '/app/cases', view: cases.listView },
  { path: '/app/cases/new', view: cases.createView },
  { path: '/app/cases/:id', view: cases.detailView },
  { path: '/app/documents', view: documents.listView },
  { path: '/app/documents/:id', view: documents.detailView },
  { path: '/app/documents/:id/print', view: documents.printView },
  { path: '/app/applications', view: applications.listView },
  { path: '/app/applications/:id', view: applications.detailView },
  { path: '/app/warrants', view: warrants.listView },
  { path: '/app/warrants/:id', view: warrants.detailView },
  { path: '/app/evidence', view: evidence.listView },
  { path: '/app/evidence/:id', view: evidence.detailView },
  { path: '/app/calendar', view: schedule.calendarView },
  { path: '/app/hearings/:id', view: schedule.hearingView },
  { path: '/app/notifications', view: comm.notificationsView },
  { path: '/app/messages', view: comm.messagesView },
  { path: '/app/messages/:id', view: comm.conversationView },
  { path: '/app/requests', view: comm.requestsView },
  { path: '/app/requests/:id', view: comm.requestView },
  { path: '/app/search', view: persons.searchView },
  { path: '/app/persons', view: persons.listView },
  { path: '/app/persons/:id', view: persons.detailView },
  { path: '/app/companies', view: persons.companyListView },
  { path: '/app/companies/:id', view: persons.companyDetailView },
  { path: '/app/delegations', view: delegations.view },
  { path: '/app/profile', view: profile.view },
  { path: '/app/admin/users', view: users.listView },
  { path: '/app/admin/users/:id', view: users.detailView },
  { path: '/app/admin/organizations', view: orgs.view },
  { path: '/app/admin/roles', view: roles.view },
  { path: '/app/admin/features', view: features.view },
];

export const notFoundView = {
  title: 'Not found',
  view: async () => ({
    title: 'Not found',
    html: h`<div class="card"><div class="card__body">
      <h1>Page or record not found</h1>
      <p>The page does not exist, or the record is not available to you.</p>
      <a class="btn" href="/app/">Back to dashboard</a></div></div>`,
  }),
};
