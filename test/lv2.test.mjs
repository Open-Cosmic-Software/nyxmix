// Native LV2 plugin hosting: catalog, strict control validation, apply (whole file and
// range), latency-compensated dynamics, preview and the MCP tools.
import { freePort } from './helpers.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klang-lv2-'));
let server, BASE;
const j = async (method, url, body) => {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const buf = Buffer.from(await r.arrayBuffer());
  let data = null; try { data = JSON.parse(buf.toString()); } catch {}
  return { status: r.status, data, buf, type: r.headers.get('content-type') };
};
async function upload(pid, name, lavfi, extra = []) {
  const f = path.join(dir, `${name}.wav`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', lavfi, ...extra, '-c:a', 'pcm_f32le', f]);
  return (await fetch(`${BASE}/api/projects/${pid}/assets?name=${name}`, { method: 'POST', body: fs.readFileSync(f) })).json();
}
const analyze = async (pid, target, include = ['levels', 'spectrum']) => {
  const r = await j('POST', `/api/projects/${pid}/analyze`, { target, include });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};

let catalog, pid, lowHigh, monoTone;
const uri = (name) => { const p = catalog.plugins.find((x) => x.name === name); assert.ok(p, `plugin ${name} missing`); return p.uri; };

before(async () => {
  const PORT = await freePort();
  server = spawn('node', ['server/index.js'], { env: { ...process.env, PORT, KLANG_DATA: path.join(dir, 'data') }, stdio: 'pipe' });
  BASE = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 200; i++) { try { await fetch(BASE + '/api'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  catalog = (await j('GET', '/api/lv2')).data;
  pid = (await j('POST', '/api/projects', { name: 'LV2' })).data.id;
  // 200 Hz + 6 kHz, stereo, 3 s
  lowHigh = await upload(pid, 'lowhigh', 'aevalsrc=exprs=0.3*sin(2*PI*200*t)+0.3*sin(2*PI*6000*t)|0.3*sin(2*PI*200*t)+0.3*sin(2*PI*6000*t):s=48000:d=3');
  monoTone = await upload(pid, 'mono', 'aevalsrc=exprs=0.3*sin(2*PI*100*t)+0.3*sin(2*PI*3000*t):s=48000:d=3');
});
after(() => { server?.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('catalog lists more than 100 usable effects with categories and details', async () => {
  assert.ok(catalog.available > 100, `only ${catalog.available} plugins`);
  for (const c of ['EQ', 'Compressor', 'Limiter', 'Gate', 'Delay', 'Filter']) assert.ok(catalog.categories[c] > 0, `no ${c}`);
  assert.ok(catalog.brands.LSP > 0 && catalog.brands.x42 > 0 && catalog.brands.Calf > 0);
  const eq = await j('GET', '/api/lv2?category=EQ&q=x42');
  assert.ok(eq.data.plugins.length >= 1 && eq.data.plugins.every((p) => p.category === 'EQ' && p.brand === 'x42'));
  const d = await j('GET', `/api/lv2/${eq.data.plugins[0].index}`);
  assert.equal(d.status, 200);
  const hp = d.data.params.find((p) => p.symbol === 'HPfreq');
  assert.equal(hp.unit, 'Hz'); assert.ok(hp.log);
  assert.ok(d.data.params.find((p) => p.symbol === 'HighPass').toggle);
  assert.equal((await j('GET', '/api/lv2/99999')).status, 404);
});

test('a filter cut changes the spectrum (stereo asset, Calf Filter) and swaps into clips', async () => {
  const ops = await j('POST', `/api/projects/${pid}/ops`, { ops: [{ op: 'track.add', args: {} }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId: lowHigh.id } }] });
  assert.equal(ops.status, 200, JSON.stringify(ops.data));
  const before = await analyze(pid, { assetId: lowHigh.id });
  const r = await j('POST', `/api/projects/${pid}/assets/${lowHigh.id}/lv2`, { uri: uri('Calf Filter'), controls: { mode: 1, freq: 1000 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.clipsUpdated, 1);
  assert.equal(r.data.asset.channels, 2);
  assert.ok(Math.abs(r.data.asset.duration - 3) < 0.01, `duration ${r.data.asset.duration}`);
  const after = await analyze(pid, { assetId: r.data.asset.id });
  const drop = before.spectrum.bandsRelativeDb.brilliance - after.spectrum.bandsRelativeDb.brilliance;
  assert.ok(drop > 25, `6 kHz only dropped ${drop} dB`);
  const p = (await j('GET', `/api/projects/${pid}`)).data;
  assert.equal(p.tracks[0].clips[0].assetId, r.data.asset.id);
  assert.equal(p.assets.find((a) => a.id === r.data.asset.id).process.kind, 'lv2');
  const undo = await j('POST', `/api/projects/${pid}/undo`);
  assert.equal(undo.status, 200);
  assert.equal((await j('GET', `/api/projects/${pid}`)).data.tracks[0].clips[0].assetId, lowHigh.id);
});

test('x42 parametric EQ high-pass on a mono asset keeps it mono and removes the lows', async () => {
  const before = await analyze(pid, { assetId: monoTone.id });
  const r = await j('POST', `/api/projects/${pid}/assets/${monoTone.id}/lv2`, { uri: uri('x42-eq - Parametric Equalizer Stereo'), controls: { HighPass: 1, HPfreq: 1000, HPQ: 0.7 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.asset.channels, 1);
  const after = await analyze(pid, { assetId: r.data.asset.id });
  const drop = before.spectrum.bandsRelativeDb.bass - after.spectrum.bandsRelativeDb.bass;
  assert.ok(drop > 15, `100 Hz only dropped ${drop} dB`);
});

test('a limiter reduces the peak, latency compensated', async () => {
  const loud = await upload(pid, 'loud', 'aevalsrc=exprs=0.9*sin(2*PI*220*t)|0.9*sin(2*PI*220*t):s=48000:d=2');
  const before = await analyze(pid, { assetId: loud.id }, ['levels']);
  const r = await j('POST', `/api/projects/${pid}/assets/${loud.id}/lv2`, { uri: uri('LSP Limiter Stereo'), controls: { th: 0.25, boost: 0 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.latencyCompensatedSamples > 0, 'LSP limiter look-ahead should be compensated');
  const after = await analyze(pid, { assetId: r.data.asset.id, start: 0.3 }, ['levels']);
  const reduction = before.levels.samplePeakDbfs - after.levels.samplePeakDbfs;
  assert.ok(reduction > 8, `peak only reduced by ${reduction} dB (${after.levels.samplePeakDbfs} dBFS)`);
  assert.ok(Math.abs(r.data.asset.duration - 2) < 0.01);
  // Compensation: the onset is not delayed.
  const head = await analyze(pid, { assetId: r.data.asset.id, start: 0, end: 0.004 }, ['levels']);
  assert.ok(head.levels.samplePeakDbfs > -30, `onset missing (latency not compensated): ${head.levels.samplePeakDbfs}`);
});

test('controls and uri are strictly validated', async () => {
  const filter = uri('Calf Filter');
  const url = `/api/projects/${pid}/assets/${monoTone.id}/lv2`;
  const bad = [
    { uri: filter, controls: { freq: 50000 } }, // out of range
    { uri: filter, controls: { freq: '1000' } }, // string
    { uri: filter, controls: { freq: '1000|bypass=1' } }, // injection attempt
    { uri: filter, controls: { mode: 1.5 } }, // enum / integer
    { uri: filter, controls: { 'freq:x': 1 } }, // unknown symbol
    { uri: filter, controls: { freq: null } },
    { uri: 'http://example.com/not-a-plugin' },
    { uri: 'http://lsp-plug.in/plugins/lv2/spectrum_analyzer_x1' }, // installed but not an effect
    { uri: filter, start: 'x' },
    { controls: {} },
  ];
  for (const body of bad) {
    const r = await j('POST', url, body);
    assert.equal(r.status, 400, `${JSON.stringify(body)} → ${r.status} ${JSON.stringify(r.data)}`);
  }
  const count = (await j('GET', `/api/projects/${pid}`)).data.assets.length;
  const pv = await j('POST', `/api/projects/${pid}/assets/${monoTone.id}/lv2-preview`, { uri: filter, controls: { freq: -5 } });
  assert.equal(pv.status, 400);
  assert.equal((await j('GET', `/api/projects/${pid}`)).data.assets.length, count, 'nothing created');
});

test('range apply leaves audio outside the range untouched', async () => {
  const r = await j('POST', `/api/projects/${pid}/assets/${lowHigh.id}/lv2`, { uri: uri('Calf Filter'), controls: { mode: 1, freq: 800 }, start: 1, end: 2, replaceInClips: false });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.clipsUpdated, 0);
  for (const [s, e] of [[0, 0.95], [2.05, 3]]) {
    const a = await analyze(pid, { assetId: lowHigh.id, start: s, end: e }, ['levels']);
    const b = await analyze(pid, { assetId: r.data.asset.id, start: s, end: e }, ['levels']);
    assert.equal(b.levels.rmsDbfs, a.levels.rmsDbfs, `outside ${s}–${e} changed`);
    assert.equal(b.levels.samplePeakDbfs, a.levels.samplePeakDbfs);
  }
  const inside = await analyze(pid, { assetId: r.data.asset.id, start: 1.1, end: 1.9 });
  const orig = await analyze(pid, { assetId: lowHigh.id, start: 1.1, end: 1.9 });
  assert.ok(orig.spectrum.bandsRelativeDb.brilliance - inside.spectrum.bandsRelativeDb.brilliance > 25);
});

test('preview returns a short WAV and creates nothing', async () => {
  const count = (await j('GET', `/api/projects/${pid}`)).data.assets.length;
  const r = await j('POST', `/api/projects/${pid}/assets/${lowHigh.id}/lv2-preview`, { uri: uri('Calf Vintage Delay'), start: 0.5, end: 1.5 });
  assert.equal(r.status, 200, r.buf.toString().slice(0, 300));
  assert.match(r.type, /audio\/wav/);
  assert.equal(r.buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(r.buf.toString('ascii', 8, 12), 'WAVE');
  const bytes = r.buf.length - 44;
  assert.ok(Math.abs(bytes / (48000 * 2 * 4) - 1) < 0.02, `preview is ${bytes / (48000 * 8)} s`);
  assert.equal((await j('GET', `/api/projects/${pid}`)).data.assets.length, count);
});

test('a plugin that breaks inside ffmpeg gives a clear 422 and leaves nothing behind', async () => {
  // Smuggle a plugin the startup probe rejected (NaN output) into the cached catalog and
  // restart: the server must still refuse its output cleanly.
  const data = path.join(dir, 'data');
  const cacheFile = path.join(data, 'lv2-catalog.json');
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const broken = Object.entries(cache.skipped).find(([, why]) => /non-finite|failed to run/.test(why));
  if (!broken) return; // nothing broken installed here
  const tmpl = cache.plugins.find((p) => p.name === 'Calf Filter');
  cache.plugins.push({ ...tmpl, uri: broken[0], name: 'Broken test plugin', params: [], index: cache.plugins.length });
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  const PORT = await freePort();
  const s2 = spawn('node', ['server/index.js'], { env: { ...process.env, PORT, KLANG_DATA: data }, stdio: 'pipe' });
  try {
    const B2 = `http://127.0.0.1:${PORT}`;
    for (let i = 0; i < 200; i++) { try { await fetch(B2 + '/api'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const before = (await (await fetch(`${B2}/api/projects/${pid}`)).json()).assets.length;
    const filesBefore = fs.readdirSync(path.join(data, 'projects', pid), { recursive: true }).length;
    const tmpBefore = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('klang-lv2_')).length;
    const r = await fetch(`${B2}/api/projects/${pid}/assets/${lowHigh.id}/lv2`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uri: broken[0] }) });
    const body = await r.json();
    assert.equal(r.status, 422, JSON.stringify(body));
    assert.equal(body.error.code, 'plugin_failed');
    assert.match(body.error.message, /Broken test plugin/);
    assert.equal((await (await fetch(`${B2}/api/projects/${pid}`)).json()).assets.length, before);
    assert.equal(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('klang-lv2_')).length, tmpBefore);
    assert.equal(fs.readdirSync(path.join(data, 'projects', pid), { recursive: true }).length, filesBefore, 'no stray files in the project');
  } finally { s2.kill(); }
});

test('MCP tools: list, info, apply', async () => {
  const mcp = async (name, args) => (await j('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).data;
  const tools = (await j('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).data.result.tools.map((t) => t.name);
  for (const t of ['list_lv2_plugins', 'lv2_plugin_info', 'apply_lv2_plugin']) assert.ok(tools.includes(t), t);
  const list = (await mcp('list_lv2_plugins', { category: 'Limiter' })).result.content[0].text;
  assert.match(list, /\[Limiter\] .*x42-dpl/);
  const idx = +list.match(/#(\d+) \[Limiter\] x42-dpl - Digital Peak Limiter Stereo/)[1];
  const info = (await mcp('lv2_plugin_info', { index: idx })).result.content[0].text;
  assert.match(info, /threshold/i);
  const bad = await mcp('apply_lv2_plugin', { projectId: pid, assetId: monoTone.id, uri: 'urn:nope' });
  assert.ok(bad.result?.isError || bad.error, JSON.stringify(bad));
  const ok = await mcp('apply_lv2_plugin', { projectId: pid, assetId: monoTone.id, uri: uri('Calf Vintage Delay') });
  assert.ok(!ok.result.isError, JSON.stringify(ok));
  assert.match(ok.result.content[0].text, /"id": "ast_/);
});
