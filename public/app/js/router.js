/**
 * Minimaler History-API-Router. Routen: [{ path: '/app/cases/:id', view: async (ctx) => {...} }]
 * Unbekannte Pfade zeigen die "Not found"-Seite – nie eine leere Seite.
 */

let routes = [];
let notFound = null;
let onNavigate = () => {};

const compile = (path) => {
  const keys = [];
  const re = new RegExp('^' + path.replace(/\/$/, '').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  return { re, keys };
};

export function setRoutes(list, notFoundView, navigateHook) {
  routes = list.map((r) => ({ ...r, ...compile(r.path) }));
  notFound = notFoundView;
  onNavigate = navigateHook;
}

export function match(pathname) {
  for (const r of routes) {
    const m = r.re.exec(pathname.replace(/\/$/, '') || '/');
    if (m) return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

export async function navigate(url, { replace = false } = {}) {
  const target = new URL(url, location.origin);
  if (replace) history.replaceState({}, '', target);
  else history.pushState({}, '', target);
  await resolve();
}

export async function resolve() {
  const found = match(location.pathname);
  const query = Object.fromEntries(new URLSearchParams(location.search));
  await onNavigate(found ? found.route : null, found ? found.params : {}, query, found ? null : notFound);
}

/** Interne Links (<a href="/app/..."> ohne target) ohne Neuladen öffnen. */
export function interceptLinks(root = document) {
  root.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || a.target || a.hasAttribute('download') || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    const href = a.getAttribute('href');
    if (!href.startsWith('/app')) return;
    e.preventDefault();
    navigate(href);
  });
  window.addEventListener('popstate', () => resolve());
}
