import { freePort } from './helpers.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klang-video-'));
let server, pid, meta;
const j = async (method, url, body) => {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
};
const mcp = async (name, args) => (await j('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).data.result;

before(async () => {
  server = spawn('node', ['server/index.js'], { env: { ...process.env, PORT, KLANG_DATA: path.join(dir, 'data') }, stdio: 'pipe' });
  for (let i = 0; i < 200; i++) { try { await fetch(BASE + '/api'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  // 4 s test video: test pattern for 2 s, then a hard cut to solid blue; 440 Hz tone throughout.
  const src = path.join(dir, 'clip.mov');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=2', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=25:d=2', '-f', 'lavfi', '-i', 'sine=f=440:d=4',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac', '-shortest', src]);
  pid = (await j('POST', '/api/projects', { name: 'Video' })).data.id;
  const res = await fetch(`${BASE}/api/projects/${pid}/video?name=clip.mov&place=1&offset=1`, { method: 'POST', body: fs.readFileSync(src) });
  meta = await res.json();
  assert.equal(res.status, 201, JSON.stringify(meta));
});
after(() => { server?.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('import stores metadata, places the soundtrack and makes a playable proxy', async () => {
  assert.match(meta.videoId, /^vid_[a-f0-9]{8}$/);
  assert.equal(meta.width, 640); assert.equal(meta.height, 360); assert.equal(meta.fps, 25);
  assert.ok(Math.abs(meta.duration - 4) < 0.1, `duration ${meta.duration}`);
  assert.equal(meta.offset, 1);
  const p = (await j('GET', `/api/projects/${pid}`)).data;
  assert.ok(p.assets.some((a) => a.id === meta.audioAssetId), 'soundtrack in the bin');
  const track = p.tracks.find((t) => t.name === 'Video sound');
  assert.ok(track, 'Video sound track added');
  assert.equal(track.clips[0].assetId, meta.audioAssetId);
  assert.equal(track.clips[0].start, 1);
  assert.equal(p.tracks.length, 1);

  const g = await j('GET', `/api/projects/${pid}/video`);
  assert.equal(g.status, 200); assert.equal(g.data.videoId, meta.videoId);
  assert.ok(!('audioAssetId' in p), 'core project schema untouched');

  const proxy = path.join(dir, 'proxy.mp4');
  const r = await fetch(`${BASE}/api/projects/${pid}/video/proxy`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  fs.writeFileSync(proxy, Buffer.from(await r.arrayBuffer()));
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', proxy]).toString());
  const v = info.streams.find((s) => s.codec_type === 'video');
  assert.equal(v.codec_name, 'h264');
  assert.ok(v.height <= 720);
  assert.match(info.format.format_name, /mp4/);
  // fast-start: moov before mdat
  const buf = fs.readFileSync(proxy);
  assert.ok(buf.indexOf('moov') < buf.indexOf('mdat'), 'moov atom first');
  const keys = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', proxy]).toString().trim().split('\n').map(Number);
  assert.ok(keys.length >= 4, `keyframe every second, got ${keys}`);

  const range = await fetch(`${BASE}/api/projects/${pid}/video/proxy`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 100);
});

test('filmstrip sprite and index', async () => {
  const ix = (await j('GET', `/api/projects/${pid}/video/filmstrip.json`)).data;
  assert.equal(ix.count, 2); assert.equal(ix.interval, 2); assert.equal(ix.tileHeight, 160);
  const r = await fetch(`${BASE}/api/projects/${pid}/video/filmstrip.jpg`);
  assert.equal(r.status, 200);
  const b = Buffer.from(await r.arrayBuffer());
  assert.equal(b[0], 0xff); assert.equal(b[1], 0xd8);
});

test('MCP: get_video, video_frame, detect_scene_changes, set_video_offset', async () => {
  const list = (await j('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).data.result.tools.map((t) => t.name);
  for (const n of ['import_video', 'get_video', 'video_frame', 'set_video_offset', 'detect_scene_changes']) assert.ok(list.includes(n), n);

  const gv = await mcp('get_video', { projectId: pid });
  assert.equal(JSON.parse(gv.content[0].text).videoId, meta.videoId);

  // Timeline 4.0 = video 3.0 → after the cut: solid blue.
  const fr = await mcp('video_frame', { projectId: pid, time: 4, width: 320 });
  assert.ok(!fr.isError, JSON.stringify(fr));
  assert.equal(fr.content[0].type, 'image');
  assert.equal(fr.content[0].mimeType, 'image/jpeg');
  const jpg = path.join(dir, 'f.jpg');
  fs.writeFileSync(jpg, Buffer.from(fr.content[0].data, 'base64'));
  const px = execFileSync('ffmpeg', ['-v', 'error', '-i', jpg, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  assert.ok(px[2] > 180 && px[0] < 60 && px[1] < 60, `expected blue, got ${[...px]}`);
  const out = await mcp('video_frame', { projectId: pid, time: 0.5 });
  assert.ok(out.isError, 'before the video starts there is no picture');

  const sc = JSON.parse((await mcp('detect_scene_changes', { projectId: pid })).content[0].text);
  assert.equal(sc.changes.length, 1, JSON.stringify(sc));
  assert.ok(Math.abs(sc.changes[0].time - 3) < 0.1, `cut at video 2 s = timeline 3 s, got ${sc.changes[0].time}`);

  const so = JSON.parse((await mcp('set_video_offset', { projectId: pid, offset: 2.5 })).content[0].text);
  assert.equal(so.offset, 2.5);
  assert.equal((await j('GET', `/api/projects/${pid}/video`)).data.offset, 2.5);
});

test('REST offset PATCH validates input', async () => {
  const ok = await j('PATCH', `/api/projects/${pid}/video`, { offset: 0.75 });
  assert.equal(ok.status, 200); assert.equal(ok.data.offset, 0.75);
  assert.equal((await j('PATCH', `/api/projects/${pid}/video`, { offset: -1 })).status, 400);
  assert.equal((await j('PATCH', `/api/projects/${pid}/video`, { offset: 'x' })).status, 400);
  const frame = await fetch(`${BASE}/api/projects/${pid}/video/frame.jpg?time=1`);
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get('content-type'), 'image/jpeg');
});

test('path traversal and bad ids are rejected', async () => {
  for (const u of [
    `/api/projects/..%2F..%2Fetc/video`,
    `/api/projects/${pid}/video/..%2F..%2Fproject.json`,
    `/api/projects/${pid}/video/..%2Fvideo.json`,
    `/api/projects/${pid}/video/filmstrip.jpg%00.json`,
  ]) {
    const r = await fetch(BASE + u);
    assert.ok([400, 404].includes(r.status), `${u} → ${r.status}`);
    assert.doesNotMatch(await r.text(), /"tracks"|"videoId"/);
  }
  // A tampered video.json cannot point the file routes outside the video folder.
  const other = (await j('POST', '/api/projects', { name: 'Tampered' })).data.id;
  const pdir = path.join(dir, 'data', 'projects', other);
  fs.writeFileSync(path.join(pdir, 'video.json'), JSON.stringify({ videoId: '../project', offset: 0, duration: 1 }));
  for (const f of ['proxy', 'filmstrip.json']) assert.equal((await fetch(`${BASE}/api/projects/${other}/video/${f}`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/projects/${other}/video`)).status, 404);
  // Non-video upload is refused and leaves nothing behind.
  const bad = await fetch(`${BASE}/api/projects/${other}/video?name=x.mp4`, { method: 'POST', body: Buffer.from('not a video') });
  assert.equal(bad.status, 415);
  assert.deepEqual(fs.readdirSync(path.join(pdir, 'video')), []);
});

test('delete removes the video but keeps the soundtrack asset', async () => {
  assert.equal((await fetch(`${BASE}/api/projects/${pid}/video`, { method: 'DELETE' })).status, 204);
  assert.equal((await j('GET', `/api/projects/${pid}/video`)).status, 404);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'data', 'projects', pid, 'video')), []);
  assert.ok((await j('GET', `/api/projects/${pid}`)).data.assets.some((a) => a.id === meta.audioAssetId));
});
