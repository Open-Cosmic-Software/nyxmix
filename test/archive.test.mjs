import { freePort } from './helpers.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klang-archive-'));
let server;
const j = async (method, url, body) => {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
};

before(async () => {
  server = spawn('node', ['server/index.js'], { env: { ...process.env, PORT, KLANG_DATA: path.join(dir, 'data') }, stdio: 'pipe' });
  for (let i = 0; i < 200; i++) { try { await fetch(BASE + '/api'); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  throw new Error('server did not start');
});
after(() => { server.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('archive round trip keeps arrangement and audio bit-exact', async () => {
  const p = (await j('POST', '/api/projects', { name: 'Round trip' })).data;
  const f = path.join(dir, 'a.wav');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=330:d=3', f]);
  const a = await (await fetch(`${BASE}/api/projects/${p.id}/assets?name=a`, { method: 'POST', body: fs.readFileSync(f) })).json();
  await j('POST', `/api/projects/${p.id}/ops`, { ops: [{ op: 'track.add', args: { name: 'T' } }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId: a.id, start: 1.5 } }, { op: 'marker.add', args: { time: 2, label: 'here' } }] });
  const tar = Buffer.from(await (await fetch(`${BASE}/api/projects/${p.id}/archive`)).arrayBuffer());
  assert.ok(tar.length > 3 * 48000 * 4);
  const imp = await fetch(`${BASE}/api/projects/import`, { method: 'POST', body: tar, headers: { 'Content-Type': 'application/x-tar' } });
  assert.equal(imp.status, 201, await imp.clone().text());
  const { id } = await imp.json();
  assert.notEqual(id, p.id);
  const q = (await j('GET', `/api/projects/${id}`)).data;
  assert.equal(q.name, 'Round trip');
  assert.equal(q.tracks[0].clips[0].start, 1.5);
  assert.equal(q.markers[0].label, 'here');
  const orig = Buffer.from(await (await fetch(`${BASE}/api/projects/${p.id}/assets/${a.id}/audio`)).arrayBuffer());
  const copy = Buffer.from(await (await fetch(`${BASE}/api/projects/${id}/assets/${a.id}/audio`)).arrayBuffer());
  assert.ok(orig.equals(copy), 'audio must be identical');
  const r = await j('POST', `/api/projects/${id}/render`, { format: 'wav' });
  assert.equal(r.status, 201);
});

test('import rejects path traversal and junk', async () => {
  const bad = Buffer.alloc(2048);
  bad.write('../../evil.txt', 0);
  bad.write('0000005\0', 124); bad.write('0', 156);
  const r = await fetch(`${BASE}/api/projects/import`, { method: 'POST', body: bad });
  assert.equal(r.status, 400);
  const before = fs.readdirSync(path.join(dir, 'data', 'projects')).length;
  const junk = await fetch(`${BASE}/api/projects/import`, { method: 'POST', body: Buffer.from('hello') });
  assert.equal(junk.status, 400);
  assert.equal(fs.readdirSync(path.join(dir, 'data', 'projects')).length, before, 'failed imports leave nothing behind');
  assert.ok(!fs.existsSync(path.join(dir, 'evil.txt')) && !fs.existsSync(path.join(dir, 'data', 'evil.txt')));
});

test('user presets: save a chain, apply it elsewhere, delete it', async () => {
  const a = (await j('POST', '/api/projects', { name: 'P1' })).data, b = (await j('POST', '/api/projects', { name: 'P2' })).data;
  const t = (await j('POST', `/api/projects/${a.id}/ops`, { ops: [{ op: 'track.add', args: {} }, { op: 'preset.apply', args: { trackId: '$0.trackId', preset: 'podcast-voice' } }] })).data.results[0].trackId;
  const saved = await j('POST', '/api/presets/user', { projectId: a.id, trackId: t, name: 'My voice' });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const t2 = (await j('POST', `/api/projects/${b.id}/ops`, { ops: [{ op: 'track.add', args: {} }] })).data.results[0].trackId;
  const ap = await j('POST', `/api/projects/${b.id}/presets/user/${saved.data.id}/apply`, { trackId: t2 });
  assert.equal(ap.status, 200, JSON.stringify(ap.data));
  const pb = (await j('GET', `/api/projects/${b.id}`)).data;
  assert.deepEqual(pb.tracks[0].effects.map((e) => e.type), ['eq', 'deesser', 'compressor']);
  assert.equal(pb.tracks[0].effects[0].params.hpFreq, 80);
  assert.equal((await fetch(`${BASE}/api/presets/user/${saved.data.id}`, { method: 'DELETE' })).status, 204);
});

test('archive with a clip pointing outside the session is refused', async () => {
  const proj = { name: 'Evil', sampleRate: 48000, assets: [], markers: [], master: { gain: 0, effects: [] }, tracks: [{ id: 'trk_1', clips: [{ id: 'clp_1', assetId: '../../../../tmp/x', start: 0, offset: 0, duration: 1 }], effects: [] }] };
  const body = Buffer.from(JSON.stringify(proj));
  const h = Buffer.alloc(512);
  h.write('project.json', 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(body.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.write('        ', 148); h.write('0', 156);
  let sum = 0; for (const b of h) sum += b; h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const tar = Buffer.concat([h, body, Buffer.alloc(512 - (body.length % 512)), Buffer.alloc(1024)]);
  const r = await fetch(`${BASE}/api/projects/import`, { method: 'POST', body: tar });
  assert.equal(r.status, 400, await r.text());
});

test('convert session sample rate keeps timing and pitch', async () => {
  const p = (await j('POST', '/api/projects', { name: 'SR', sampleRate: 48000 })).data;
  const f = path.join(dir, 'sr.wav');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=1000:d=2:sample_rate=48000', f]);
  const a = await (await fetch(`${BASE}/api/projects/${p.id}/assets?name=t`, { method: 'POST', body: fs.readFileSync(f) })).json();
  await j('POST', `/api/projects/${p.id}/ops`, { ops: [{ op: 'track.add', args: {} }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId: a.id, start: 1 } }] });
  const r = await j('POST', `/api/projects/${p.id}/sample-rate`, { sampleRate: 96000 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const q = (await j('GET', `/api/projects/${p.id}`)).data;
  assert.equal(q.sampleRate, 96000);
  const an = (await j('POST', `/api/projects/${p.id}/analyze`, { include: ['spectrum', 'silences'] })).data;
  assert.equal(an.sampleRate, 96000);
  assert.ok(Math.abs(an.spectrum.spectralCentroidHz - 1000) < 30, `pitch kept: ${an.spectrum.spectralCentroidHz}`);
  assert.ok(Math.abs(an.duration - 3) < 0.01, `timing kept: ${an.duration}`);
});

test('saving never collides: many edits while archiving', async () => {
  const p = (await j('POST', '/api/projects', { name: 'Race' })).data;
  const edits = Array.from({ length: 30 }, (_, i) => j('POST', `/api/projects/${p.id}/ops/project.rename`, { name: `Race ${i}` }));
  const archives = Array.from({ length: 10 }, () => fetch(`${BASE}/api/projects/${p.id}/archive`).then((r) => r.status));
  const results = await Promise.all([...edits.map((x) => x.then((r) => r.status)), ...archives]);
  assert.ok(results.every((s) => s === 200), JSON.stringify(results));
  await new Promise((r) => setTimeout(r, 300));
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'projects', p.id, 'project.json'), 'utf8'));
  assert.equal(disk.name, (await j('GET', `/api/projects/${p.id}`)).data.name);
  assert.equal(fs.readdirSync(path.join(dir, 'data', 'projects', p.id)).filter((f) => f.endsWith('.tmp')).length, 0);
});

test('CD image: 44.1 kHz/16-bit WAV and a CUE sheet with tracks at the markers', async () => {
  const p = (await j('POST', '/api/projects', { name: 'Album' })).data;
  const f = path.join(dir, 'cd.wav');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=330:d=20:sample_rate=48000', f]);
  const a = await (await fetch(`${BASE}/api/projects/${p.id}/assets?name=t`, { method: 'POST', body: fs.readFileSync(f) })).json();
  await j('POST', `/api/projects/${p.id}/ops`, { ops: [
    { op: 'track.add', args: {} }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId: a.id } },
    { op: 'marker.add', args: { time: 0, label: 'Opening' } }, { op: 'marker.add', args: { time: 8.5, label: 'Second song' } },
    { op: 'marker.add', args: { time: 10, label: 'too close' } }, { op: 'marker.add', args: { time: 15, label: 'Finale' } },
  ] });
  const r = await j('POST', `/api/projects/${p.id}/cd`, {});
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual(r.data.tracks.map((t) => t.title), ['Opening', 'Second song', 'Finale']);
  const cue = await (await fetch(BASE + r.data.cue.url)).text();
  assert.match(cue, /TRACK 02 AUDIO\r\n    TITLE "Second song"\r\n    INDEX 01 00:08:38/);
  const wav = path.join(dir, 'cd-out.wav');
  fs.writeFileSync(wav, Buffer.from(await (await fetch(BASE + r.data.wav.url)).arrayBuffer()));
  const s = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', wav]).toString()).streams[0];
  assert.equal(+s.sample_rate, 44100); assert.equal(s.codec_name, 'pcm_s16le'); assert.equal(s.channels, 2);
});
