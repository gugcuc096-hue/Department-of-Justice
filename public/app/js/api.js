/**
 * API-Client: JSON, CSRF-Header, einheitliche Fehler.
 * Die Rechteprüfung passiert ausschließlich serverseitig; das Frontend reagiert nur auf die Antworten.
 */

let csrfToken = null;
let onUnauthorized = () => {};

export const setCsrf = (token) => { csrfToken = token; };
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code || 'ERROR';
    this.details = body?.error?.details;
    this.requestId = body?.requestId;
  }
  /** Feldfehler als { feld: meldung } */
  get fieldErrors() {
    const out = {};
    if (Array.isArray(this.details)) for (const d of this.details) if (d.field) out[d.field] = d.message;
    return out;
  }
}

async function request(method, path, body) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (csrfToken && method !== 'GET') headers['x-csrf-token'] = csrfToken;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, { error: { code: 'NETWORK', message: 'The server could not be reached. Check your connection and try again.' } });
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keine JSON-Antwort */ }
  if (!res.ok) {
    const err = new ApiError(res.status, json);
    if (res.status === 401 && !path.startsWith('/api/auth/')) onUnauthorized();
    throw err;
  }
  if (json?.csrfToken) csrfToken = json.csrfToken;
  return json;
}

/** Query-String aus Objekt (leere Werte werden weggelassen). */
export const qs = (params) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
};

export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  put: (p, b = {}) => request('PUT', p, b),
  patch: (p, b = {}) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),
};

/**
 * Datei hochladen (Rohdaten, erlaubte Typen: PDF, PNG, JPEG, WebP). Liefert { id, originalName, mime, size, sha256 }.
 * @param {File} file
 */
export async function uploadFile(file) {
  const res = await fetch('/api/files', {
    method: 'POST', body: file, credentials: 'same-origin',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name), 'x-csrf-token': csrfToken ?? '' },
  });
  let json = null;
  try { json = await res.json(); } catch { /* keine JSON-Antwort */ }
  if (!res.ok) {
    if (res.status === 415) throw new ApiError(415, { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Only PDF, PNG, JPEG and WebP files can be uploaded.' } });
    if (res.status === 413) throw new ApiError(413, { error: { code: 'TOO_LARGE', message: 'The file is larger than 10 MB.' } });
    throw new ApiError(res.status, json);
  }
  return json;
}
