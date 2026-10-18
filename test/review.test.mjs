// Regression tests for bugs found in the code review (ops invariants, undo, graph, injection, races).
import { freePort } from './helpers.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderMix, writeWav } from '../server/audio.js';

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klang-review-'));
let server, pid, assetId, trackId, busId, clipId;

const j = async (method, url, body) => {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', 'X-Actor': 'agent:review-test' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
};
const ops = (list) => j('POST', `/api/projects/${pid}/ops`, { ops: list });

before(async () => {
  server = spawn('node', ['server/index.js'], { env: { ...process.env, PORT, KLANG_DATA: path.join(dir, 'data') }, stdio: 'pipe' });
  for (let i = 0; i < 200; i++) {
    try { await fetch(BASE + '/api'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  pid = (await j('POST', '/api/projects', { name: 'Review' })).data.id;
  const f = path.join(dir, 't.wav');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=3', f]);
  assetId = (await (await fetch(`${BASE}/api/projects/${pid}/assets?name=tone`, { method: 'POST', body: fs.readFileSync(f) })).json()).id;
  const r = await ops([{ op: 'track.add', args: {} }, { op: 'track.add', args: { kind: 'bus' } }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId, offset: 2 } }]);
  [{ trackId }, { trackId: busId }, { clipId }] = r.data.results;
});
after(() => { server.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('clips cannot be moved or duplicated onto a bus', async () => {
  assert.equal((await ops([{ op: 'clip.update', args: { clipId, trackId: busId } }])).status, 422);
  assert.equal((await ops([{ op: 'clip.duplicate', args: { clipId, trackId: busId } }])).status, 422);
  const p = (await j('GET', `/api/projects/${pid}`)).data;
  assert.equal(p.tracks.find((t) => t.id === busId).clips.length, 0);
});

test('asset.replaceInClips refuses an asset too short for the clip offset', async () => {
  const short = (await j('POST', `/api/projects/${pid}/assets/${assetId}/process`, { kind: 'trim', params: { start: 0, end: 1 } })).data.asset;
  const r = await ops([{ op: 'asset.replaceInClips', args: { fromAssetId: assetId, toAssetId: short.id } }]);
  assert.equal(r.status, 422, JSON.stringify(r.data));
});

test('undo reverts asset.rename', async () => {
  await ops([{ op: 'asset.rename', args: { assetId, name: 'Renamed' } }]);
  await j('POST', `/api/projects/${pid}/undo`);
  assert.equal((await j('GET', `/api/projects/${pid}`)).data.assets.find((a) => a.id === assetId).name, 'tone');
});

test('effect params reject inherited Object keys', async () => {
  const r = await ops([{ op: 'effect.add', args: { type: 'gain', params: { constructor: 3 } } }]);
  assert.equal(r.status, 400);
  assert.equal((await j('POST', `/api/projects/${pid}/ops/constructor`, {})).status, 400);
});

test('asset audio route only serves assets of the project (no path traversal)', async () => {
  const outside = path.join(dir, 'outside.wav');
  fs.copyFileSync(path.join(dir, 't.wav'), outside);
  const rel = path.relative(path.join(dir, 'data', 'projects', pid, 'assets'), outside).replace(/\.wav$/, '');
  for (const kind of ['audio', 'peaks']) {
    const res = await fetch(`${BASE}/api/projects/${pid}/assets/${encodeURIComponent(rel)}/${kind}`);
    assert.equal(res.status, 404, kind);
  }
});

test('render and image options cannot inject ffmpeg filters', async () => {
  const marker = path.join(dir, 'pwned.txt');
  const r = await j('POST', `/api/projects/${pid}/render`, { format: 'mp3', loudness: { lufs: `-16,ametadata=mode=print:file=${marker},loudnorm=I=-16` } });
  assert.equal(r.status, 400);
  const m = await j('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_image', arguments: { projectId: pid, target: { assetId }, width: `400x100,ametadata=mode=print:file=${marker},showwavespic=s=400` } } });
  assert.equal(m.status, 200);
  assert.equal(fs.existsSync(marker), false);
});

test('a proposal accepted concurrently is applied once', async () => {
  const prop = (await j('POST', `/api/projects/${pid}/proposals`, { label: 'marker', ops: [{ op: 'marker.add', args: { time: 0.5, label: 'once' } }] })).data;
  const rs = await Promise.all([1, 2, 3].map(() => j('POST', `/api/projects/${pid}/proposals/${prop.id}/accept`)));
  assert.deepEqual(rs.map((x) => x.status).sort(), [200, 409, 409]);
  assert.equal((await j('GET', `/api/projects/${pid}`)).data.markers.filter((x) => x.label === 'once').length, 1);
});

test('an asset used by a saved version cannot be deleted', async () => {
  const f = path.join(dir, 't.wav');
  const extra = (await (await fetch(`${BASE}/api/projects/${pid}/assets?name=extra`, { method: 'POST', body: fs.readFileSync(f) })).json()).id;
  const r = await ops([{ op: 'clip.add', args: { trackId, assetId: extra, start: 5 } }]);
  await j('POST', `/api/projects/${pid}/versions`, { name: 'with extra' });
  await ops([{ op: 'clip.remove', args: { clipId: r.data.results[0].clipId } }]);
  const del = await j('DELETE', `/api/projects/${pid}/assets/${extra}`);
  assert.equal(del.status, 409);
});

// ── engine (no server needed) ──────────────────────────────────────────────
const sr = 48000;
const tone = new Float32Array(sr * 2).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr));
const clip = (start, duration) => ({ id: `c${start}`, assetId: 'ast_t', start, offset: 0, duration, gain: 0, fadeIn: 0, fadeOut: 0 });
const tr = (id, extra) => ({ id, name: id, gain: 0, pan: 0, mute: false, solo: false, effects: [], clips: [], sends: [], ...extra });
const peak = (chs, from = 0) => { let m = 0; for (const c of chs) for (let i = from; i < c.length; i++) m = Math.max(m, Math.abs(c[i])); return m; };
const base = { sampleRate: sr, master: { gain: 0, effects: [] }, markers: [] };

test('engine: soloing another track also silences pre-fader sends', async () => {
  await writeWav(path.join(dir, 'ast_t.wav'), [tone], sr);
  const p = { ...base, tracks: [tr('bus', { kind: 'bus' }), tr('A', { solo: true }), tr('B', { clips: [clip(0, 2)], sends: [{ id: 's', busId: 'bus', level: 0, pre: true }] })] };
  const m = await renderMix(p, (id) => path.join(dir, `${id}.wav`), { start: 0, end: 2 });
  assert.equal(peak(m.channels), 0);
});

test('engine: render tail does not play clips that start after the end', async () => {
  await writeWav(path.join(dir, 'ast_t.wav'), [tone], sr);
  const p = { ...base, tracks: [tr('A', { clips: [clip(0, 1), clip(3, 1)] })] };
  const m = await renderMix(p, (id) => path.join(dir, `${id}.wav`), { start: 0, end: 2, tail: 2 });
  assert.ok(peak(m.channels) > 0.3);
  assert.equal(peak(m.channels, 3 * sr), 0);
});

test('auto crossfade fades disappear when the clips are moved apart', async () => {
  const p = (await j('POST', '/api/projects', { name: 'XF' })).data;
  const f = path.join(dir, 'xf.wav');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=300:d=4', f]);
  const a = await (await fetch(`${BASE}/api/projects/${p.id}/assets?name=x`, { method: 'POST', body: fs.readFileSync(f) })).json();
  const r = await j('POST', `/api/projects/${p.id}/ops`, { ops: [{ op: 'track.add', args: {} }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId: a.id, start: 0 } }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId: a.id, start: 3 } }] });
  const second = r.data.results[2].clipId;
  let clips = (await j('GET', `/api/projects/${p.id}`)).data.tracks[0].clips;
  assert.equal(clips[0].fadeOut, 1); assert.equal(clips[1].fadeIn, 1);
  await j('POST', `/api/projects/${p.id}/ops/clip.update`, { clipId: second, start: 6 });
  clips = (await j('GET', `/api/projects/${p.id}`)).data.tracks[0].clips;
  assert.equal(clips[0].fadeOut, 0); assert.equal(clips[1].fadeIn, 0);
});

test('a proposal made before other edits is refused unless forced', async () => {
  const p = (await j('POST', '/api/projects', { name: 'Stale' })).data;
  const pr = (await j('POST', `/api/projects/${p.id}/proposals`, { label: 'Add a track', ops: [{ op: 'track.add', args: {} }] })).data;
  await j('POST', `/api/projects/${p.id}/ops/project.rename`, { name: 'Changed' });
  const r = await j('POST', `/api/projects/${p.id}/proposals/${pr.id}/accept`);
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, 'stale_proposal');
  const f = await j('POST', `/api/projects/${p.id}/proposals/${pr.id}/accept?force=1`);
  assert.equal(f.status, 200);
});
