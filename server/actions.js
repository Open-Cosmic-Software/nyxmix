// High-level actions shared by REST and MCP: import, process, analyze, render.
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { pipeline } from 'node:stream/promises';
import { newId, findClip, OpError } from './ops.js';
import { validate } from './validate.js';
import * as audio from './audio.js';
import { projectEnd } from '../public/js/engine/graph.js';

const MAX_IMPORT_BYTES = 1024 * 1024 * 1024;
// Render options end up in ffmpeg arguments and filter strings: only well-typed values get through.
const RENDER_SCHEMA = {
  type: 'object',
  properties: {
    format: { type: 'string' }, bitDepth: { type: 'integer', enum: [16, 24, 32] }, bitrate: { type: 'integer', minimum: 8, maximum: 512 },
    sampleRate: { type: 'integer', minimum: 8000, maximum: 192000 }, start: { type: 'number', minimum: 0 }, end: { type: 'number', minimum: 0 },
    tail: { type: 'number', minimum: 0, maximum: 60 }, bounce: { type: 'boolean' }, stems: { type: 'boolean' }, ranges: { type: 'string', enum: ['markers'] }, chapters: { type: 'boolean' }, name: { type: 'string', maxLength: 200 },
    loudness: { type: 'object', additionalProperties: false, properties: { lufs: { type: 'number', minimum: -40, maximum: -5 }, truePeak: { type: 'number', minimum: -9, maximum: 0 } } },
  },
};
const tmpFile = (ext = '') => path.join(os.tmpdir(), `klang-${newId('tmp')}${ext}`);

export function createActions(store) {
  const assetPath = (pid) => (aid) => store.assetPath(pid, aid);

  async function registerAsset(pid, wavFile, { name, actor, derivedFrom, process, sourceInfo }) {
    const p = store.get(pid);
    const id = newId('ast');
    const dest = store.assetPath(pid, id);
    await fs.rename(wavFile, dest).catch(async () => { await fs.copyFile(wavFile, dest); await fs.rm(wavFile, { force: true }); });
    const info = await audio.probe(dest);
    const { peak } = await audio.writePeaks(dest, store.peaksPath(pid, id));
    if (peak <= 1) await audio.writePreview(dest, store.previewPath(pid, id)).catch(() => fs.rm(store.previewPath(pid, id), { force: true }));
    const asset = {
      id, name: name || 'Audio', duration: Math.round(info.duration * 1e6) / 1e6, sampleRate: p.sampleRate, channels: info.channels,
      createdAt: new Date().toISOString(), createdBy: actor,
      ...(derivedFrom ? { derivedFrom, process } : {}),
      ...(sourceInfo ? { source: { codec: sourceInfo.codec, sampleRate: sourceInfo.sampleRate, channels: sourceInfo.channels } } : {}),
    };
    store.addAsset(pid, asset, actor);
    return asset;
  }

  async function importFromFile(pid, srcFile, { name, actor }) {
    const p = store.get(pid);
    const wav = tmpFile('.wav');
    try {
      const info = await audio.importToWav(srcFile, wav, p.sampleRate);
      return await registerAsset(pid, wav, { name, actor, sourceInfo: info });
    } finally {
      await fs.rm(wav, { force: true });
    }
  }

  async function importFromStream(pid, stream, opts) {
    const file = tmpFile();
    let bytes = 0;
    try {
      await pipeline(stream, async function* (src) {
        for await (const chunk of src) {
          bytes += chunk.length;
          if (bytes > MAX_IMPORT_BYTES) throw new OpError('File larger than 1 GB', 'too_large', 413);
          yield chunk;
        }
      }, createWriteStream(file));
      if (bytes === 0) throw new OpError('Empty upload', 'empty', 400);
      return await importFromFile(pid, file, opts);
    } finally {
      await fs.rm(file, { force: true });
    }
  }

  async function importFromUrl(pid, url, opts) {
    let u;
    try { u = new URL(url); } catch { throw new OpError('url is not a valid URL', 'invalid_args', 400); }
    if (!/^https?:$/.test(u.protocol)) throw new OpError('Only http(s) URLs can be imported', 'invalid_args', 400);
    await assertPublicHost(u.hostname);
    // The address is checked again at connect time (publicLookup): a second DNS answer
    // (rebinding) must not be able to point the actual request at a private address.
    const res = await new Promise((resolve, reject) => {
      const req = (u.protocol === 'https:' ? https : http).get(u, { lookup: publicLookup }, resolve);
      req.setTimeout(120_000, () => req.destroy(new OpError('Download timed out', 'fetch_failed', 422)));
      req.on('error', (e) => reject(e instanceof OpError ? e : new OpError(`Fetching ${url} failed: ${e.message}`, 'fetch_failed', 422)));
    });
    if (res.statusCode >= 300 && res.statusCode < 400) {
      res.resume();
      const next = res.headers.location;
      if (!next || opts._hops > 3) throw new OpError('Too many redirects', 'fetch_failed', 422);
      return importFromUrl(pid, new URL(next, u).href, { ...opts, _hops: (opts._hops || 0) + 1 });
    }
    if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); throw new OpError(`Fetching ${url} failed: HTTP ${res.statusCode}`, 'fetch_failed', 422); }
    const name = opts.name || decodeURIComponent(u.pathname.split('/').pop() || 'download').replace(/\.[a-z0-9]+$/i, '');
    return importFromStream(pid, res, { ...opts, name });
  }

  // Process only [start, end) of the source: render the span (plus a little context),
  // then splice it back with short crossfades so the edges are seamless.
  async function processRange(kind, params, src, dest, sampleRate, start, end) {
    const full = await audio.readWav(src);
    const sr = full.sampleRate, margin = 0.25, xf = Math.round(0.012 * sr);
    const s = Math.max(0, Math.floor(start * sr)), e = Math.min(full.frames, Math.ceil(end * sr));
    if (e - s < 2 * xf) throw new OpError('Range is too short to process (needs at least 25 ms)', 'invalid_args', 400);
    const ms = Math.max(0, s - Math.round(margin * sr)), me = Math.min(full.frames, e + Math.round(margin * sr));
    const segIn = tmpFile('.wav'), segOut = tmpFile('.wav');
    try {
      await audio.writeWav(segIn, full.channels.map((c) => c.slice(ms, me)), sr);
      const used = await audio.processFile(kind, params, segIn, segOut, sampleRate, { offset: ms / sr });
      const proc = await audio.readWav(segOut);
      const out = full.channels.map((c, ci) => {
        const o = Float32Array.from(c);
        const pc = proc.channels[Math.min(ci, proc.channels.length - 1)];
        for (let i = s; i < e; i++) {
          const k = i - ms;
          const w = Math.min(1, (i - s) / xf, (e - 1 - i) / xf);
          const ww = Math.sin((Math.PI / 2) * Math.max(0, w)) ** 2;
          o[i] = (1 - ww) * c[i] + ww * (k < pc.length ? pc[k] : c[i]);
        }
        return o;
      });
      // A process may change the channel count (mono): keep the original layout.
      await audio.writeWav(dest, out, sr);
      return used;
    } finally { await fs.rm(segIn, { force: true }); await fs.rm(segOut, { force: true }); }
  }

  async function processAsset(pid, assetId, { kind, params = {}, replaceInClips = true, start, end }, actor) {
    const p = store.get(pid);
    const asset = p.assets.find((a) => a.id === assetId);
    if (!asset) throw new OpError(`Asset ${assetId} not found`, 'not_found', 404);
    const def = Object.hasOwn(audio.PROCESSES, kind) ? audio.PROCESSES[kind] : null;
    if (!def) throw new OpError(`Unknown process "${kind}". Available: ${Object.keys(audio.PROCESSES).join(', ')}`, 'invalid_args', 400);
    validate({ type: 'object', properties: def.params, additionalProperties: false }, params, 'params');
    const ranged = start !== undefined || end !== undefined;
    if (ranged) {
      if (!def.keepsLength) throw new OpError(`${kind} changes length, so it can only run on the whole file`, 'invalid_args', 400);
      start = Math.max(0, start ?? 0); end = Math.min(asset.duration, end ?? asset.duration);
      if (!(end > start)) throw new OpError('end must be greater than start', 'invalid_args', 400);
    }
    const jobId = newId('job');
    const what = `${kind} on “${asset.name}”${ranged ? ` (${start.toFixed(2)}–${end.toFixed(2)} s)` : ''}`;
    store.notify(pid, { type: 'job', jobId, status: 'running', label: what, actor });
    const out = tmpFile('.wav');
    try {
      const used = ranged
        ? await processRange(kind, params, store.assetPath(pid, assetId), out, p.sampleRate, start, end)
        : await audio.processFile(kind, params, store.assetPath(pid, assetId), out, p.sampleRate);
      const created = await registerAsset(pid, out, { name: `${asset.name} · ${kind}`, actor, derivedFrom: assetId, process: { kind, params: used, ...(ranged ? { start, end } : {}) } });
      let clipsUpdated = 0;
      if (replaceInClips && def.keepsLength) {
        const inUse = store.get(pid).tracks.some((t) => t.clips.some((c) => c.assetId === assetId));
        if (inUse) {
          const r = store.apply(pid, [{ op: 'asset.replaceInClips', args: { fromAssetId: assetId, toAssetId: created.id } }], { actor, label: `Applied ${kind} to clips of “${asset.name}”` });
          clipsUpdated = r.results[0].clipsUpdated;
        }
      }
      store.notify(pid, { type: 'job', jobId, status: 'done', label: what, actor });
      return { asset: created, clipsUpdated, note: def.keepsLength ? undefined : 'This process changes length, so existing clips were left on the original. Place the new asset with clip.add.' };
    } catch (err) {
      store.notify(pid, { type: 'job', jobId, status: 'failed', label: what, error: err.message, actor });
      throw err;
    } finally {
      await fs.rm(out, { force: true });
    }
  }

  // Audition-style effect preview: process a short span and hand back the audio,
  // without creating an asset. At most 20 s so it stays quick.
  async function previewProcess(pid, assetId, { kind, params = {}, start = 0, end }) {
    const p = store.get(pid);
    const asset = p.assets.find((a) => a.id === assetId);
    if (!asset) throw new OpError(`Asset ${assetId} not found`, 'not_found', 404);
    const def = Object.hasOwn(audio.PROCESSES, kind) ? audio.PROCESSES[kind] : null;
    if (!def) throw new OpError(`Unknown process "${kind}"`, 'invalid_args', 400);
    validate({ type: 'object', properties: def.params, additionalProperties: false }, params, 'params');
    start = Math.max(0, start); end = Math.min(asset.duration, end ?? start + 8, start + 20);
    if (!(end > start)) throw new OpError('end must be greater than start', 'invalid_args', 400);
    const full = await audio.readWav(store.assetPath(pid, assetId));
    const s = Math.floor(start * full.sampleRate), e = Math.ceil(end * full.sampleRate);
    const segIn = tmpFile('.wav'), segOut = tmpFile('.wav');
    try {
      await audio.writeWav(segIn, full.channels.map((c) => c.slice(s, e)), full.sampleRate);
      await audio.processFile(kind, params, segIn, segOut, p.sampleRate, { offset: s / full.sampleRate });
      return await fs.readFile(segOut);
    } finally { await fs.rm(segIn, { force: true }); await fs.rm(segOut, { force: true }); }
  }

  // Time-stretch one clip to a new length (pitch kept), Rubber Band quality.
  async function stretchClip(pid, clipId, { duration, ratio }, actor) {
    const p = store.get(pid);
    const { clip } = findClip(p, clipId);
    const target = duration ?? (ratio ? clip.duration * ratio : undefined);
    if (!(target > 0.05) || target / clip.duration > 4 || target / clip.duration < 0.25) throw new OpError('New length must be between 0.25× and 4× the clip length', 'invalid_args', 400);
    const asset = p.assets.find((a) => a.id === clip.assetId);
    const segIn = tmpFile('.wav'), out = tmpFile('.wav');
    const jobId = newId('job');
    store.notify(pid, { type: 'job', jobId, status: 'running', label: `Stretching “${clip.name}” to ${target.toFixed(2)} s`, actor });
    try {
      const full = await audio.readWav(store.assetPath(pid, clip.assetId));
      const s = Math.floor(clip.offset * full.sampleRate), e = Math.ceil((clip.offset + clip.duration) * full.sampleRate);
      await audio.writeWav(segIn, full.channels.map((c) => c.slice(s, e)), full.sampleRate);
      await audio.processFile('tempo', { factor: clip.duration / target }, segIn, out, p.sampleRate);
      const created = await registerAsset(pid, out, { name: `${asset?.name || clip.name} · stretched`, actor, derivedFrom: clip.assetId, process: { kind: 'stretch', params: { from: clip.duration, to: target } } });
      const r = store.apply(pid, [{ op: 'clip.replaceSource', args: { clipId, assetId: created.id, offset: 0, duration: Math.min(target, created.duration) } }], { actor, label: `Stretched “${clip.name}” to ${target.toFixed(2)} s` });
      store.notify(pid, { type: 'job', jobId, status: 'done', label: `Stretched “${clip.name}”`, actor });
      return { rev: r.rev, asset: created };
    } catch (err) {
      store.notify(pid, { type: 'job', jobId, status: 'failed', label: `Stretching “${clip.name}”`, error: err.message, actor });
      throw err;
    } finally { await fs.rm(segIn, { force: true }); await fs.rm(out, { force: true }); }
  }

  // Resolve an analysis/image target to { file, start, end, cleanup }.
  async function resolveTarget(pid, t = {}) {
    const p = store.get(pid);
    if (t.assetId) {
      if (!p.assets.some((a) => a.id === t.assetId)) throw new OpError(`Asset ${t.assetId} not found`, 'not_found', 404);
      return { file: store.assetPath(pid, t.assetId), start: t.start ?? 0, end: t.end, label: 'asset (source audio)' };
    }
    if (t.clipId) {
      const { clip } = findClip(p, t.clipId);
      const rate = clip.rate || 1;
      return { file: store.assetPath(pid, clip.assetId), start: clip.offset, end: clip.offset + clip.duration * rate, label: 'clip source audio (start/end are timeline seconds, sourceStart/sourceEnd are asset seconds; clip gain/fades and track effects not applied)', toTimeline: (x) => clip.start + (x - clip.offset) / rate };
    }
    // Default: the full mix as you would hear it.
    const start = t.start ?? 0;
    const end = t.end ?? projectEnd(p);
    const mix = await audio.renderMix(p, assetPath(pid), { start, end });
    const file = tmpFile('.wav');
    await audio.writeWav(file, mix.channels, mix.sampleRate);
    return { file, start: 0, end: undefined, label: 'mix (all tracks, effects, master)', toTimeline: (x) => x + start, cleanup: () => fs.rm(file, { force: true }) };
  }

  // start/end/assetId/clipId may be given inside target or at the top level (agents do
  // both); anything unknown is an error instead of being silently ignored.
  function mergeTarget(target, options, allowed, what) {
    const t = { ...(target || {}) };
    const opts = {};
    for (const [k, v] of Object.entries(options || {})) {
      if (v === undefined) continue;
      if (['start', 'end', 'assetId', 'clipId'].includes(k)) {
        if (t[k] !== undefined && t[k] !== v) throw new OpError(`${k} is given twice with different values (top level ${v}, target ${t[k]})`, 'invalid_args', 400);
        t[k] = v;
      } else if (allowed.includes(k)) opts[k] = v;
      else throw new OpError(`${what}: unknown field "${k}". Allowed: target, start, end, assetId, clipId, ${allowed.join(', ')}`, 'invalid_args', 400);
    }
    for (const k of Object.keys(t)) if (!['start', 'end', 'assetId', 'clipId'].includes(k)) throw new OpError(`${what}: unknown target field "${k}" (use start, end, assetId or clipId)`, 'invalid_args', 400);
    for (const k of ['start', 'end']) if (t[k] !== undefined && !(typeof t[k] === 'number' && Number.isFinite(t[k]) && t[k] >= 0)) throw new OpError(`${k} must be a number of seconds ≥ 0`, 'invalid_args', 400);
    if (t.start !== undefined && t.end !== undefined && !(t.end > t.start)) throw new OpError('end must be greater than start', 'invalid_args', 400);
    return { target: t, opts };
  }

  async function analyze(pid, rawTarget = {}, rawOptions = {}) {
    const { target, opts: options } = mergeTarget(rawTarget, rawOptions, ['include', 'silenceThresholdDb', 'minSilence', 'envelopeStep'], 'analyze');
    const r = await resolveTarget(pid, target);
    try {
      const res = await audio.analyzeFile(r.file, { ...options, start: r.start, end: r.end });
      // Everything that lives on the timeline is reported in timeline seconds, so an agent
      // reading start/end sees the range it asked for (asset targets stay in asset seconds).
      if (r.toTimeline) {
        const tl = (x) => +r.toTimeline(x).toFixed(3);
        if (target.clipId) { res.sourceStart = res.start; res.sourceEnd = res.end; }
        res.start = tl(res.start); res.end = tl(res.end);
        if (res.silences) {
          res.silencesTimeline = res.silences.map((x) => ({ ...x, start: tl(x.start), end: tl(x.end) }));
          delete res.silences;
        }
        if (res.envelope) res.envelope.startSeconds = tl(res.envelope.startSeconds);
      }
      return { target: r.label, ...res };
    } finally { await r.cleanup?.(); }
  }

  async function image(pid, rawTarget = {}, rawOptions = {}) {
    const { target, opts } = mergeTarget(rawTarget, rawOptions, ['kind', 'width', 'height'], 'image');
    let { kind = 'waveform', width, height } = opts;
    // Sizes are interpolated into an ffmpeg filter string, so force them to integers.
    const dim = (v, lo, hi) => (v === undefined || v === null ? undefined : Math.round(Math.min(hi, Math.max(lo, Number(v) || lo))));
    width = dim(width, 200, 4000); height = dim(height, 100, 2000);
    const r = await resolveTarget(pid, target);
    try { return await audio.image(r.file, kind, { start: r.start, end: r.end, width, height }); }
    finally { await r.cleanup?.(); }
  }

  async function render(pid, opts = {}, actor) {
    if (!opts._project) validate(RENDER_SCHEMA, opts, 'render');
    if (opts.ranges === 'markers') {
      // One file per range marker (clips for social media, chapters as files, …).
      const base = store.get(pid);
      const ranges = base.markers.filter((m) => m.duration > 0.05);
      if (!ranges.length) throw new OpError('No range markers: add markers with a duration first', 'empty', 422);
      const files = [];
      for (const [i, m] of ranges.entries()) files.push(await render(pid, { ...opts, ranges: undefined, stems: false, start: m.time, end: m.time + m.duration, chapters: false, _project: base, _name: `${base.name} – ${m.label || `Range ${i + 1}`}` }, actor));
      return { files };
    }
    if (opts.stems) {
      // One file per audio track: that track soloed (buses are solo-safe, so its
      // reverb/sends come along), through the master chain.
      const base = store.get(pid);
      const tracks = base.tracks.filter((t) => t.kind !== 'bus' && t.clips.length);
      if (!tracks.length) throw new OpError('No tracks with audio to export', 'empty', 422);
      const end = opts.end ?? projectEnd(base);
      const stems = [];
      for (const t of tracks) {
        const variant = { ...base, tracks: base.tracks.map((x) => ({ ...x, solo: x.id === t.id, mute: x.id === t.id ? false : x.mute })) };
        stems.push(await render(pid, { ...opts, stems: false, bounce: false, end, chapters: false, _project: variant, _name: `${base.name} – ${t.name}` }, actor));
      }
      return { stems };
    }
    const p = opts._project || store.get(pid);
    const format = opts.format || 'wav';
    if (!Object.hasOwn(audio.FORMATS, format)) throw new OpError(`format must be one of ${Object.keys(audio.FORMATS).join(', ')}`, 'invalid_args', 400);
    const jobId = newId('job');
    store.notify(pid, { type: 'job', jobId, status: 'running', label: `Rendering ${format}`, actor });
    const wav = tmpFile('.wav');
    try {
      const mix = await audio.renderMix(p, assetPath(pid), { start: opts.start, end: opts.end, tail: opts.tail });
      await audio.writeWav(wav, mix.channels, mix.sampleRate);
      if (opts.bounce) {
        const enc = tmpFile('.wav');
        let asset;
        try {
          await audio.encode(wav, enc, 'wav', { bitDepth: 32, loudness: opts.loudness, sampleRate: p.sampleRate });
          asset = await importFromFile(pid, enc, { name: opts.name || `Mixdown ${new Date().toLocaleTimeString('en-GB')}`, actor });
        } finally { await fs.rm(enc, { force: true }); }
        store.notify(pid, { type: 'job', jobId, status: 'done', label: 'Bounced mix to the bin', actor });
        return { asset };
      }
      const id = newId('rnd');
      const f = audio.FORMATS[format];
      const file = `${id}.${f.ext}`;
      await fs.mkdir(store.rendersDir(pid), { recursive: true });
      const start = opts.start ?? 0, end = start + mix.channels[0].length / mix.sampleRate;
      const meta = audio.ffmetadata({ tags: opts._name ? {} : p.metadata || {}, title: opts._name || p.name, markers: opts.chapters === false ? [] : p.markers, start, end });
      const metaFile = tmpFile('.txt');
      await fs.writeFile(metaFile, meta.text);
      try {
        await audio.encode(wav, path.join(store.rendersDir(pid), file), format, { ...opts, sampleRate: opts.sampleRate || p.sampleRate, metadataFile: metaFile });
      } finally { await fs.rm(metaFile, { force: true }); }
      const stat = await fs.stat(path.join(store.rendersDir(pid), file));
      const metaInfo = { id, file, format, name: opts._name || p.name, bytes: stat.size, chapters: format === 'wav' ? 0 : meta.chapters, createdAt: new Date().toISOString(), createdBy: actor, projectRev: p.rev, url: `/api/projects/${pid}/renders/${file}` };
      metaInfo.loudness = await audio.loudness(path.join(store.rendersDir(pid), file)).catch(() => undefined);
      await fs.writeFile(path.join(store.rendersDir(pid), `${id}.json`), JSON.stringify(metaInfo));
      store.notify(pid, { type: 'job', jobId, status: 'done', label: `Rendered ${format}`, actor, render: metaInfo });
      return metaInfo;
    } catch (err) {
      store.notify(pid, { type: 'job', jobId, status: 'failed', label: `Rendering ${format}`, error: err.message, actor });
      throw err;
    } finally { await fs.rm(wav, { force: true }); }
  }

  async function listRenders(pid) {
    store.get(pid);
    const dir = store.rendersDir(pid);
    const files = await fs.readdir(dir).catch(() => []);
    const out = [];
    for (const f of files.filter((f) => f.endsWith('.json'))) out.push(JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')));
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  function summary(pid) {
    const p = store.get(pid);
    const s = (x) => `${x.toFixed(3)}s`;
    const fx = (list) => (list.length ? list.map((e) => `${e.type}${e.enabled ? '' : '(bypassed)'}[${e.id}]`).join(' → ') : 'none');
    const lines = [
      `Project “${p.name}” (${p.id}) rev ${p.rev}, ${p.sampleRate} Hz, length ${s(projectEnd(p))}`,
      `Master: gain ${p.master.gain} dB, effects: ${fx(p.master.effects)}`,
      '', `Assets (${p.assets.length}):`,
      ...p.assets.map((a) => `  ${a.id} “${a.name}” ${s(a.duration)} ${a.channels === 1 ? 'mono' : 'stereo'}${a.derivedFrom ? ` (from ${a.derivedFrom} via ${a.process.kind})` : ''}`),
      '', `Tracks (${p.tracks.length}):`,
    ];
    p.tracks.forEach((t, i) => {
      lines.push(`  ${i + 1}. ${t.id} “${t.name}” gain ${t.gain} dB, pan ${t.pan}${t.mute ? ', MUTED' : ''}${t.solo ? ', SOLO' : ''}; effects: ${fx(t.effects)}`);
      for (const c of t.clips) {
        lines.push(`     ${c.id} “${c.name}” ${s(c.start)} → ${s(c.start + c.duration)} (asset ${c.assetId} from ${s(c.offset)}; gain ${c.gain} dB; fades ${c.fadeIn}/${c.fadeOut}s)`);
      }
    });
    if (p.markers.length) {
      lines.push('', 'Markers:');
      for (const m of p.markers) lines.push(`  ${m.id} ${s(m.time)}${m.duration ? `–${s(m.time + m.duration)}` : ''} ${m.label}`);
    }
    return lines.join('\n');
  }

  return { importFromFile, importFromStream, importFromUrl, processAsset, previewProcess, stretchClip, analyze, image, render, listRenders, summary };
}

async function assertPublicHost(host) {
  if (process.env.KLANG_ALLOW_PRIVATE_URLS === '1') return;
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new OpError(`Cannot resolve ${host}`, 'fetch_failed', 422);
  for (const { address } of addrs) {
    if (isPrivate(address)) throw new OpError('URL points to a private or local address; refusing to fetch it', 'forbidden_url', 403);
  }
}
function publicLookup(hostname, options, cb) {
  dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (process.env.KLANG_ALLOW_PRIVATE_URLS !== '1' && addrs.some(({ address }) => isPrivate(address))) {
      return cb(new OpError('URL points to a private or local address; refusing to fetch it', 'forbidden_url', 403));
    }
    if (options.all) cb(null, addrs); else cb(null, addrs[0].address, addrs[0].family);
  });
}
function isPrivate(ip) {
  if (ip.includes(':')) {
    const l = ip.toLowerCase();
    if (l.startsWith('::ffff:')) return isPrivate(l.slice(7));
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
