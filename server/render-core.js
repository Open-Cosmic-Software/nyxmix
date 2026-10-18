// Offline rendering of one time segment through the shared graph. Used directly for
// short renders and inside worker threads for parallel ones. Only the needed part of
// each asset is read from disk, so memory stays bounded for long sessions.
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { OfflineAudioContext, AudioWorkletNode } from 'node-web-audio-api';
import { buildProjectGraph, loadWorklets, setWorkletNode } from '../public/js/engine/graph.js';
import { registerPlugin, loadPluginModules } from '../public/js/engine/plugins.js';
import { irAssetIds } from '../public/js/engine/studiofx.js';

setWorkletNode(AudioWorkletNode);
const WORKLET_PATH = fileURLToPath(new URL('../public/js/engine/dsp-worklet.js', import.meta.url));

async function wavLayout(fh) {
  const head = Buffer.alloc(65536);
  const { bytesRead } = await fh.read(head, 0, head.length, 0);
  if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file');
  let pos = 12, fmt;
  while (pos + 8 <= bytesRead) {
    const id = head.toString('ascii', pos, pos + 4), size = head.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = { channels: head.readUInt16LE(pos + 10), sampleRate: head.readUInt32LE(pos + 12), bits: head.readUInt16LE(pos + 22) };
    if (id === 'data') {
      if (!fmt || fmt.bits !== 32) throw new Error('Expected 32-bit float WAV');
      const { size: fileSize } = await fh.stat();
      return { ...fmt, dataOffset: pos + 8, frames: Math.floor(Math.min(size, fileSize - pos - 8) / (4 * fmt.channels)) };
    }
    pos += 8 + size + (size & 1);
  }
  throw new Error('Malformed WAV');
}

// Read frames [f0, f1) of a float WAV, de-interleaved.
export async function readWavFrames(file, f0, f1) {
  const fh = await fs.open(file, 'r');
  try {
    const L = await wavLayout(fh);
    f0 = Math.max(0, Math.min(L.frames, f0)); f1 = Math.max(f0, Math.min(L.frames, f1));
    const n = f1 - f0, nch = L.channels;
    const raw = Buffer.alloc(n * nch * 4);
    if (n) await fh.read(raw, 0, raw.length, L.dataOffset + f0 * nch * 4);
    const inter = new Float32Array(raw.buffer, raw.byteOffset, n * nch);
    const channels = Array.from({ length: nch }, () => new Float32Array(n));
    for (let i = 0, k = 0; i < n; i++) for (let c = 0; c < nch; c++) channels[c][i] = inter[k++];
    return { sampleRate: L.sampleRate, channels, frames: n };
  } finally { await fh.close(); }
}

/**
 * Render [from, to) of the project. contentEnd: no clip plays past this point
 * (the rest is effect tail). files: assetId -> path.
 */
export async function renderSegment(project, files, { from, to, contentEnd, plugins = [] }) {
  for (const pl of plugins) registerPlugin(pl.manifest);
  const sr = project.sampleRate;
  const length = Math.max(1, Math.round((to - from) * sr));
  const nch = project.channels === 6 ? 6 : 2;
  const ctx = new OfflineAudioContext(nch, length, sr);
  const playEnd = Math.min(to, contentEnd);

  // Which part of each asset this segment needs; clips are re-pointed into that excerpt.
  const ranges = new Map();
  for (const t of project.tracks) for (const c of t.clips) {
    if (c.start >= playEnd || c.start + c.duration <= from) continue;
    const rt = c.rate || 1;
    const s = c.loop ? c.offset : c.offset + Math.max(0, from - c.start) * rt, e = c.loop ? c.offset + c.loopLength : c.offset + Math.min(c.duration, playEnd - c.start) * rt;
    const r = ranges.get(c.assetId);
    ranges.set(c.assetId, r ? { s: Math.min(r.s, s), e: Math.max(r.e, e) } : { s, e });
  }
  const buffers = new Map(), shift = new Map();
  for (const [id, r] of ranges) {
    const f0 = Math.max(0, Math.floor(r.s * sr) - 2), f1 = Math.ceil(r.e * sr) + 2;
    const a = await readWavFrames(files[id], f0, f1);
    const b = ctx.createBuffer(a.channels.length, Math.max(1, a.frames), a.sampleRate);
    a.channels.forEach((ch, i) => b.copyToChannel(ch, i));
    buffers.set(id, b);
    shift.set(id, f0 / a.sampleRate);
  }
  const local = { ...project, tracks: project.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (shift.has(c.assetId) ? { ...c, offset: c.offset - shift.get(c.assetId), ...(c.envelope ? { envelope: c.envelope.map((pt) => ({ ...pt, time: pt.time - shift.get(c.assetId) })) } : {}) } : c)) })) };

  // Impulse responses for convolution reverbs: whole files, separate from clip excerpts.
  const irBuffers = new Map();
  for (const id of irAssetIds(project)) {
    if (!files[id]) continue;
    const a = await readWavFrames(files[id], 0, Infinity);
    const b = ctx.createBuffer(a.channels.length, Math.max(1, a.frames), a.sampleRate);
    a.channels.forEach((ch, i) => b.copyToChannel(ch, i));
    irBuffers.set(id, b);
  }
  await loadWorklets(ctx, WORKLET_PATH);
  const pluginPaths = Object.fromEntries(plugins.map((pl) => [pl.manifest.id, pl.path]));
  await loadPluginModules(ctx, local, (id) => pluginPaths[id]);
  buildProjectGraph(ctx, local, buffers, { from, to: playEnd, when: 0, irBuffers, exact: true });
  const out = await ctx.startRendering();
  // Copy out of the native AudioBuffer: its memory can go away once it is collected.
  return Array.from({ length: nch }, (_, c) => out.getChannelData(c).slice());
}
