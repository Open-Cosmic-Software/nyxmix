// Integration tests: boots a server on a temp data dir and drives it over HTTP + MCP.
import { freePort } from './helpers.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klang-test-'));
let server;

async function j(method, url, body, headers = {}) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', 'X-Actor': 'agent:test', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const tone = (file, args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, file]);

before(async () => {
  server = spawn('node', ['server/index.js'], { env: { ...process.env, PORT, KLANG_DATA: path.join(dir, 'data') }, stdio: 'pipe' });
  for (let i = 0; i < 200; i++) {
    try { await fetch(BASE + '/api'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});
after(() => { server.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

let pid, assetId, trackId;

test('create project and import a tone', async () => {
  const p = await j('POST', '/api/projects', { name: 'T', sampleRate: 48000 });
  assert.equal(p.status, 201);
  pid = p.data.id;
  const f = path.join(dir, 'a.wav');
  tone(f, ['-f', 'lavfi', '-i', 'sine=f=440:d=4:sample_rate=44100', '-af', 'volume=4']);
  const res = await fetch(`${BASE}/api/projects/${pid}/assets?name=tone`, { method: 'POST', body: fs.readFileSync(f), headers: { 'Content-Type': 'audio/wav' } });
  assert.equal(res.status, 201);
  const a = await res.json();
  assert.equal(a.sampleRate, 48000);
  assert.ok(Math.abs(a.duration - 4) < 0.01, `duration ${a.duration}`);
  assetId = a.id;
});

test('batch with $refs is atomic and returns results', async () => {
  const r = await j('POST', `/api/projects/${pid}/ops`, { ops: [
    { op: 'track.add', args: { name: 'Voice' } },
    { op: 'clip.add', args: { trackId: '$0.trackId', assetId, start: 1 } },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  trackId = r.data.results[0].trackId;
  assert.match(r.data.results[1].clipId, /^clp_/);
  const bad = await j('POST', `/api/projects/${pid}/ops`, { ops: [
    { op: 'track.add', args: { name: 'Ghost' } },
    { op: 'clip.split', args: { clipId: 'clp_nope', at: 1 } },
  ] });
  assert.equal(bad.status, 404);
  const p = await j('GET', `/api/projects/${pid}`);
  assert.equal(p.data.tracks.length, 1, 'failed batch must not leave a track behind');
});

test('validation errors are specific', async () => {
  const r = await j('POST', `/api/projects/${pid}/ops/track.update`, { trackId, gain: 99 });
  assert.equal(r.status, 400);
  assert.match(r.data.error.message, /gain must be <= 12/);
  const e = await j('POST', `/api/projects/${pid}/ops/effect.add`, { trackId, type: 'eq', params: { wobble: 1 } });
  assert.match(e.data.error.message, /no parameter "wobble"/);
});

test('ripple delete across a clip, then undo/redo', async () => {
  const before = (await j('GET', `/api/projects/${pid}`)).data;
  const r = await j('POST', `/api/projects/${pid}/ops/range.delete`, { start: 2, end: 3 });
  assert.equal(r.status, 200);
  const p = (await j('GET', `/api/projects/${pid}`)).data;
  const clips = p.tracks[0].clips;
  assert.equal(clips.length, 2);
  assert.equal(clips[0].start, 1); assert.equal(clips[0].duration, 1);
  assert.equal(clips[1].start, 2); assert.equal(clips[1].offset, 2); assert.equal(clips[1].duration, 2);
  assert.equal(clips[0].fadeOut, 0.005);
  await j('POST', `/api/projects/${pid}/undo`);
  const u = (await j('GET', `/api/projects/${pid}`)).data;
  assert.deepEqual(u.tracks, before.tracks);
  await j('POST', `/api/projects/${pid}/redo`);
  assert.equal((await j('GET', `/api/projects/${pid}`)).data.tracks[0].clips.length, 2);
});

test('ifRev guards against clobbering', async () => {
  const p = (await j('GET', `/api/projects/${pid}`)).data;
  const r = await j('POST', `/api/projects/${pid}/ops`, { ifRev: p.rev - 1, ops: [{ op: 'project.rename', args: { name: 'X' } }] });
  assert.equal(r.status, 409);
});

test('analysis measures the mix and finds the gap', async () => {
  await j('POST', `/api/projects/${pid}/undo`); // back to one 4 s clip at 1 s
  const a = await j('POST', `/api/projects/${pid}/analyze`, { include: ['loudness', 'levels', 'silences'] });
  assert.equal(a.status, 200);
  assert.ok(a.data.loudness.integratedLufs > -30 && a.data.loudness.integratedLufs < 0, JSON.stringify(a.data.loudness));
  assert.equal(a.data.silencesTimeline[0].start, 0);
  assert.ok(Math.abs(a.data.silencesTimeline[0].end - 1) < 0.02);
});

test('render matches loudness target and preview graph parity', async () => {
  const r = await j('POST', `/api/projects/${pid}/render`, { format: 'flac', loudness: { lufs: -20, truePeak: -1 } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.ok(Math.abs(r.data.loudness.integratedLufs + 20) < 0.6, JSON.stringify(r.data.loudness));
  const dl = await fetch(BASE + r.data.url);
  assert.equal(dl.status, 200);
  assert.ok((await dl.arrayBuffer()).byteLength > 10000);
});

test('effects render through the shared graph', async () => {
  const add = await j('POST', `/api/projects/${pid}/ops`, { ops: [
    { op: 'effect.add', args: { trackId, type: 'eq', params: { lpFreq: 1000 } } },
    { op: 'effect.add', args: { trackId, type: 'gain', params: { gain: -12 } } },
  ] });
  assert.equal(add.status, 200);
  const a = await j('POST', `/api/projects/${pid}/analyze`, { include: ['levels'] });
  // 440 Hz passes the low-pass and the -12 dB gain applies; a centred mono clip stays at 0 dB.
  const b = (await j('POST', `/api/projects/${pid}/analyze`, { target: { assetId }, include: ['levels'] })).data.levels.samplePeakDbfs;
  const diff = b - a.data.levels.samplePeakDbfs;
  assert.ok(diff > 11 && diff < 17, `peak drop ${diff} dB`);
});

test('process denoise swaps the asset in clips; undo restores', async () => {
  const r = await j('POST', `/api/projects/${pid}/assets/${assetId}/process`, { kind: 'normalize', params: { peakDb: -3 } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.clipsUpdated, 1);
  const lv = (await j('POST', `/api/projects/${pid}/analyze`, { target: { assetId: r.data.asset.id }, include: ['levels'] })).data.levels;
  assert.ok(Math.abs(lv.samplePeakDbfs + 3) < 0.05, `peak ${lv.samplePeakDbfs}`);
  await j('POST', `/api/projects/${pid}/undo`);
  const p = (await j('GET', `/api/projects/${pid}`)).data;
  assert.equal(p.tracks[0].clips[0].assetId, assetId);
  assert.equal(p.assets.length, 2, 'processed asset stays in the bin after undo');
});

test('MCP: initialize, list tools, call an op tool and an image tool', async () => {
  const init = await j('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'tester' }, capabilities: {} } });
  assert.equal(init.data.result.serverInfo.name, 'nyxmix');
  const sid = init.headers.get('mcp-session-id');
  assert.ok(sid);
  const h = { 'Mcp-Session-Id': sid, 'X-Actor': '' };
  const list = await j('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, h);
  const names = list.data.result.tools.map((t) => t.name);
  for (const n of ['edit', 'analyze', 'get_image', 'clip_split', 'range_delete', 'render']) assert.ok(names.includes(n), n);
  const call = await j('POST', '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'marker_add', arguments: { projectId: pid, time: 1.5, label: 'check breath' } } }, h);
  assert.ok(!call.data.result.isError, JSON.stringify(call.data));
  const act = (await j('GET', `/api/projects/${pid}/activity?limit=1`)).data[0];
  assert.equal(act.actor, 'agent:tester');
  const img = await j('POST', '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_image', arguments: { projectId: pid, kind: 'spectrogram', width: 400, height: 200 } } }, h);
  assert.equal(img.data.result.content[0].type, 'image');
  const err = await j('POST', '/mcp', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'clip_split', arguments: { projectId: pid, clipId: 'nope', at: 1 } } }, h);
  assert.equal(err.data.result.isError, true);
});

test('URL import refuses private addresses', async () => {
  const r = await j('POST', `/api/projects/${pid}/assets`, { url: 'http://127.0.0.1:18789/' });
  assert.equal(r.status, 403);
});

test('openapi and llms.txt describe every op', async () => {
  const o = (await j('GET', '/openapi.json')).data;
  assert.ok(o.components.schemas.range_delete);
  const l = (await j('GET', '/llms.txt')).data;
  assert.match(l, /range\.delete/);
});

test('worklet limiter guarantees the ceiling in the offline render', async () => {
  const p = (await j('POST', '/api/projects', { name: 'L' })).data;
  const f = path.join(dir, 'loud.wav');
  tone(f, ['-f', 'lavfi', '-i', 'sine=f=200:d=2', '-af', 'volume=7']);
  const res = await fetch(`${BASE}/api/projects/${p.id}/assets?name=loud`, { method: 'POST', body: fs.readFileSync(f) });
  const a = await res.json();
  const r = await j('POST', `/api/projects/${p.id}/ops`, { ops: [
    { op: 'track.add', args: {} },
    { op: 'clip.add', args: { trackId: '$0.trackId', assetId: a.id } },
    { op: 'effect.add', args: { trackId: '$0.trackId', type: 'gain', params: { gain: 12 } } },
    { op: 'effect.add', args: { type: 'limiter', params: { ceiling: -3 } } },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const lv = (await j('POST', `/api/projects/${p.id}/analyze`, { include: ['levels'] })).data.levels;
  assert.ok(lv.samplePeakDbfs <= -2.99 && lv.samplePeakDbfs > -3.5, `peak ${lv.samplePeakDbfs}`);
});

test('volume automation shapes the render and follows ripple cuts', async () => {
  const p = (await j('POST', '/api/projects', { name: 'A' })).data;
  const f = path.join(dir, 'flat.wav');
  tone(f, ['-f', 'lavfi', '-i', 'sine=f=300:d=6', '-af', 'volume=4']);
  const a = await (await fetch(`${BASE}/api/projects/${p.id}/assets?name=flat`, { method: 'POST', body: fs.readFileSync(f) })).json();
  const r = await j('POST', `/api/projects/${p.id}/ops`, { ops: [
    { op: 'track.add', args: {} },
    { op: 'clip.add', args: { trackId: '$0.trackId', assetId: a.id } },
    { op: 'automation.set', args: { trackId: '$0.trackId', param: 'volume', points: [{ time: 2, value: 0 }, { time: 2.01, value: -20 }, { time: 4, value: -20 }, { time: 4.01, value: 0 }] } },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const lvl = async (start, end) => (await j('POST', `/api/projects/${p.id}/analyze`, { target: { start, end }, include: ['levels'] })).data.levels.rmsDbfs;
  const loud = await lvl(0.5, 1.5), quiet = await lvl(2.5, 3.5);
  assert.ok(Math.abs(loud - quiet - 20) < 0.5, `loud ${loud} quiet ${quiet}`);
  await j('POST', `/api/projects/${p.id}/ops/range.delete`, { start: 1, end: 2 });
  const pts = (await j('GET', `/api/projects/${p.id}`)).data.tracks[0].automation.volume;
  assert.ok(pts.some((pt) => Math.abs(pt.time - 1.01) < 1e-6 && pt.value === -20), JSON.stringify(pts));
});

test('auto-duck writes automation around speech', async () => {
  const p = (await j('POST', '/api/projects', { name: 'D' })).data;
  const voice = path.join(dir, 'v.wav'), music = path.join(dir, 'm.wav');
  // "Speech" from 2–4 s and 7–8 s, silence elsewhere.
  tone(voice, ['-f', 'lavfi', '-i', 'sine=f=250:d=10', '-af', "volume='if(between(t,2,4)+between(t,7,8),4,0)':eval=frame"]);
  tone(music, ['-f', 'lavfi', '-i', 'sine=f=600:d=10']);
  const up = async (f, n) => (await fetch(`${BASE}/api/projects/${p.id}/assets?name=${n}`, { method: 'POST', body: fs.readFileSync(f) })).json();
  const va = await up(voice, 'voice'), ma = await up(music, 'music');
  const r = await j('POST', `/api/projects/${p.id}/ops`, { ops: [
    { op: 'track.add', args: { name: 'Voice' } }, { op: 'track.add', args: { name: 'Music' } },
    { op: 'clip.add', args: { trackId: '$0.trackId', assetId: va.id } }, { op: 'clip.add', args: { trackId: '$1.trackId', assetId: ma.id } },
  ] });
  const musicId = r.data.results[1].trackId;
  const d = await j('POST', `/api/projects/${p.id}/duck`, { musicTrackId: musicId, amount: -15 });
  assert.equal(d.status, 200, JSON.stringify(d.data));
  assert.equal(d.data.speechRegions.length, 2, JSON.stringify(d.data.speechRegions));
  assert.ok(Math.abs(d.data.speechRegions[0].start - 2) < 0.1);
  const proj = (await j('GET', `/api/projects/${p.id}`)).data;
  const pts = proj.tracks.find((t) => t.id === musicId).automation.volume;
  assert.ok(pts.some((x) => x.value === -15));
});

test('proposals: validate, preview, accept; versions restore', async () => {
  const p = (await j('POST', '/api/projects', { name: 'R' })).data;
  const bad = await j('POST', `/api/projects/${p.id}/proposals`, { label: 'x', ops: [{ op: 'clip.remove', args: { clipId: 'nope' } }] });
  assert.equal(bad.status, 404);
  const ok = await j('POST', `/api/projects/${p.id}/proposals`, { label: 'Add a music track', rationale: 'for the intro', ops: [{ op: 'track.add', args: { name: 'Music' } }] });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal((await j('GET', `/api/projects/${p.id}`)).data.tracks.length, 0, 'proposal must not apply');
  const prev = await j('GET', `/api/projects/${p.id}/proposals/${ok.data.id}/preview`);
  assert.equal(prev.data.tracks[0].name, 'Music');
  const v = await j('POST', `/api/projects/${p.id}/versions`, { name: 'Empty' });
  assert.equal(v.status, 201);
  const acc = await j('POST', `/api/projects/${p.id}/proposals/${ok.data.id}/accept`);
  assert.equal(acc.data.proposal.status, 'accepted');
  assert.equal((await j('GET', `/api/projects/${p.id}`)).data.tracks.length, 1);
  await j('POST', `/api/projects/${p.id}/versions/${v.data.id}/restore`);
  assert.equal((await j('GET', `/api/projects/${p.id}`)).data.tracks.length, 0);
  await j('POST', `/api/projects/${p.id}/undo`);
  assert.equal((await j('GET', `/api/projects/${p.id}`)).data.tracks.length, 1, 'restore is undoable');
});

test('range processing only changes the range, with seamless edges', async () => {
  const p = (await j('POST', '/api/projects', { name: 'Range' })).data;
  const f = path.join(dir, 'r.wav');
  tone(f, ['-f', 'lavfi', '-i', 'sine=f=200:d=6', '-af', 'volume=4']);
  const a = await (await fetch(`${BASE}/api/projects/${p.id}/assets?name=r`, { method: 'POST', body: fs.readFileSync(f) })).json();
  const r = await j('POST', `/api/projects/${p.id}/assets/${a.id}/process`, { kind: 'normalize', params: { peakDb: -20 }, start: 2, end: 4 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const lv = async (start, end) => (await j('POST', `/api/projects/${p.id}/analyze`, { target: { assetId: r.data.asset.id, start, end }, include: ['levels'] })).data.levels.samplePeakDbfs;
  const before = await lv(0.5, 1.5), inside = await lv(2.5, 3.5), after = await lv(4.5, 5.5);
  assert.ok(Math.abs(inside + 20) < 0.3, `inside ${inside}`);
  assert.ok(Math.abs(before - after) < 0.1 && before > -15, `outside ${before} / ${after}`);
  const bad = await j('POST', `/api/projects/${p.id}/assets/${a.id}/process`, { kind: 'tempo', start: 1, end: 2 });
  assert.equal(bad.status, 400);
});

test('neural voice denoise runs', async () => {
  const p = (await j('POST', '/api/projects', { name: 'RNN' })).data;
  const f = path.join(dir, 'n.wav');
  tone(f, ['-f', 'lavfi', '-i', 'anoisesrc=d=2:c=white:a=0.05', '-ar', '44100']);
  const a = await (await fetch(`${BASE}/api/projects/${p.id}/assets?name=n`, { method: 'POST', body: fs.readFileSync(f) })).json();
  const r = await j('POST', `/api/projects/${p.id}/assets/${a.id}/process`, { kind: 'voiceDenoise', params: { mix: 1 } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const rms = async (id) => (await j('POST', `/api/projects/${p.id}/analyze`, { target: { assetId: id }, include: ['levels'] })).data.levels.rmsDbfs;
  const d = (await rms(a.id)) - (await rms(r.data.asset.id));
  assert.ok(d > 10, `noise reduced by ${d} dB`);
});

test('export writes markers as chapters', async () => {
  const p = (await j('POST', '/api/projects', { name: 'Chapters' })).data;
  const f = path.join(dir, 'c.wav');
  tone(f, ['-f', 'lavfi', '-i', 'sine=f=300:d=6']);
  const a = await (await fetch(`${BASE}/api/projects/${p.id}/assets?name=c`, { method: 'POST', body: fs.readFileSync(f) })).json();
  await j('POST', `/api/projects/${p.id}/ops`, { ops: [
    { op: 'track.add', args: {} }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId: a.id } },
    { op: 'marker.add', args: { time: 0, label: 'Intro' } }, { op: 'marker.add', args: { time: 2.5, label: 'Thema: Klang' } }, { op: 'marker.add', args: { time: 4, label: '' } },
  ] });
  const r = await j('POST', `/api/projects/${p.id}/render`, { format: 'mp3' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.chapters, 2);
  const out = path.join(dir, 'c.mp3');
  fs.writeFileSync(out, Buffer.from(await (await fetch(BASE + r.data.url)).arrayBuffer()));
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_chapters', '-show_format', out]).toString());
  assert.deepEqual(info.chapters.map((c) => c.tags.title), ['Intro', 'Thema: Klang']);
  assert.equal(info.format.tags.title, 'Chapters');
});

test('buses: output routing and post-fader sends reach the mix; solo keeps buses', async () => {
  const p = (await j('POST', '/api/projects', { name: 'Bus' })).data;
  const f = path.join(dir, 'b.wav');
  tone(f, ['-f', 'lavfi', '-i', 'sine=f=440:d=3', '-af', 'volume=2']);
  const a = await (await fetch(`${BASE}/api/projects/${p.id}/assets?name=b`, { method: 'POST', body: fs.readFileSync(f) })).json();
  const r = await j('POST', `/api/projects/${p.id}/ops`, { ops: [
    { op: 'track.add', args: { name: 'Voice' } },
    { op: 'track.add', args: { name: 'FX', kind: 'bus' } },
    { op: 'clip.add', args: { trackId: '$0.trackId', assetId: a.id } },
    { op: 'effect.add', args: { trackId: '$1.trackId', type: 'gain', params: { gain: -40 } } },
    { op: 'track.update', args: { trackId: '$0.trackId', output: '$1.trackId' } },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const [voice, bus] = [r.data.results[0].trackId, r.data.results[1].trackId];
  const peak = async () => (await j('POST', `/api/projects/${p.id}/analyze`, { include: ['levels'] })).data.levels.samplePeakDbfs;
  const direct = (await j('POST', `/api/projects/${p.id}/analyze`, { target: { assetId: a.id }, include: ['levels'] })).data.levels.samplePeakDbfs;
  const viaBus = await peak();
  assert.ok(Math.abs(direct - 40 - viaBus) < 0.6, `bus routing: direct ${direct}, via bus ${viaBus}`);
  // Back to master + a -6 dB send into the (-40 dB) bus: send adds almost nothing.
  await j('POST', `/api/projects/${p.id}/ops`, { ops: [{ op: 'track.update', args: { trackId: voice, output: 'master', solo: true } }, { op: 'send.add', args: { trackId: voice, busId: bus, level: -6 } }] });
  const withSend = await peak();
  assert.ok(Math.abs(withSend - direct) < 0.2, `send: ${withSend}`);
  const bad = await j('POST', `/api/projects/${p.id}/ops/clip.add`, { trackId: bus, assetId: a.id });
  assert.equal(bad.status, 422);
});

test('stems: one file per audio track', async () => {
  const p = (await j('POST', '/api/projects', { name: 'Stems' })).data;
  const f = path.join(dir, 's.wav');
  tone(f, ['-f', 'lavfi', '-i', 'sine=f=300:d=2']);
  const a = await (await fetch(`${BASE}/api/projects/${p.id}/assets?name=s`, { method: 'POST', body: fs.readFileSync(f) })).json();
  await j('POST', `/api/projects/${p.id}/ops`, { ops: [
    { op: 'track.add', args: { name: 'A' } }, { op: 'track.add', args: { name: 'B' } }, { op: 'track.add', args: { kind: 'bus' } },
    { op: 'clip.add', args: { trackId: '$0.trackId', assetId: a.id } }, { op: 'clip.add', args: { trackId: '$1.trackId', assetId: a.id, start: 1, gain: -12 } },
  ] });
  const r = await j('POST', `/api/projects/${p.id}/render`, { format: 'flac', stems: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual(r.data.stems.map((s) => s.name), ['Stems – A', 'Stems – B']);
  assert.ok(r.data.stems[0].loudness.integratedLufs - r.data.stems[1].loudness.integratedLufs > 9);
  const dl = await fetch(BASE + r.data.stems[1].url);
  assert.match(dl.headers.get('content-disposition'), /Stems – B|Stems%20%E2%80%93%20B/);
});

test('limiter holds true peak (inter-sample) under the ceiling', async () => {
  const p = (await j('POST', '/api/projects', { name: 'TP' })).data;
  const f = path.join(dir, 'tp.wav');
  // fs/4-ish tone with phase offset: classic inter-sample overs.
  tone(f, ['-f', 'lavfi', '-i', 'sine=f=11025:d=3:sample_rate=48000', '-af', 'volume=8']);
  const a = await (await fetch(`${BASE}/api/projects/${p.id}/assets?name=tp`, { method: 'POST', body: fs.readFileSync(f) })).json();
  await j('POST', `/api/projects/${p.id}/ops`, { ops: [{ op: 'track.add', args: {} }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId: a.id } }, { op: 'effect.add', args: { type: 'limiter', params: { ceiling: -1, drive: 6 } } }] });
  const L = (await j('POST', `/api/projects/${p.id}/analyze`, { include: ['loudness'] })).data.loudness;
  assert.ok(L.truePeakDbtp <= -0.9, `true peak ${L.truePeakDbtp}`);
});

test('modulation effects render through the API with timeline-locked phase', async () => {
  const p = (await j('POST', '/api/projects', { name: 'Mod' })).data;
  const f = path.join(dir, 'mod.wav');
  tone(f, ['-f', 'lavfi', '-i', 'sine=f=220:d=6']);
  const a = await (await fetch(`${BASE}/api/projects/${p.id}/assets?name=m`, { method: 'POST', body: fs.readFileSync(f) })).json();
  const r = await j('POST', `/api/projects/${p.id}/ops`, { ops: [
    { op: 'track.add', args: {} }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId: a.id } },
    { op: 'effect.add', args: { trackId: '$0.trackId', type: 'tremolo', params: { rate: 2, depth: 1 } } },
    { op: 'effect.add', args: { trackId: '$0.trackId', type: 'chorus' } },
    { op: 'effect.add', args: { type: 'width', params: { width: 1.5 } } },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // Same 1-second window measured from a render that starts at 0 and one that starts at 3.
  const env = async (start) => (await j('POST', `/api/projects/${p.id}/analyze`, { target: { start, end: 5 }, include: ['envelope'], envelopeStep: 0.05 })).data.envelope.rmsDbfs;
  const a0 = (await env(0)).slice(80, 100), a3 = (await env(3)).slice(20, 40);
  const diff = Math.max(...a0.map((v, i) => Math.abs(v - a3[i])));
  assert.ok(diff < 0.5, `tremolo phase differs by ${diff} dB between render starts`);
});

test('effect parameter automation: EQ gain sweeps in the render; bad params are refused', async () => {
  const p = (await j('POST', '/api/projects', { name: 'FxAuto' })).data;
  const f = path.join(dir, 'fxa.wav');
  tone(f, ['-f', 'lavfi', '-i', 'sine=f=1000:d=6', '-af', 'volume=2']);
  const a = await (await fetch(`${BASE}/api/projects/${p.id}/assets?name=t`, { method: 'POST', body: fs.readFileSync(f) })).json();
  const r = await j('POST', `/api/projects/${p.id}/ops`, { ops: [
    { op: 'track.add', args: {} }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId: a.id } },
    { op: 'effect.add', args: { trackId: '$0.trackId', type: 'eq', params: { mid1Freq: 1000, mid1Q: 1 } } },
  ] });
  const [tid, fxid] = [r.data.results[0].trackId, r.data.results[2].effectId];
  const set = await j('POST', `/api/projects/${p.id}/ops/automation.set`, { trackId: tid, param: `fx:${fxid}:mid1Gain`, points: [{ time: 0, value: 0 }, { time: 2, value: 0 }, { time: 2.01, value: -18 }, { time: 6, value: -18 }] });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  const rms = async (s0, e0) => (await j('POST', `/api/projects/${p.id}/analyze`, { target: { start: s0, end: e0 }, include: ['levels'] })).data.levels.rmsDbfs;
  const before = await rms(0.5, 1.5), after = await rms(3, 4), afterFromMid = await rms(3.5, 4.5);
  assert.ok(Math.abs(before - after - 18) < 0.7, `drop ${before - after}`);
  assert.ok(Math.abs(after - afterFromMid) < 0.3, 'automation also applies when rendering starts mid-way');
  const bad = await j('POST', `/api/projects/${p.id}/ops/automation.set`, { trackId: tid, param: `fx:${fxid}:mid1Gain`, points: [{ time: 0, value: 99 }] });
  assert.equal(bad.status, 400);
  const bad2 = await j('POST', `/api/projects/${p.id}/ops/automation.set`, { trackId: tid, param: `fx:fx_00000000:mid1Gain`, points: [] });
  assert.equal(bad2.status, 400);
  await j('POST', `/api/projects/${p.id}/ops/effect.remove`, { effectId: fxid });
  const proj = (await j('GET', `/api/projects/${p.id}`)).data;
  assert.ok(!Object.keys(proj.tracks[0].automation || {}).some((k) => k.startsWith('fx:')), 'removing the effect removes its automation');
});

test('5.1 surround: panning places sound in the right speakers and exports six channels', async () => {
  const p = (await j('POST', '/api/projects', { name: 'Surround' })).data;
  const f = path.join(dir, 'sur.wav');
  tone(f, ['-f', 'lavfi', '-i', 'sine=f=1000:d=2', '-af', 'volume=2']);
  const a = await (await fetch(`${BASE}/api/projects/${p.id}/assets?name=s`, { method: 'POST', body: fs.readFileSync(f) })).json();
  const r = await j('POST', `/api/projects/${p.id}/ops`, { ops: [
    { op: 'project.setLayout', args: { layout: '5.1' } },
    { op: 'track.add', args: {} }, { op: 'clip.add', args: { trackId: '$1.trackId', assetId: a.id } },
    { op: 'track.update', args: { trackId: '$1.trackId', pan: -0.5, surroundY: 0.866 } }, // 30° left = exactly the L speaker
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const out = await j('POST', `/api/projects/${p.id}/render`, { format: 'wav', bitDepth: 32 });
  assert.equal(out.status, 201, JSON.stringify(out.data));
  const file = path.join(dir, 'sur-out.wav');
  fs.writeFileSync(file, Buffer.from(await (await fetch(BASE + out.data.url)).arrayBuffer()));
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', file]).toString()).streams[0];
  assert.equal(info.channels, 6);
  const { readWav } = await import('../server/audio.js');
  const w = await readWav(file);
  const peak = (c) => w.channels[c].reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const peaks = [0, 1, 2, 3, 4, 5].map(peak);
  assert.ok(peaks[0] > 0.2, `L ${peaks}`);
  for (const c of [1, 2, 3, 4, 5]) assert.ok(peaks[c] < 1e-3, `channel ${c} should be silent: ${peaks}`);
  // Rear right + LFE send: Rs carries the tone, LFE only a low-passed (here: strongly attenuated 1 kHz) copy.
  await j('POST', `/api/projects/${p.id}/ops/track.update`, { trackId: r.data.results[1].trackId, pan: 0.94, surroundY: -0.342, lfe: 0 });
  const mp3 = await j('POST', `/api/projects/${p.id}/render`, { format: 'mp3' });
  assert.equal(mp3.status, 201, 'MP3 folds 5.1 down to stereo');
  const out2 = await j('POST', `/api/projects/${p.id}/render`, { format: 'wav', bitDepth: 32 });
  fs.writeFileSync(file, Buffer.from(await (await fetch(BASE + out2.data.url)).arrayBuffer()));
  const w2 = await readWav(file);
  const pk = (c) => w2.channels[c].reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(pk(5) > 0.2 && pk(0) < 1e-3 && pk(1) < 1e-3, `Rs only: ${[0, 1, 2, 3, 4, 5].map(pk)}`);
  assert.ok(pk(3) > 0 && pk(3) < pk(5) / 10, `LFE is low-passed: ${pk(3)}`);
});

test('stretch a clip to an exact length, export range markers, declip, correlation', async () => {
  const p = (await j('POST', '/api/projects', { name: 'Tools' })).data;
  const f = path.join(dir, 'tools.wav');
  tone(f, ['-f', 'lavfi', '-i', 'sine=f=440:d=4', '-af', 'volume=40', '-ac', '2', '-c:a', 'pcm_s16le']); // hard-clipped stereo, identical channels
  const a = await (await fetch(`${BASE}/api/projects/${p.id}/assets?name=t`, { method: 'POST', body: fs.readFileSync(f) })).json();
  const r = await j('POST', `/api/projects/${p.id}/ops`, { ops: [
    { op: 'track.add', args: {} }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId: a.id, start: 1 } },
    { op: 'marker.add', args: { time: 1, duration: 1, label: 'Teaser' } }, { op: 'marker.add', args: { time: 3, duration: 0.5, label: 'Hook' } },
  ] });
  const clipId = r.data.results[1].clipId;
  const st = await j('POST', `/api/projects/${p.id}/clips/${clipId}/stretch`, { duration: 3 });
  assert.equal(st.status, 200, JSON.stringify(st.data));
  const c = (await j('GET', `/api/projects/${p.id}`)).data.tracks[0].clips[0];
  assert.ok(Math.abs(c.duration - 3) < 0.01 && c.start === 1, JSON.stringify(c));
  const rr = await j('POST', `/api/projects/${p.id}/render`, { format: 'wav', ranges: 'markers' });
  assert.equal(rr.status, 201, JSON.stringify(rr.data));
  assert.deepEqual(rr.data.files.map((x) => x.name), ['Tools – Teaser', 'Tools – Hook']);
  const lv = (await j('POST', `/api/projects/${p.id}/analyze`, { target: { assetId: a.id }, include: ['levels'] })).data.levels;
  assert.equal(lv.stereoCorrelation, 1);
  assert.ok(lv.clippedSamples > 1000);
  const dc = await j('POST', `/api/projects/${p.id}/assets/${a.id}/process`, { kind: 'declip' });
  assert.equal(dc.status, 201, JSON.stringify(dc.data));
});

test('clip volume envelope follows the audio when the clip moves', async () => {
  const p = (await j('POST', '/api/projects', { name: 'Env' })).data;
  const f = path.join(dir, 'env.wav');
  tone(f, ['-f', 'lavfi', '-i', 'sine=f=500:d=4', '-af', 'volume=4']);
  const a = await (await fetch(`${BASE}/api/projects/${p.id}/assets?name=e`, { method: 'POST', body: fs.readFileSync(f) })).json();
  const r = await j('POST', `/api/projects/${p.id}/ops`, { ops: [
    { op: 'track.add', args: {} }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId: a.id, start: 0 } },
    { op: 'clip.envelope', args: { clipId: '$1.clipId', points: [{ time: 2, value: 0 }, { time: 2.01, value: -20 }] } },
    { op: 'clip.update', args: { clipId: '$1.clipId', start: 5 } },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const rms = async (s0, e0) => (await j('POST', `/api/projects/${p.id}/analyze`, { target: { start: s0, end: e0 }, include: ['levels'] })).data.levels.rmsDbfs;
  const loud = await rms(5.5, 6.5), quiet = await rms(7.5, 8.5);
  assert.ok(Math.abs(loud - quiet - 20) < 0.5, `envelope moved with the clip: ${loud} vs ${quiet}`);
});

test('export metadata tags land in MP3 and WAV', async () => {
  const p = (await j('POST', '/api/projects', { name: 'Tags' })).data;
  const f = path.join(dir, 'tags.wav');
  tone(f, ['-f', 'lavfi', '-i', 'sine=f=300:d=1']);
  const a = await (await fetch(`${BASE}/api/projects/${p.id}/assets?name=t`, { method: 'POST', body: fs.readFileSync(f) })).json();
  const r = await j('POST', `/api/projects/${p.id}/ops`, { ops: [{ op: 'track.add', args: {} }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId: a.id } }, { op: 'project.setMetadata', args: { artist: 'Klang Podcast', album: 'Staffel 1', comment: 'Folge 12' } }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  for (const format of ['mp3', 'wav']) {
    const out = await j('POST', `/api/projects/${p.id}/render`, { format });
    const file = path.join(dir, `tags.${format}`);
    fs.writeFileSync(file, Buffer.from(await (await fetch(BASE + out.data.url)).arrayBuffer()));
    const tags = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', file]).toString()).format.tags || {};
    const lower = Object.fromEntries(Object.entries(tags).map(([k, v]) => [k.toLowerCase(), v]));
    assert.equal(lower.artist, 'Klang Podcast', `${format}: ${JSON.stringify(tags)}`);
    assert.equal(lower.title, 'Tags');
  }
});

test('remix fits a music clip to a length with beat-aligned jumps as editable clips', { timeout: 120_000 }, async () => {
  const p = (await j('POST', '/api/projects', { name: 'Remix' })).data;
  const f = path.join(dir, 'song.wav');
  // 120 bpm clicks over a 4-chord loop (16 s cycle), 48 s long.
  execFileSync('python3', ['-c', `
import numpy as np
from scipy.io import wavfile
sr=44100; dur=48; t=np.arange(int(sr*dur))/sr; y=np.zeros_like(t); rng=np.random.default_rng(1)
for k in range(96):
    i=int(k*0.5*sr); n=int(0.05*sr); y[i:i+n]+=(0.6 if k%4==0 else 0.3)*rng.standard_normal(n)*np.exp(-np.arange(n)/(0.01*sr))
ch=[[220,277,330],[196,247,294],[174,220,262],[196,247,294]]
for k in range(12):
    s=int(k*4*sr); e=int((k+1)*4*sr); tt=t[s:e]-t[s]
    for fq in ch[k%4]: y[s:e]+=0.08*np.sin(2*np.pi*fq*tt)
wavfile.write('${f}', sr, (y/np.abs(y).max()*0.8).astype(np.float32))`]);
  const a = await (await fetch(`${BASE}/api/projects/${p.id}/assets?name=song`, { method: 'POST', body: fs.readFileSync(f) })).json();
  const r = await j('POST', `/api/projects/${p.id}/ops`, { ops: [{ op: 'track.add', args: {} }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId: a.id } }] });
  const res = await j('POST', `/api/projects/${p.id}/clips/${r.data.results[1].clipId}/remix`, { duration: 30 });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(Math.abs(res.data.achievedSeconds - 30) < 0.6, JSON.stringify(res.data));
  const clips = (await j('GET', `/api/projects/${p.id}`)).data.tracks[0].clips;
  assert.equal(clips.length, 2);
  const end = Math.max(...clips.map((c) => c.start + c.duration));
  assert.ok(Math.abs(end - res.data.achievedSeconds) < 0.05, `timeline length ${end}`);
  assert.ok(clips[1].fadeIn > 0 && clips[0].fadeOut > 0, 'jump is crossfaded');
});

test('pitch curve shifts a voiced span by the drawn amount and leaves the rest untouched', { timeout: 120_000 }, async () => {
  const p = (await j('POST', '/api/projects', { name: 'PC' })).data;
  const f = path.join(dir, 'pc.wav');
  tone(f, ['-f', 'lavfi', '-i', 'sine=f=220:d=3:sample_rate=48000', '-af', 'volume=4']);
  const a = await (await fetch(`${BASE}/api/projects/${p.id}/assets?name=v`, { method: 'POST', body: fs.readFileSync(f) })).json();
  const r = await j('POST', `/api/projects/${p.id}/assets/${a.id}/pitch-curve`, { points: [{ time: 0.9, cents: 0 }, { time: 1.0, cents: 1200 }, { time: 2.0, cents: 1200 }, { time: 2.1, cents: 0 }] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const cent = async (s0, e0) => (await j('POST', `/api/projects/${p.id}/analyze`, { target: { assetId: r.data.asset.id, start: s0, end: e0 }, include: ['spectrum'] })).data.spectrum.spectralCentroidHz;
  const shifted = await cent(1.2, 1.8), untouched = await cent(2.4, 2.9);
  assert.ok(Math.abs(shifted - 440) < 40, `shifted span centroid ${shifted}`);
  assert.ok(Math.abs(untouched - 220) < 20, `untouched span centroid ${untouched}`);
});

test('generate: tone at the right frequency and level, speech via TTS placed on a track', async () => {
  const p = (await j('POST', '/api/projects', { name: 'Gen' })).data;
  const t = await j('POST', `/api/projects/${p.id}/generate`, { kind: 'tone', frequency: 1000, level: -12, duration: 1 });
  assert.equal(t.status, 201, JSON.stringify(t.data));
  const a = (await j('POST', `/api/projects/${p.id}/analyze`, { target: { assetId: t.data.asset.id }, include: ['levels', 'spectrum'] })).data;
  assert.ok(Math.abs(a.levels.samplePeakDbfs + 12) < 0.2, JSON.stringify(a.levels));
  assert.ok(Math.abs(a.spectrum.spectralCentroidHz - 1000) < 30);
  const voices = (await j('GET', '/api/voices')).data;
  if (!voices.length) return;
  const s = await j('POST', `/api/projects/${p.id}/generate`, { kind: 'speech', text: 'Hallo und willkommen.', voice: voices.find((v) => v.startsWith('de_')) || voices[0], place: { start: 1 } });
  assert.equal(s.status, 201, JSON.stringify(s.data));
  assert.ok(s.data.asset.duration > 0.5 && s.data.clipId);
});

test('looping clips repeat their source; studio effects (channel mixer, phase shifter, 30-band EQ, convolution IR)', async () => {
  const p = (await j('POST', '/api/projects', { name: 'Studio' })).data;
  const f = path.join(dir, 'beep.wav'), irf = path.join(dir, 'ir.wav');
  tone(f, ['-f', 'lavfi', '-i', 'sine=f=1000:d=0.5', '-af', 'volume=4,afade=t=out:st=0.25:d=0.25', '-ac', '2']);
  tone(irf, ['-f', 'lavfi', '-i', 'anoisesrc=d=1:c=white:a=0.5', '-af', "volume='exp(-6*t)':eval=frame"]);
  const up = async (file, n) => (await fetch(`${BASE}/api/projects/${p.id}/assets?name=${n}`, { method: 'POST', body: fs.readFileSync(file) })).json();
  const a = await up(f, 'beep'), ir = await up(irf, 'room');
  const r = await j('POST', `/api/projects/${p.id}/ops`, { ops: [
    { op: 'track.add', args: {} }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId: a.id, loop: true, duration: 2 } },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const env = (await j('POST', `/api/projects/${p.id}/analyze`, { include: ['envelope'], envelopeStep: 0.125 })).data.envelope.rmsDbfs;
  // Each 0.5 s repeat starts loud and fades: the 4 repeats have the same shape.
  assert.ok(Math.abs(env[0] - env[4]) < 0.5 && Math.abs(env[0] - env[12]) < 0.5 && env[0] - env[3] > 6, JSON.stringify(env));
  const t = r.data.results[0].trackId;
  const fx = await j('POST', `/api/projects/${p.id}/ops`, { ops: [
    { op: 'effect.add', args: { trackId: t, type: 'channelmixer', params: { lFromL: 0, rFromR: 0 } } },
  ] });
  assert.equal(fx.status, 200, JSON.stringify(fx.data));
  const silent = (await j('POST', `/api/projects/${p.id}/analyze`, { include: ['levels'] })).data.levels.samplePeakDbfs;
  assert.ok(silent < -90, `channel mixer with zero gains is silent: ${silent}`);
  await j('POST', `/api/projects/${p.id}/ops/effect.remove`, { effectId: fx.data.results[0].effectId });
  const dry = (await j('POST', `/api/projects/${p.id}/analyze`, { include: ['levels'] })).data.levels.rmsDbfs;
  const eq = await j('POST', `/api/projects/${p.id}/ops/effect.add`, { trackId: t, type: 'graphiceq30', params: { g1k: -12 } });
  assert.equal(eq.status, 200, JSON.stringify(eq.data));
  const cut = (await j('POST', `/api/projects/${p.id}/analyze`, { include: ['levels'] })).data.levels.rmsDbfs;
  assert.ok(dry - cut > 9, `30-band EQ cuts 1 kHz: ${dry} → ${cut}`);
  await j('POST', `/api/projects/${p.id}/ops/effect.remove`, { effectId: eq.data.effectId });
  const psh = await j('POST', `/api/projects/${p.id}/ops/effect.add`, { trackId: t, type: 'phaseshift', params: { frequency: 1000, stages: 1 } }); // one stage = 180° at the tone frequency
  const ph = (await j('POST', `/api/projects/${p.id}/analyze`, { include: ['levels'] })).data.levels;
  assert.ok(Math.abs(ph.rmsDbfs - dry) < 0.3 && ph.stereoCorrelation < -0.9, `phase shifter keeps level, changes phase: ${JSON.stringify(ph)}`);
  await j('POST', `/api/projects/${p.id}/ops/effect.remove`, { effectId: psh.data.effectId });
  const bad = await j('POST', `/api/projects/${p.id}/ops/effect.add`, { trackId: t, type: 'convolution', params: { ir: '../x' } });
  assert.equal(bad.status, 400);
  // One beep followed by silence: without reverb the silence is digital silence, with the IR it rings.
  await j('POST', `/api/projects/${p.id}/ops/clip.update`, { clipId: r.data.results[1].clipId, loop: false, duration: 0.5 });
  const quiet = async () => (await j('POST', `/api/projects/${p.id}/analyze`, { target: { start: 0.6, end: 0.9 }, include: ['levels'] })).data.levels.rmsDbfs;
  const dryTail = await quiet();
  const conv = await j('POST', `/api/projects/${p.id}/ops/effect.add`, { trackId: t, type: 'convolution', params: { ir: ir.id, mix: 1 } });
  assert.equal(conv.status, 200, JSON.stringify(conv.data));
  const wetTail = await quiet();
  assert.ok(dryTail < -100 && wetTail > -60, `reverb rings after the beep: ${dryTail} → ${wetTail}`);
});

test('every built-in preset applies and renders cleanly', async () => {
  const { PRESETS } = await import('../public/js/engine/presets.js');
  const p = (await j('POST', '/api/projects', { name: 'Presets' })).data;
  const f = path.join(dir, 'pre.wav');
  tone(f, ['-f', 'lavfi', '-i', 'sine=f=220:d=2', '-af', 'volume=4']);
  const a = await (await fetch(`${BASE}/api/projects/${p.id}/assets?name=p`, { method: 'POST', body: fs.readFileSync(f) })).json();
  for (const [id, preset] of Object.entries(PRESETS)) {
    const r = await j('POST', `/api/projects/${p.id}/ops`, { ops: [
      { op: 'track.add', args: {} }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId: a.id } },
      { op: 'preset.apply', args: preset.target === 'track' ? { trackId: '$0.trackId', preset: id } : { preset: id } },
    ] });
    assert.equal(r.status, 200, `${id}: ${JSON.stringify(r.data)}`);
    const lv = (await j('POST', `/api/projects/${p.id}/analyze`, { include: ['levels'] })).data.levels;
    assert.ok(lv.samplePeakDbfs > -60 && lv.samplePeakDbfs < 6, `${id}: peak ${lv.samplePeakDbfs}`);
    await j('POST', `/api/projects/${p.id}/undo`);
  }
});

test('varispeed clips change speed and pitch together; stacking lets the upper clip cover the lower', async () => {
  const p = (await j('POST', '/api/projects', { name: 'Vari' })).data;
  const f = path.join(dir, 'vari.wav'), g = path.join(dir, 'vari2.wav');
  tone(f, ['-f', 'lavfi', '-i', 'sine=f=440:d=4', '-af', 'volume=4']);
  tone(g, ['-f', 'lavfi', '-i', 'sine=f=1000:d=4', '-af', 'volume=4']);
  const up = async (file, n) => (await fetch(`${BASE}/api/projects/${p.id}/assets?name=${n}`, { method: 'POST', body: fs.readFileSync(file) })).json();
  const a = await up(f, 'a'), b = await up(g, 'b');
  const r = await j('POST', `/api/projects/${p.id}/ops`, { ops: [{ op: 'track.add', args: {} }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId: a.id } }, { op: 'clip.update', args: { clipId: '$1.clipId', rate: 2 } }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let proj = (await j('GET', `/api/projects/${p.id}`)).data;
  assert.equal(proj.tracks[0].clips[0].duration, 2, 'twice as fast → half as long');
  const an = (await j('POST', `/api/projects/${p.id}/analyze`, { include: ['spectrum'] })).data;
  assert.ok(Math.abs(an.spectrum.spectralCentroidHz - 880) < 25 && Math.abs(an.duration - 2) < 0.01, JSON.stringify(an.spectrum));
  // Split a varispeed clip: halves stay contiguous in the source.
  await j('POST', `/api/projects/${p.id}/ops/clip.split`, { clipId: proj.tracks[0].clips[0].id, at: 1 });
  proj = (await j('GET', `/api/projects/${p.id}`)).data;
  assert.equal(proj.tracks[0].clips[1].offset, 2);
  // Stacking: a 1 kHz clip placed over the middle (no crossfade) covers the 880 Hz material there.
  const t = proj.tracks[0].id;
  await j('POST', `/api/projects/${p.id}/ops/clip.add`, { trackId: t, assetId: b.id, start: 0.5, duration: 1, crossfade: false });
  const mid = (await j('POST', `/api/projects/${p.id}/analyze`, { target: { start: 0.7, end: 1.3 }, include: ['spectrum', 'levels'] })).data;
  assert.ok(Math.abs(mid.spectrum.spectralCentroidHz - 1000) < 25, `upper clip covers: ${mid.spectrum.spectralCentroidHz}`);
  const proj2 = (await j('GET', `/api/projects/${p.id}`)).data;
  const lower = proj2.tracks[0].clips.find((c) => c.assetId === a.id && c.start === 0);
  await j('POST', `/api/projects/${p.id}/ops/clip.update`, { clipId: lower.id, z: 5 });
  const mid2 = (await j('POST', `/api/projects/${p.id}/analyze`, { target: { start: 0.7, end: 0.95 }, include: ['spectrum'] })).data;
  assert.ok(Math.abs(mid2.spectrum.spectralCentroidHz - 880) < 25, `bring to front: ${mid2.spectrum.spectralCentroidHz}`);
});

test('analyze honours start/end at the top level (REST and MCP) and rejects unknown fields', async () => {
  const p = (await j('POST', '/api/projects', { name: 'Range analyze' })).data;
  const f = path.join(dir, 'ra.wav');
  // 0–3 s quiet, 3–6 s loud.
  tone(f, ['-f', 'lavfi', '-i', 'sine=f=500:d=6', '-af', "volume='if(lt(t,3),0.05,1)':eval=frame"]);
  const a = await (await fetch(`${BASE}/api/projects/${p.id}/assets?name=r`, { method: 'POST', body: fs.readFileSync(f) })).json();
  await j('POST', `/api/projects/${p.id}/ops`, { ops: [{ op: 'track.add', args: {} }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId: a.id } }] });
  const top = (await j('POST', `/api/projects/${p.id}/analyze`, { start: 3.5, end: 5.5, include: ['levels'] })).data;
  const inTarget = (await j('POST', `/api/projects/${p.id}/analyze`, { target: { start: 3.5, end: 5.5 }, include: ['levels'] })).data;
  assert.equal(top.duration, 2, 'only the range is measured');
  assert.deepEqual([top.start, top.end], [3.5, 5.5], 'reported in timeline seconds');
  assert.equal(top.levels.rmsDbfs, inTarget.levels.rmsDbfs);
  const quiet = (await j('POST', `/api/projects/${p.id}/analyze`, { start: 0.5, end: 2.5, include: ['levels'] })).data;
  assert.ok(top.levels.rmsDbfs - quiet.levels.rmsDbfs > 20);
  const bad = await j('POST', `/api/projects/${p.id}/analyze`, { from: 3, to: 4 });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error.message, /unknown field "from"/);
  const mcp = await j('POST', '/mcp', { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'analyze', arguments: { projectId: p.id, start: 3.5, end: 5.5, include: ['levels'] } } });
  assert.equal(JSON.parse(mcp.data.result.content[0].text).duration, 2);
  const mbad = await j('POST', '/mcp', { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'analyze', arguments: { projectId: p.id, startTime: 3 } } });
  assert.equal(mbad.data.result.isError, true);
});

test('silences that reach the end are clamped to the exact end; cuts leave no slivers', async () => {
  const p = (await j('POST', '/api/projects', { name: 'Sliver' })).data;
  const f = path.join(dir, 'sliver.wav');
  // 1.0 s tone then 0.997 s of silence: the material ends off the 10 ms grid.
  execFileSync('python3', ['-c', `
import numpy as np; from scipy.io import wavfile
sr=48000; t=np.arange(int(sr*1.0))/sr; y=np.concatenate([0.5*np.sin(2*np.pi*440*t), np.zeros(int(sr*0.997))])
wavfile.write('${f}', sr, y.astype(np.float32))`]);
  const a = await (await fetch(`${BASE}/api/projects/${p.id}/assets?name=s`, { method: 'POST', body: fs.readFileSync(f) })).json();
  const r = await j('POST', `/api/projects/${p.id}/ops`, { ops: [{ op: 'track.add', args: {} }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId: a.id } }] });
  const an = (await j('POST', `/api/projects/${p.id}/analyze`, { target: { clipId: r.data.results[1].clipId }, include: ['silences'], minSilence: 0.3 })).data;
  const last = an.silencesTimeline.at(-1);
  assert.equal(last.end, 1.997, JSON.stringify(an.silencesTimeline));
  // Cut ending 5 ms before the clip end: the 5 ms remnant goes too.
  await j('POST', `/api/projects/${p.id}/ops/range.delete`, { start: 1.2, end: 1.992, ripple: false });
  const clips = (await j('GET', `/api/projects/${p.id}`)).data.tracks[0].clips;
  assert.equal(clips.length, 1, JSON.stringify(clips.map((c) => [c.start, c.duration])));
  assert.ok(Math.abs(clips[0].duration - 1.2) < 1e-6);
});
