// Thin client for the same public API agents use.
const TOKEN_KEY = 'klang.token';
const NAME_KEY = 'klang.name';

const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
export const getToken = () => safe(() => localStorage.getItem(TOKEN_KEY), '') || '';
export const setToken = (t) => safe(() => localStorage.setItem(TOKEN_KEY, t));
export const getName = () => safe(() => localStorage.getItem(NAME_KEY), '') || '';
export const setName = (n) => safe(() => localStorage.setItem(NAME_KEY, n));
export const actor = () => `human:${getName() || 'you'}`;

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function req(method, path, body, { raw, headers = {} } = {}) {
  const h = { 'X-Actor': actor(), ...headers };
  const t = getToken();
  if (t) h.Authorization = `Bearer ${t}`;
  let payload = body;
  if (body !== undefined && !(body instanceof Blob) && !(body instanceof FormData) && !(body instanceof ArrayBuffer)) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers: h, body: payload });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new ApiError(res.status, j.error?.code || 'http_' + res.status, j.error?.message || res.statusText);
  }
  if (raw) return res;
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

export const api = {
  raw: (method, path, body) => req(method, path, body),
  projects: () => req('GET', '/api/projects'),
  createProject: (name, sampleRate) => req('POST', '/api/projects', { name, sampleRate }),
  deleteProject: (id) => req('DELETE', `/api/projects/${id}`),
  project: (id) => req('GET', `/api/projects/${id}`),
  ops: (id, ops, label) => req('POST', `/api/projects/${id}/ops`, { ops, label }),
  undo: (id) => req('POST', `/api/projects/${id}/undo`),
  redo: (id) => req('POST', `/api/projects/${id}/redo`),
  activity: (id) => req('GET', `/api/projects/${id}/activity?limit=100`),
  effects: () => req('GET', '/api/effects'),
  processes: () => req('GET', '/api/processes'),
  upload: (id, file, name) => req('POST', `/api/projects/${id}/assets?name=${encodeURIComponent(name || file.name)}`, file, { headers: { 'Content-Type': file.type || 'application/octet-stream' } }),
  importUrl: (id, url, name) => req('POST', `/api/projects/${id}/assets`, { url, name }),
  deleteAsset: (id, aid) => req('DELETE', `/api/projects/${id}/assets/${aid}`),
  process: (id, aid, kind, params, replaceInClips = true, range = {}) => req('POST', `/api/projects/${id}/assets/${aid}/process`, { kind, params, replaceInClips, ...range }),
  processPreview: (id, aid, body) => req('POST', `/api/projects/${id}/assets/${aid}/process-preview`, body, { raw: true }).then((r) => r.arrayBuffer()),
  analyze: (id, target, opts = {}) => req('POST', `/api/projects/${id}/analyze`, { target, ...opts }),
  render: (id, opts) => req('POST', `/api/projects/${id}/render`, opts),
  duck: (id, body) => req('POST', `/api/projects/${id}/duck`, body),
  proposals: (id) => req('GET', `/api/projects/${id}/proposals`),
  proposalPreview: (id, pr) => req('GET', `/api/projects/${id}/proposals/${pr}/preview`),
  decide: (id, pr, accept, force) => req('POST', `/api/projects/${id}/proposals/${pr}/${accept ? 'accept' : 'reject'}${force ? '?force=1' : ''}`),
  versions: (id) => req('GET', `/api/projects/${id}/versions`),
  saveVersion: (id, name) => req('POST', `/api/projects/${id}/versions`, { name }),
  restoreVersion: (id, vid) => req('POST', `/api/projects/${id}/versions/${vid}/restore`),
  check: (id, standard) => req('POST', `/api/projects/${id}/check`, { standard }),
  userPresets: () => req('GET', '/api/presets/user'),
  saveUserPreset: (id, trackId, name) => req('POST', '/api/presets/user', { projectId: id, ...(trackId ? { trackId } : {}), name }),
  applyUserPreset: (id, presetId, trackId) => req('POST', `/api/projects/${id}/presets/user/${presetId}/apply`, trackId ? { trackId } : {}),
  importArchive: (file) => req('POST', '/api/projects/import', file, { headers: { 'Content-Type': 'application/x-tar' } }),
  plugins: () => req('GET', '/api/plugins'),
  renders: (id) => req('GET', `/api/projects/${id}/renders`),
  audioUrl: (id, aid) => `/api/projects/${id}/assets/${aid}/audio?preview=1${getToken() ? `&token=${encodeURIComponent(getToken())}` : ''}`,
  audio: (id, aid) => req('GET', `/api/projects/${id}/assets/${aid}/audio?preview=1`, undefined, { raw: true }).then((r) => r.arrayBuffer()),
  peaks: async (id, aid) => {
    const r = await req('GET', `/api/projects/${id}/assets/${aid}/peaks`, undefined, { raw: true });
    return { block: +(r.headers.get('X-Peak-Block') || 256), data: new Int8Array(await r.arrayBuffer()) };
  },
  imageUrl: (id, q) => `/api/projects/${id}/image?${new URLSearchParams({ ...q, ...(getToken() ? { token: getToken() } : {}) })}`,
  fileUrl: (url) => (getToken() ? `${url}?token=${encodeURIComponent(getToken())}` : url),
};

export function connectLive(projectId, onMessage, onStatus) {
  let ws, closed = false, retry = 0;
  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = new URLSearchParams({ project: projectId, ...(getToken() ? { token: getToken() } : {}) });
    ws = new WebSocket(`${proto}://${location.host}/ws?${q}`);
    ws.onopen = () => { retry = 0; onStatus?.('live'); };
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    ws.onclose = () => {
      onStatus?.('offline');
      if (!closed) setTimeout(open, Math.min(8000, 500 * 2 ** retry++));
    };
  };
  open();
  return () => { closed = true; ws?.close(); };
}
