import { freePort } from './helpers.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klang-faust-'));
let server, BASE;
const j = async (method, url, body) => { const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => null) }; };

before(async () => {
  const PORT = await freePort();
  server = spawn('node', ['server/index.js'], { env: { ...process.env, PORT, KLANG_DATA: path.join(dir, 'data'), KLANG_PLUGINS: '1' }, stdio: 'pipe' });
  BASE = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 200; i++) { try { await fetch(BASE + '/api'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
});
after(() => { server?.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

// A project with one track playing a sine, optionally through an effect.
async function toneProject(freq, effect) {
  const p = (await j('POST', '/api/projects', { name: `Faust ${freq}` })).data;
  const f = path.join(dir, `t${freq}.wav`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=f=${freq}:d=2`, f]);
  const a = await (await fetch(`${BASE}/api/projects/${p.id}/assets?name=t`, { method: 'POST', body: fs.readFileSync(f) })).json();
  const ops = [{ op: 'track.add', args: {} }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId: a.id } }];
  if (effect) ops.push({ op: 'effect.add', args: { trackId: '$0.trackId', ...effect } });
  const r = await j('POST', `/api/projects/${p.id}/ops`, { ops });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const an = await j('POST', `/api/projects/${p.id}/analyze`, { include: ['levels'] });
  assert.equal(an.status, 200, JSON.stringify(an.data));
  return an.data.levels.rmsDbfs;
}

test('a shipped Faust example installs and compresses in a server render', async () => {
  const code = fs.readFileSync('examples/plugins/faust/compressor.dsp', 'utf8');
  const r = await j('POST', '/api/plugins/faust', { id: 'faust-comp', label: 'Faust Compressor', code });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.type, 'plugin:faust-comp');
  assert.deepEqual(Object.keys(r.data.params).sort(), ['attack', 'makeup', 'ratio', 'release', 'threshold']);
  assert.deepEqual([r.data.params.threshold.minimum, r.data.params.threshold.maximum, r.data.params.threshold.default, r.data.params.threshold.unit], [-60, 0, -20, 'dB']);
  assert.equal((await fetch(`${BASE}/api/plugins/faust-comp.js`)).status, 200);
  const clean = await toneProject(220);
  const squashed = await toneProject(220, { type: 'plugin:faust-comp', params: { threshold: -40, ratio: 20, attack: 1 } });
  assert.ok(squashed < clean - 10, JSON.stringify({ clean, squashed }));
});

test('a mono Faust filter runs per channel and follows its parameter', async () => {
  const code = 'import("stdfaust.lib"); process = fi.lowpass(2, hslider("cutoff [unit:Hz]", 1000, 50, 10000, 1));';
  const r = await j('POST', '/api/plugins/faust', { id: 'faust-lp', label: 'Faust Lowpass', code });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const clean = await toneProject(8000);
  const low = await toneProject(8000, { type: 'plugin:faust-lp', params: { cutoff: 500 } });
  const open = await toneProject(8000, { type: 'plugin:faust-lp', params: { cutoff: 10000 } });
  assert.ok(low < clean - 30, JSON.stringify({ clean, low }));
  assert.ok(open > clean - 3, JSON.stringify({ clean, open }));
});

test('Faust compile errors come back verbatim', async () => {
  const r = await j('POST', '/api/plugins/faust', { id: 'faust-bad', label: 'Bad', code: 'import("stdfaust.lib"); process = fi.nosuchfilter(3);' });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.equal(r.data.error.code, 'faust_compile_error');
  assert.match(r.data.error.message, /ERROR.*nosuchfilter/);
  const list = (await j('GET', '/api/plugins')).data.plugins.map((p) => p.id);
  assert.ok(!list.includes('faust-bad'));
});
