// Video to cut audio against (Audition's video panel + video track).
// One reference video per session, kept outside the core project document:
//   <projectDir>/video.json                 { videoId, name, duration, width, height, fps, offset, audioAssetId, proxyCodec }
//   <projectDir>/video/<videoId>.<ext>      the original upload
//   <projectDir>/video/<videoId>.proxy.mp4  browser proxy (H.264, ≤720p, fast-start, keyframe every second)
//   <projectDir>/video/<videoId>.strip.jpg  filmstrip sprite + .strip.json index
// The soundtrack is extracted into the bin as an ordinary asset (and optionally placed).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns/promises';
import { lookup as dnsLookup } from 'node:dns';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import busboy from 'busboy';
import { newId } from '../ops.js';
import { run } from '../audio.js';

const MAX_VIDEO_BYTES = 8 * 1024 ** 3;
const STRIP_H = 160;
const MAX_STRIP_FRAMES = 600;
const VIDEO_ID = /^vid_[a-f0-9]{8}$/;
const ffmpeg = (args, opts) => run('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args], opts);
const r3 = (x) => Math.round(x * 1000) / 1000;

// Best available browser-playable encoder, probed once.
let encoderInfo;
async function pickEncoder() {
  if (encoderInfo) return encoderInfo;
  let list = '';
  try { list = (await run('ffmpeg', ['-hide_banner', '-encoders'])).stdout.toString(); } catch {}
  const has = (n) => new RegExp(`^\\s*V\\S*\\s+${n}\\s`, 'm').test(list);
  if (has('libx264')) encoderInfo = { codec: 'libx264', args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high', '-pix_fmt', 'yuv420p'] };
  else if (has('libopenh264')) encoderInfo = { codec: 'libopenh264', args: ['-c:v', 'libopenh264', '-b:v', '2500k', '-pix_fmt', 'yuv420p'], note: 'libx264 missing: proxy encoded with libopenh264 (H.264, constant bitrate)' };
  else encoderInfo = { codec: 'mpeg4', args: ['-c:v', 'mpeg4', '-q:v', '4', '-pix_fmt', 'yuv420p'], note: 'No H.264 encoder in this ffmpeg build: proxy is MPEG-4 Part 2, which most browsers cannot play' };
  return encoderInfo;
}

// ── SSRF-safe download (same rules as asset URL import in actions.js) ─────
function isPrivate(ip) {
  if (ip.includes(':')) {
    const l = ip.toLowerCase();
    if (l.startsWith('::ffff:')) return isPrivate(l.slice(7));
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
const allowPrivate = () => process.env.KLANG_ALLOW_PRIVATE_URLS === '1';

export async function register({ api, json, wrap, store, actions, mcpTools, actorOf, OpError }) {
  const forbidden = () => new OpError('URL points to a private or local address; refusing to fetch it', 'forbidden_url', 403);
  async function assertPublicHost(host) {
    if (allowPrivate()) return;
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
    if (!addrs.length) throw new OpError(`Cannot resolve ${host}`, 'fetch_failed', 422);
    if (addrs.some(({ address }) => isPrivate(address))) throw forbidden();
  }
  function publicLookup(hostname, options, cb) {
    dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      if (!allowPrivate() && addrs.some(({ address }) => isPrivate(address))) return cb(forbidden());
      if (options.all) cb(null, addrs); else cb(null, addrs[0].address, addrs[0].family);
    });
  }
  async function openUrl(url, hops = 0) {
    let u;
    try { u = new URL(url); } catch { throw new OpError('url is not a valid URL', 'invalid_args', 400); }
    if (!/^https?:$/.test(u.protocol)) throw new OpError('Only http(s) URLs can be imported', 'invalid_args', 400);
    await assertPublicHost(u.hostname);
    const res = await new Promise((resolve, reject) => {
      const req = (u.protocol === 'https:' ? https : http).get(u, { lookup: publicLookup }, resolve);
      req.setTimeout(300_000, () => req.destroy(new OpError('Download timed out', 'fetch_failed', 422)));
      req.on('error', (e) => reject(e instanceof OpError ? e : new OpError(`Fetching ${url} failed: ${e.message}`, 'fetch_failed', 422)));
    });
    if (res.statusCode >= 300 && res.statusCode < 400) {
      res.resume();
      if (!res.headers.location || hops > 3) throw new OpError('Too many redirects', 'fetch_failed', 422);
      return openUrl(new URL(res.headers.location, u).href, hops + 1);
    }
    if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); throw new OpError(`Fetching ${url} failed: HTTP ${res.statusCode}`, 'fetch_failed', 422); }
    return { stream: res, filename: decodeURIComponent(u.pathname.split('/').pop() || 'video') };
  }

  // ── storage ─────────────────────────────────────────────────────────────
  const pdir = (pid) => { store.get(pid); return store.projectDir(pid); };
  const vdir = (pid) => path.join(pdir(pid), 'video');
  const metaFile = (pid) => path.join(pdir(pid), 'video.json');
  const file = (pid, vid, suffix) => {
    if (!VIDEO_ID.test(vid)) throw new OpError('Invalid video id', 'invalid_args', 400);
    return path.join(vdir(pid), vid + suffix);
  };
  function load(pid) {
    try {
      const v = JSON.parse(fs.readFileSync(metaFile(pid), 'utf8'));
      return v && VIDEO_ID.test(v.videoId) ? v : null;
    } catch (e) { if (e instanceof OpError) throw e; return null; }
  }
  const need = (pid) => { const v = load(pid); if (!v) throw new OpError('This session has no video', 'not_found', 404); return v; };
  async function save(pid, v) {
    const tmp = metaFile(pid) + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(v, null, 2));
    await fsp.rename(tmp, metaFile(pid));
    store.notify(pid, { type: 'video', video: v });
    return v;
  }
  async function removeFiles(pid, vid) {
    const dir = vdir(pid);
    for (const f of await fsp.readdir(dir).catch(() => [])) if (f.startsWith(vid + '.')) await fsp.rm(path.join(dir, f), { force: true });
  }

  async function writeUpload(stream, dest) {
    let bytes = 0;
    await pipeline(stream, async function* (src) {
      for await (const chunk of src) {
        bytes += chunk.length;
        if (bytes > MAX_VIDEO_BYTES) throw new OpError('Video larger than 8 GB', 'too_large', 413);
        yield chunk;
      }
    }, fs.createWriteStream(dest));
    if (!bytes) throw new OpError('Empty upload', 'empty', 400);
  }

  async function probeVideo(src) {
    let info;
    try { info = JSON.parse((await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', src])).stdout.toString()); }
    catch { throw new OpError('Not a readable media file', 'unsupported', 415); }
    const v = (info.streams || []).find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
    if (!v) throw new OpError('No video stream found in file', 'no_video', 415);
    const [n, d] = String(v.avg_frame_rate || v.r_frame_rate || '0/1').split('/').map(Number);
    const fps = d ? n / d : 0;
    let { width, height } = v;
    const rot = Math.abs(+(v.tags?.rotate || v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation || 0));
    if (rot === 90 || rot === 270) [width, height] = [height, width];
    return {
      duration: +(v.duration || info.format?.duration || 0), width, height, fps: Math.round(fps * 1000) / 1000 || 25,
      codec: v.codec_name, hasAudio: (info.streams || []).some((s) => s.codec_type === 'audio'),
    };
  }

  async function makeProxy(src, dest, info) {
    const enc = await pickEncoder();
    const g = Math.max(1, Math.round(info.fps));
    await ffmpeg(['-i', src, '-map', '0:v:0', '-an', '-sn', '-vf', "scale=-2:'min(720,ih)'", ...enc.args,
      '-g', String(g), '-keyint_min', String(g), '-force_key_frames', 'expr:gte(t,n_forced*1)',
      ...(enc.codec === 'libx264' ? ['-sc_threshold', '0'] : []), '-movflags', '+faststart', '-f', 'mp4', dest], { timeoutMs: 3 * 3600_000 });
    return enc;
  }

  async function makeFilmstrip(src, jpg, jsonFile, info) {
    const interval = Math.max(2, Math.ceil(info.duration / MAX_STRIP_FRAMES));
    const count = Math.max(1, Math.ceil(info.duration / interval));
    const tileW = Math.max(2, Math.round((STRIP_H * info.width) / info.height / 2) * 2);
    const cols = Math.min(count, Math.max(1, Math.floor(8000 / tileW)));
    const rows = Math.ceil(count / cols);
    await ffmpeg(['-i', src, '-map', '0:v:0', '-an', '-vf', `fps=1/${interval}:round=down,scale=${tileW}:${STRIP_H},tile=${cols}x${rows}`, '-frames:v', '1', '-q:v', '5', '-f', 'image2', '-c:v', 'mjpeg', jpg], { timeoutMs: 3600_000 });
    const index = { interval, count, cols, rows, tileWidth: tileW, tileHeight: STRIP_H, times: Array.from({ length: count }, (_, i) => i * interval) };
    await fsp.writeFile(jsonFile, JSON.stringify(index));
    return index;
  }

  async function importVideo(pid, stream, { name, filename, actor, place, offset = 0 }) {
    store.get(pid);
    if (!Number.isFinite(+offset) || +offset < 0) throw new OpError('offset must be ≥ 0 seconds', 'invalid_args', 400);
    const vid = newId('vid');
    let ext = (String(filename || '').match(/\.([a-z0-9]{1,5})$/i)?.[1] || 'bin').toLowerCase();
    await fsp.mkdir(vdir(pid), { recursive: true });
    const orig = file(pid, vid, `.${ext}`);
    const label = `Importing video “${name}”`;
    const jobId = newId('job');
    try {
      await writeUpload(stream, orig);
      const info = await probeVideo(orig);
      store.notify(pid, { type: 'job', jobId, status: 'running', label, actor });
      const enc = await makeProxy(orig, file(pid, vid, '.proxy.mp4'), info);
      await makeFilmstrip(file(pid, vid, '.proxy.mp4'), file(pid, vid, '.strip.jpg'), file(pid, vid, '.strip.json'), info).catch(() => null);
      let asset = null;
      if (info.hasAudio) asset = await actions.importFromFile(pid, orig, { name: `${name} (sound)`, actor });
      const prev = load(pid);
      const v = {
        videoId: vid, name, duration: r3(info.duration), width: info.width, height: info.height, fps: info.fps, offset: r3(+offset),
        audioAssetId: asset?.id || null, sourceCodec: info.codec, proxyCodec: enc.codec, ...(enc.note ? { note: enc.note } : {}),
        createdAt: new Date().toISOString(), createdBy: actor,
      };
      let placed = null;
      if (place && asset) {
        const r = store.apply(pid, [
          { op: 'track.add', args: { name: 'Video sound' } },
          { op: 'clip.add', args: { trackId: '$0.trackId', assetId: asset.id, start: v.offset } },
        ], { actor, label: `Place sound of “${name}”` });
        placed = { trackId: r.results[0].trackId, clipId: r.results[1].clipId };
      }
      await save(pid, v);
      if (prev && prev.videoId !== vid) await removeFiles(pid, prev.videoId);
      store.notify(pid, { type: 'job', jobId, status: 'done', label, actor });
      return { ...v, asset, placed };
    } catch (e) {
      await removeFiles(pid, vid);
      store.notify(pid, { type: 'job', jobId, status: 'error', label, error: e.message, actor });
      throw e;
    }
  }

  // Frame at a timeline time → JPEG buffer (from the original, for full detail).
  async function frameAt(pid, time, { width = 960 } = {}) {
    const v = need(pid);
    const t = +time - v.offset;
    if (!Number.isFinite(t) || t < 0 || t > v.duration) throw new OpError(`No picture at ${time}s: the video covers ${v.offset}–${r3(v.offset + v.duration)}s of the timeline`, 'out_of_range', 400);
    const w = Math.max(64, Math.min(1920, Math.round(+width || 960)));
    const src = await sourceOf(pid, v);
    const seek = Math.min(t, Math.max(0, v.duration - 1 / v.fps));
    const { stdout } = await ffmpeg(['-ss', seek.toFixed(3), '-i', src, '-map', '0:v:0', '-frames:v', '1', '-vf', `scale='min(${w},iw)':-2`, '-q:v', '3', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'], { timeoutMs: 60_000 });
    if (!stdout.length) throw new OpError('Could not decode a frame there', 'ffmpeg_failed', 422);
    return { jpeg: stdout, sourceTime: r3(seek), video: v };
  }
  async function sourceOf(pid, v) {
    const dir = vdir(pid);
    const orig = (await fsp.readdir(dir).catch(() => [])).find((f) => f.startsWith(v.videoId + '.') && !/\.(proxy\.mp4|strip\.jpg|strip\.json)$/.test(f));
    return orig ? path.join(dir, orig) : file(pid, v.videoId, '.proxy.mp4');
  }

  async function sceneChanges(pid, { threshold = 0.35, start, end } = {}) {
    const v = need(pid);
    const th = +threshold;
    if (!(th > 0 && th < 1)) throw new OpError('threshold must be between 0 and 1', 'invalid_args', 400);
    const s = Math.max(0, (start ?? v.offset) - v.offset), e = Math.min(v.duration, (end ?? v.offset + v.duration) - v.offset);
    if (!(e > s)) throw new OpError('Range does not overlap the video', 'invalid_args', 400);
    const { stderr } = await ffmpeg(['-nostats', '-ss', s.toFixed(3), '-t', (e - s).toFixed(3), '-i', file(pid, v.videoId, '.proxy.mp4'), '-map', '0:v:0', '-an',
      '-vf', `scale=320:-2,select='gt(scene,${th})',metadata=print`, '-f', 'null', '-'], { timeoutMs: 3600_000 });
    // With -ss before -i, timestamps restart at 0.
    const cuts = [];
    for (const line of stderr.split('\n')) {
      const m = line.match(/pts_time:\s*([\d.]+)/);
      if (m) cuts.push({ sourceTime: r3(+m[1] + s) });
      const sc = line.match(/lavfi\.scene_score=([\d.]+)/);
      if (sc && cuts.length && cuts[cuts.length - 1].score === undefined) cuts[cuts.length - 1].score = r3(+sc[1]);
    }
    return { offset: v.offset, threshold: th, changes: cuts.map((c) => ({ time: r3(c.sourceTime + v.offset), ...c })) };
  }

  // ── REST ────────────────────────────────────────────────────────────────
  const truthy = (x) => x === true || x === 1 || x === '1' || x === 'true';
  const baseName = (f) => String(f || 'Video').replace(/\.[a-z0-9]{1,5}$/i, '').slice(0, 120) || 'Video';

  api.post('/projects/:id/video', wrap(async (req, res) => {
    const pid = req.params.id; store.get(pid);
    const actor = actorOf(req);
    const ct = req.get('content-type') || '';
    const q = req.query;
    if (ct.startsWith('multipart/form-data')) {
      const fields = {};
      const result = await new Promise((resolve, reject) => {
        const bb = busboy({ headers: req.headers, limits: { fileSize: MAX_VIDEO_BYTES + 1, files: 1 } });
        let job = null;
        bb.on('field', (k, val) => { fields[k] = val; });
        bb.on('file', (_f, stream, info) => {
          if (job) { stream.resume(); return; }
          job = importVideo(pid, stream, { name: baseName(fields.name || q.name || info.filename), filename: info.filename, actor, place: truthy(fields.place ?? q.place), offset: +(fields.offset ?? q.offset ?? 0) })
            .catch((e) => { stream.resume(); throw e; });
        });
        bb.on('close', () => (job ? job.then(resolve, reject) : reject(new OpError('No file in upload', 'invalid_args', 400))));
        bb.on('error', reject);
        req.pipe(bb);
      });
      return res.status(201).json(result);
    }
    if (ct.startsWith('application/json')) {
      await new Promise((r, j) => json(req, res, (e) => (e ? j(e) : r())));
      const b = req.body || {};
      const opts = { actor, place: truthy(b.place ?? q.place), offset: +(b.offset ?? q.offset ?? 0) };
      if (b.url) {
        const { stream, filename } = await openUrl(String(b.url));
        return res.status(201).json(await importVideo(pid, stream, { ...opts, name: baseName(b.name || filename), filename }));
      }
      if (b.base64) return res.status(201).json(await importVideo(pid, Readable.from([Buffer.from(b.base64, 'base64')]), { ...opts, name: baseName(b.name), filename: b.name }));
      throw new OpError('JSON body needs url or base64', 'invalid_args', 400);
    }
    const fname = (q.name || req.get('x-filename') || 'Video').toString();
    res.status(201).json(await importVideo(pid, req, { name: baseName(fname), filename: fname, actor, place: truthy(q.place), offset: +(q.offset ?? 0) }));
  }));

  api.get('/projects/:id/video', (req, res) => {
    // ?optional=1: "no video" is a normal answer (null) instead of a 404.
    if (req.query.optional) { store.get(req.params.id); try { return res.json(need(req.params.id)); } catch (e) { if (e.status === 404) return res.json(null); throw e; } }
    res.json(need(req.params.id));
  });

  api.patch('/projects/:id/video', json, wrap(async (req, res) => {
    const v = need(req.params.id);
    const off = req.body?.offset;
    if (typeof off !== 'number' || !Number.isFinite(off) || off < 0 || off > 24 * 3600) throw new OpError('offset must be a number of seconds ≥ 0', 'invalid_args', 400);
    res.json(await save(req.params.id, { ...v, offset: r3(off) }));
  }));

  api.delete('/projects/:id/video', wrap(async (req, res) => {
    const pid = req.params.id;
    const v = need(pid);
    await fsp.rm(metaFile(pid), { force: true });
    await removeFiles(pid, v.videoId);
    store.notify(pid, { type: 'video', video: null });
    res.status(204).end();
  }));

  const sendVideoFile = (suffix, type) => (req, res, next) => {
    const v = need(req.params.id);
    res.sendFile(file(req.params.id, v.videoId, suffix), { headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=31536000, immutable' }, acceptRanges: true },
      (e) => e && !res.headersSent && next(new OpError('Video file not found', 'not_found', 404)));
  };
  api.get('/projects/:id/video/proxy', sendVideoFile('.proxy.mp4', 'video/mp4'));
  api.get('/projects/:id/video/:file', (req, res, next) => {
    const f = req.params.file;
    if (f === 'filmstrip.jpg' || f === 'filmstrip') return sendVideoFile('.strip.jpg', 'image/jpeg')(req, res, next);
    if (f === 'filmstrip.json') return sendVideoFile('.strip.json', 'application/json')(req, res, next);
    if (f === 'frame.jpg' || f === 'frame') {
      return frameAt(req.params.id, +req.query.time, { width: +req.query.width || 960 })
        .then(({ jpeg }) => res.type('jpeg').send(jpeg), next);
    }
    if (f === 'scenes') {
      const n = (x) => (x === undefined ? undefined : +x);
      return sceneChanges(req.params.id, { threshold: n(req.query.threshold) ?? 0.35, start: n(req.query.start), end: n(req.query.end) }).then((r) => res.json(r), next);
    }
    next(new OpError('Not found', 'not_found', 404));
  });

  // ── MCP ─────────────────────────────────────────────────────────────────
  const pidProp = { projectId: { type: 'string' } };
  mcpTools.push({
    name: 'import_video',
    description: 'Attach a reference video to the session (one per session; a new one replaces the old) so audio can be cut to picture. Give a public URL or base64 data. NyxMix makes a browser proxy and a filmstrip, and extracts the soundtrack into the bin as an asset (audioAssetId). place:true also adds a "Video sound" track with the soundtrack clip at the video offset. Slow for long videos (it transcodes).',
    inputSchema: { type: 'object', properties: { ...pidProp, url: { type: 'string' }, base64: { type: 'string' }, name: { type: 'string', description: 'Name incl. extension helps ffmpeg, e.g. "interview.mp4"' }, place: { type: 'boolean' }, offset: { type: 'number', minimum: 0, description: 'Timeline seconds where the video starts (default 0)' } }, required: ['projectId'] },
    handler: async (a, actor) => {
      const opts = { actor, place: !!a.place, offset: a.offset ?? 0 };
      if (a.url) { const { stream, filename } = await openUrl(a.url); return importVideo(a.projectId, stream, { ...opts, name: baseName(a.name || filename), filename: a.name || filename }); }
      if (a.base64) return importVideo(a.projectId, Readable.from([Buffer.from(a.base64, 'base64')]), { ...opts, name: baseName(a.name), filename: a.name });
      throw new OpError('Provide url or base64', 'invalid_args', 400);
    },
  });
  mcpTools.push({
    name: 'get_video',
    description: 'The session\'s reference video: name, duration, size, fps, offset (timeline seconds where frame 0 sits) and the soundtrack asset id. Timeline time = offset + video time.',
    inputSchema: { type: 'object', properties: pidProp, required: ['projectId'] },
    handler: async (a) => need(a.projectId),
  });
  mcpTools.push({
    name: 'video_frame',
    description: 'Look at the picture: returns the video frame at a timeline time as a JPEG image (e.g. to check who is on screen, or find where a shot changes before cutting the audio there).',
    inputSchema: { type: 'object', properties: { ...pidProp, time: { type: 'number', description: 'Timeline seconds' }, width: { type: 'integer', minimum: 64, maximum: 1920, description: 'default 960' } }, required: ['projectId', 'time'] },
    handler: async (a) => {
      const { jpeg, sourceTime, video } = await frameAt(a.projectId, a.time, { width: a.width });
      return { content: [{ type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' }, { type: 'text', text: `Frame at timeline ${a.time}s (video ${sourceTime}s of ${video.duration}s, ${video.width}×${video.height}).` }] };
    },
  });
  mcpTools.push({
    name: 'set_video_offset',
    description: 'Slide the video against the timeline: offset = timeline seconds where the video starts. Does not move audio clips (move the soundtrack clip with clip.move if they should stay in sync).',
    inputSchema: { type: 'object', properties: { ...pidProp, offset: { type: 'number', minimum: 0 } }, required: ['projectId', 'offset'] },
    handler: async (a) => {
      const v = need(a.projectId);
      if (typeof a.offset !== 'number' || !Number.isFinite(a.offset) || a.offset < 0) throw new OpError('offset must be ≥ 0', 'invalid_args', 400);
      return save(a.projectId, { ...v, offset: r3(a.offset) });
    },
  });
  mcpTools.push({
    name: 'detect_scene_changes',
    description: 'Find shot changes / hard cuts in the video (ffmpeg scene score). Returns timeline times — handy for cutting or crossfading audio exactly on picture cuts, or dropping markers there. threshold 0–1 (default 0.35; lower finds softer changes).',
    inputSchema: { type: 'object', properties: { ...pidProp, threshold: { type: 'number', minimum: 0.01, maximum: 0.99 }, start: { type: 'number', description: 'Timeline seconds' }, end: { type: 'number', description: 'Timeline seconds' } }, required: ['projectId'] },
    handler: async (a) => sceneChanges(a.projectId, { threshold: a.threshold ?? 0.35, start: a.start, end: a.end }),
  });
}

