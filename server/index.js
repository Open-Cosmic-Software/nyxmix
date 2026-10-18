import './env.js'; // must stay first: maps NYXMIX_* env names before other modules read them
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import busboy from 'busboy';
import { Store } from './store.js';
import { createActions } from './actions.js';
import { createMcpHandler, INSTRUCTIONS } from './mcp.js';
import { describeOps, OpError } from './ops.js';
import { EFFECTS } from '../public/js/engine/graph.js';
import { PRESETS } from '../public/js/engine/presets.js';
import { PROCESSES, FORMATS, PEAK_BLOCK } from './audio.js';
import { openapi } from './openapi.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = +(process.env.PORT || 3950);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.KLANG_TOKEN || '';

const store = new Store(process.env.KLANG_DATA || path.join(root, 'data'));
await store.init();
const actions = createActions(store);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
const baseUrl = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Actor, X-Filename, Mcp-Session-Id, Mcp-Protocol-Version');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, X-Peak-Block');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

function tokenOk(given) {
  if (!TOKEN) return true;
  const a = Buffer.from(String(given || '')), b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}
const auth = (req, res, next) => {
  const given = (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.query.token;
  if (tokenOk(given)) return next();
  res.status(401).json({ error: { code: 'unauthorized', message: 'Send Authorization: Bearer <token>' } });
};
const actorOf = (req) => (req.get('x-actor') || 'agent:http').slice(0, 80);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── discovery ────────────────────────────────────────────────────────────
app.get('/openapi.json', (req, res) => res.json(openapi(baseUrl(req))));
app.get('/llms.txt', (req, res) => res.type('text/plain').send(llmsTxt(baseUrl(req))));
app.get('/api', (req, res) => res.json({
  name: 'NyxMix', description: 'Agent-first multitrack audio editor. Same API for humans (web UI) and agents.',
  auth: TOKEN ? 'Bearer token required' : 'open', openapi: '/openapi.json', mcp: '/mcp', llms: '/llms.txt', websocket: '/ws?project=<id>',
  endpoints: ['/api/ops', '/api/effects', '/api/processes', '/api/projects'],
}));
app.get('/api/ops', (req, res) => res.json(describeOps()));
app.get('/api/effects', (req, res) => res.json(EFFECTS));
app.get('/api/processes', (req, res) => res.json(PROCESSES));
app.get('/api/presets', (req, res) => res.json(PRESETS));
app.get('/api/formats', (req, res) => res.json(Object.keys(FORMATS)));

app.post('/mcp', auth, express.json({ limit: '300mb' }), (req, res, next) => mcpHandler(req, res, next));
let mcpHandler;
app.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Use POST (Streamable HTTP, JSON responses).' }));
app.delete('/mcp', (req, res) => res.status(204).end());

// ── projects ─────────────────────────────────────────────────────────────
const api = express.Router();
api.use(auth);
const json = express.json({ limit: '300mb' });

api.get('/projects', (req, res) => res.json(store.list()));
api.post('/projects', json, wrap(async (req, res) => {
  const sr = req.body?.sampleRate;
  if (sr !== undefined && ![44100, 48000, 88200, 96000].includes(sr)) throw new OpError('sampleRate must be 44100, 48000, 88200 or 96000', 'invalid_args', 400);
  res.status(201).json(await store.create({ name: req.body?.name, sampleRate: sr }, actorOf(req)));
}));
api.get('/projects/:id', (req, res) => res.json(store.get(req.params.id)));
api.delete('/projects/:id', wrap(async (req, res) => { await store.deleteProject(req.params.id); res.status(204).end(); }));
api.get('/projects/:id/summary', (req, res) => res.type('text/plain').send(actions.summary(req.params.id)));

api.post('/projects/:id/ops', json, (req, res) => {
  const b = req.body || {};
  const ops = b.ops || (b.op ? [{ op: b.op, args: b.args }] : null);
  res.json(store.apply(req.params.id, ops, { actor: actorOf(req), label: b.label, ifRev: b.ifRev }));
});
api.post('/projects/:id/ops/:op', json, (req, res) => {
  const r = store.apply(req.params.id, [{ op: req.params.op, args: req.body || {} }], { actor: actorOf(req), ifRev: req.query.ifRev !== undefined ? +req.query.ifRev : undefined });
  res.json({ rev: r.rev, ...r.results[0] });
});
api.post('/projects/:id/undo', (req, res) => res.json(store.undo(req.params.id, actorOf(req))));
api.post('/projects/:id/redo', (req, res) => res.json(store.redo(req.params.id, actorOf(req))));
api.get('/projects/:id/history', (req, res) => res.json(store.history(req.params.id)));
api.get('/projects/:id/activity', (req, res) => res.json(store.activity(req.params.id, Math.min(500, +req.query.limit || 50))));

// ── assets ───────────────────────────────────────────────────────────────
api.post('/projects/:id/assets', wrap(async (req, res) => {
  const pid = req.params.id; store.get(pid);
  const actor = actorOf(req);
  const ct = req.get('content-type') || '';
  if (ct.startsWith('multipart/form-data')) {
    const results = [];
    await new Promise((resolve, reject) => {
      const bb = busboy({ headers: req.headers, limits: { fileSize: 1024 ** 3 + 1, files: 20 } });
      const pending = [];
      bb.on('file', (_field, stream, info) => {
        const name = (info.filename || 'Audio').replace(/\.[a-z0-9]+$/i, '');
        // One byte over our own 1 GB cap, so importFromStream rejects instead of busboy silently truncating.
        pending.push(actions.importFromStream(pid, stream, { name, actor }).then((a) => results.push(a)).catch((e) => { stream.resume(); throw e; }));
      });
      bb.on('close', () => Promise.all(pending).then(resolve, reject));
      bb.on('error', reject);
      req.pipe(bb);
    });
    return res.status(201).json(results.length === 1 ? results[0] : results);
  }
  if (ct.startsWith('application/json')) {
    await new Promise((r, j) => json(req, res, (e) => (e ? j(e) : r())));
    const { url, base64, name } = req.body || {};
    if (url) return res.status(201).json(await actions.importFromUrl(pid, url, { name, actor }));
    if (base64) {
      const { Readable } = await import('node:stream');
      return res.status(201).json(await actions.importFromStream(pid, Readable.from([Buffer.from(base64, 'base64')]), { name: name || 'Audio', actor }));
    }
    throw new OpError('JSON body needs url or base64', 'invalid_args', 400);
  }
  const name = (req.query.name || req.get('x-filename') || 'Audio').toString().replace(/\.[a-z0-9]+$/i, '');
  res.status(201).json(await actions.importFromStream(pid, req, { name, actor }));
}));
// Only ids of assets in the bin: the id becomes part of a file path.
const assetParam = (req) => { if (!store.get(req.params.id).assets.some((a) => a.id === req.params.aid)) throw new OpError('Asset not found', 'not_found', 404); };
api.get('/projects/:id/assets/:aid/audio', (req, res, next) => {
  assetParam(req);
  // ?preview=1 → lossless 24-bit FLAC when available (smaller transfer for the browser).
  if (req.query.preview) {
    const flac = store.previewPath(req.params.id, req.params.aid);
    if (existsSync(flac)) return res.sendFile(flac, { headers: { 'Content-Type': 'audio/flac', 'Cache-Control': 'private, max-age=31536000, immutable' } });
  }
  res.sendFile(store.assetPath(req.params.id, req.params.aid), { headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'private, max-age=31536000, immutable' } }, (e) => e && next(new OpError('Asset not found', 'not_found', 404)));
});
api.get('/projects/:id/assets/:aid/peaks', (req, res, next) => {
  assetParam(req);
  res.sendFile(store.peaksPath(req.params.id, req.params.aid), { headers: { 'Content-Type': 'application/octet-stream', 'X-Peak-Block': String(PEAK_BLOCK), 'Cache-Control': 'private, max-age=31536000, immutable' } }, (e) => e && next(new OpError('Asset not found', 'not_found', 404)));
});
api.delete('/projects/:id/assets/:aid', wrap(async (req, res) => { await store.removeAsset(req.params.id, req.params.aid, actorOf(req)); res.status(204).end(); }));
api.post('/projects/:id/assets/:aid/process-preview', json, wrap(async (req, res) => {
  res.type('audio/wav').send(await actions.previewProcess(req.params.id, req.params.aid, req.body || {}));
}));
api.post('/projects/:id/assets/:aid/process', json, wrap(async (req, res) => {
  res.status(201).json(await actions.processAsset(req.params.id, req.params.aid, req.body || {}, actorOf(req)));
}));

// ── analysis, pictures, export ───────────────────────────────────────────
api.post('/projects/:id/analyze', json, wrap(async (req, res) => {
  const { target, ...opts } = req.body || {};
  res.json(await actions.analyze(req.params.id, target, opts));
}));
api.get('/projects/:id/image', wrap(async (req, res) => {
  const q = req.query;
  const n = (v) => (v === undefined ? undefined : +v);
  const png = await actions.image(req.params.id, { assetId: q.assetId, clipId: q.clipId, start: n(q.start), end: n(q.end) }, { kind: q.kind === 'spectrogram' ? 'spectrogram' : 'waveform', width: Math.min(4000, n(q.width) || 1600), height: n(q.height) && Math.min(2000, n(q.height)) });
  res.type('png').send(png);
}));
api.post('/projects/:id/render', json, wrap(async (req, res) => {
  const r = await actions.render(req.params.id, req.body || {}, actorOf(req));
  if (r.url) r.absoluteUrl = baseUrl(req) + r.url;
  res.status(201).json(r);
}));
api.get('/projects/:id/renders', wrap(async (req, res) => res.json(await actions.listRenders(req.params.id))));
api.get('/projects/:id/renders/:file', (req, res, next) => {
  store.get(req.params.id);
  if (!/^rnd_[a-f0-9]+\.[a-z0-9]+$/.test(req.params.file)) return next(new OpError('Render not found', 'not_found', 404));
  let name = store.get(req.params.id).name;
  try { name = JSON.parse(readFileSync(path.join(store.rendersDir(req.params.id), req.params.file.replace(/\.[a-z0-9]+$/, '.json')), 'utf8')).name || name; } catch {}
  res.download(path.join(store.rendersDir(req.params.id), req.params.file), `${name.replace(/[\\/:*?"<>|]/g, '_')}.${req.params.file.split('.').pop()}`, (e) => e && !res.headersSent && next(new OpError('Render not found', 'not_found', 404)));
});

// Feature modules: server/features/*.js export register({ api, json, wrap, store, actions, mcpTools, actorOf, OpError }).
const mcpTools = [];
const { readdirSync } = await import('node:fs');
for (const f of readdirSync(path.join(root, 'server', 'features')).filter((f) => f.endsWith('.js')).sort()) {
  const mod = await import(`./features/${f}`);
  await mod.register({ api, json, wrap, store, actions, mcpTools, actorOf, OpError });
}

app.use('/api', api);
mcpHandler = wrap(createMcpHandler({ store, actions, baseUrl, extraTools: mcpTools }));
app.use(express.static(path.join(root, 'public'), { extensions: ['html'] }));

app.use((err, req, res, _next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: { code: err.code || (status === 400 ? 'bad_request' : 'internal'), message: err.message } });
});

// ── live updates ─────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const u = new URL(req.url, 'http://x');
  if (!tokenOk(u.searchParams.get('token'))) return ws.close(4401, 'unauthorized');
  ws.projectId = u.searchParams.get('project');
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  try { ws.send(JSON.stringify({ type: 'hello', project: ws.projectId ? store.get(ws.projectId) : null })); }
  catch { ws.send(JSON.stringify({ type: 'error', message: 'Project not found' })); }
});
const broadcast = (projectId, msg) => {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === 1 && (!ws.projectId || ws.projectId === projectId)) ws.send(data);
};
store.on('change', ({ projectId, project, cause }) => broadcast(projectId, { type: 'project', project, cause }));
store.on('notice', (n) => broadcast(n.projectId, n));
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) ws.terminate(); else { ws.isAlive = false; ws.ping(); } } }, 30000).unref();

server.listen(PORT, HOST, () => console.log(`NyxMix on http://${HOST}:${PORT} (auth: ${TOKEN ? 'token' : 'open'})`));

function llmsTxt(base) {
  return `# NyxMix — agent-first audio editor

${INSTRUCTIONS}

## Connect
- MCP (Streamable HTTP): ${base}/mcp
- REST + OpenAPI: ${base}/openapi.json
- Live events: ${base.replace(/^http/, 'ws')}/ws?project=<id>
${TOKEN ? '- Auth: Authorization: Bearer <token>\n' : ''}- Identify yourself with the header X-Actor: agent:<your-name> — the human sees it next to your edits.

## Quick start (curl)
POST ${base}/api/projects {"name":"Episode 12"}
POST ${base}/api/projects/<id>/assets {"url":"https://…/raw.wav"}   (or multipart upload, or raw body with ?name=)
POST ${base}/api/projects/<id>/ops {"ops":[{"op":"track.add","args":{"name":"Voice"}}]}
GET  ${base}/api/projects/<id>/summary
POST ${base}/api/projects/<id>/analyze {"include":["loudness","silences"]}
POST ${base}/api/projects/<id>/ops {"ops":[{"op":"range.delete","args":{"start":12.4,"end":13.1}}]}
POST ${base}/api/projects/<id>/render {"format":"mp3","loudness":{"lufs":-16}}

## Operations
${describeOps().map((o) => `- ${o.name}: ${o.description} Args: ${Object.entries(o.args.properties).map(([k, v]) => `${k}${(o.args.required || []).includes(k) ? '*' : ''}`).join(', ')}`).join('\n')}

## Real-time effects (track or master)
${Object.entries(EFFECTS).map(([k, v]) => `- ${k}: ${v.description} Params: ${Object.entries(v.params).map(([p, s]) => `${p} ${s.minimum}…${s.maximum}${s.unit ? ' ' + s.unit : ''} (default ${s.default})`).join(', ')}`).join('\n')}

## Destructive processes (POST /api/projects/<id>/assets/<assetId>/process {"kind":…,"params":{…}})
${Object.entries(PROCESSES).map(([k, v]) => `- ${k}: ${v.description}${Object.keys(v.params).length ? ' Params: ' + Object.entries(v.params).map(([p, s]) => `${p} (default ${s.default})`).join(', ') : ''}`).join('\n')}
`;
}
