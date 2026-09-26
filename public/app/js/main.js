/**
 * Einstieg der SPA: Session prüfen → Anmeldung / Passwortwechsel / Anwendung.
 */
import { api, setCsrf, setUnauthorizedHandler, ApiError } from './api.js';
import { h, raw } from './html.js';
import { field, showFieldErrors, clearFieldErrors, formData, showError } from './ui.js';
import { renderShell, setActiveNav, setContext, refreshCounters } from './shell.js';
import { setRoutes, interceptLinks, resolve, navigate } from './router.js';
import { routes, notFoundView } from './routes.js';
import { state } from './state.js';

const root = document.getElementById('root');
const brand = () => window.USMSBrand;

async function boot() {
  setUnauthorizedHandler(() => { location.href = '/app/'; });
  let session;
  try {
    session = await api.get('/api/auth/session');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return renderLogin();
    root.innerHTML = String(h`<div class="login"><div class="notice notice--error">${err.message}</div></div>`);
    return;
  }
  setCsrf(session.csrfToken);
  if (session.user.mustChangePassword) return renderPasswordChange(true);
  await startApp();
}

async function startApp() {
  const [me, nav, flags] = await Promise.all([api.get('/api/me'), api.get('/api/me/navigation'), api.get('/api/feature-flags')]);
  Object.assign(state, { me, nav, flags });
  renderShell(root);
  refreshCounters();
  setRoutes(routes, notFoundView, runView);
  interceptLinks(document);
  await resolve();
}

let navToken = 0;
async function runView(route, params, query, fallback) {
  const token = ++navToken;
  const view = document.getElementById('view');
  const def = route ?? fallback;
  setContext({});
  document.body.classList.remove('print-mode');
  // Dialoge gehören zur Seite: beim Seitenwechsel offene Dialoge abbrechen (löst deren Promise mit null auf)
  document.querySelectorAll('dialog[open]').forEach((d) => d.dispatchEvent(new Event('cancel')));
  setActiveNav(location.pathname);
  view.setAttribute('aria-busy', 'true');
  try {
    const out = await def.view({ params, query, state });
    if (token !== navToken) return; // inzwischen weiternavigiert
    view.innerHTML = String(out.html ?? out);
    document.title = `${out.title ?? def.title ?? 'Justice Command'} · SJCS`;
    out.mount?.(view);
  } catch (err) {
    if (token !== navToken) return;
    if (err instanceof ApiError && err.status === 404) {
      const nf = await notFoundView.view();
      view.innerHTML = String(nf.html);
      document.title = 'Not found · SJCS';
    } else if (err instanceof ApiError && err.status === 403) {
      view.innerHTML = String(h`<div class="card"><div class="card__body"><h1>Access denied</h1>
        <p>You are not permitted to open this page.</p><a class="btn" href="/app/">Back to dashboard</a></div></div>`);
    } else {
      view.innerHTML = String(h`<div class="notice notice--error">This page could not be loaded. ${err.message ?? ''}</div>`);
      showError(err);
    }
  } finally {
    view.removeAttribute('aria-busy');
    view.querySelector('h1')?.setAttribute('tabindex', '-1');
    if (token === navToken) view.querySelector('h1')?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
    document.querySelector('.shell')?.classList.remove('nav-open');
  }
}

// ---------------------------------------------------------------- Anmeldung
function renderLogin() {
  document.title = 'Sign in · San Andreas Justice Command System';
  root.innerHTML = String(h`<main class="login">
    <div class="login__panel">
      <div class="login__brand">${raw(brand().html.lockup('login', { institution: 'SJCS' }))}</div>
      <form class="login__form" novalidate>
        <h2>Sign in</h2>
        ${field({ name: 'username', label: 'Username', required: true, attrs: 'autocomplete="username" autocapitalize="off"' })}
        ${field({ name: 'password', label: 'Password', type: 'password', required: true, attrs: 'autocomplete="current-password"' })}
        <div class="form-error" role="alert"></div>
        <div class="form-actions"><button class="btn btn--primary" type="submit">Sign in</button></div>
      </form>
      <p class="login__notice">${brand().config.rpNotice}</p>
    </div></main>`);
  const form = root.querySelector('form');
  form.elements.username.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFieldErrors(form);
    const errBox = form.querySelector('.form-error');
    errBox.innerHTML = '';
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const res = await api.post('/api/auth/login', formData(form));
      setCsrf(res.csrfToken);
      if (res.user.mustChangePassword) renderPasswordChange(true);
      else { history.replaceState({}, '', location.pathname === '/app' || location.pathname === '/app/' ? '/app/' : location.pathname); await startApp(); }
    } catch (err) {
      errBox.innerHTML = String(h`<div class="notice notice--error">${err.message}</div>`);
      form.elements.password.value = '';
      form.elements.password.focus();
    } finally {
      btn.disabled = false;
    }
  });
}

export function renderPasswordChange(required) {
  document.title = 'Change password · SJCS';
  root.innerHTML = String(h`<main class="login"><div class="login__panel">
    <div class="login__brand">${raw(brand().html.lockup('login', { institution: 'SJCS' }))}</div>
    <form class="login__form" novalidate>
      <h2>Change your password</h2>
      ${required ? h`<p class="notice notice--info">You must set a new password before continuing.</p>` : ''}
      ${field({ name: 'currentPassword', label: 'Current password', type: 'password', required: true, attrs: 'autocomplete="current-password"' })}
      ${field({ name: 'newPassword', label: 'New password', type: 'password', required: true, attrs: 'autocomplete="new-password"',
        hint: 'At least 12 characters, letters and at least one number or symbol.' })}
      <div class="form-error" role="alert"></div>
      <div class="form-actions">
        <button class="btn" type="button" data-logout>Sign out</button>
        <button class="btn btn--primary" type="submit">Change password</button>
      </div>
    </form></div></main>`);
  const form = root.querySelector('form');
  form.elements.currentPassword.focus();
  form.querySelector('[data-logout]').addEventListener('click', logout);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.post('/api/auth/password', formData(form));
      await startApp();
    } catch (err) {
      if (!showFieldErrors(form, err)) form.querySelector('.form-error').innerHTML = String(h`<div class="notice notice--error">${err.message}</div>`);
    }
  });
}

export async function logout() {
  try { await api.post('/api/auth/logout'); } catch { /* Session ist ohnehin weg */ }
  location.href = '/app/';
}

window.addEventListener('sjcs:logout', logout);
window.addEventListener('sjcs:navigate', (e) => navigate(e.detail));
boot();
