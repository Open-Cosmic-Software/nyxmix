// Worker-thread side of the spectral feature: float32 WAV range I/O plus the
// heavy DSP jobs, so long files never block the HTTP/WebSocket event loop.
// Started by spectral.js with new Worker(this file, { workerData: { klangSpectral: job } }).
import fs from 'node:fs';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import * as dsp from './spectral-dsp.js';

// server/features/*.js are auto-registered feature modules; this one has nothing to register.
export async function register() {}

// ── float32 WAV (format 3 / extensible) range I/O ───────────────────────
export function wavInfo(fd) {
  const head = Buffer.alloc(12);
  fs.readSync(fd, head, 0, 12, 0);
  if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file');
  const size = fs.fstatSync(fd).size;
  let pos = 12, fmt;
  const ch = Buffer.alloc(24);
  while (pos + 8 <= size) {
    fs.readSync(fd, ch, 0, 24, pos);
    const id = ch.toString('ascii', 0, 4), len = ch.readUInt32LE(4);
    if (id === 'fmt ') fmt = { format: ch.readUInt16LE(8), channels: ch.readUInt16LE(10), sampleRate: ch.readUInt32LE(12), bits: ch.readUInt16LE(22) };
    if (id === 'data') {
      if (!fmt) break;
      if (fmt.bits !== 32 || (fmt.format !== 3 && fmt.format !== 0xfffe)) throw new Error('Expected 32-bit float WAV');
      const dataLen = Math.min(len, size - pos - 8);
      return { ...fmt, dataOffset: pos + 8, frames: Math.floor(dataLen / (4 * fmt.channels)) };
    }
    pos += 8 + len + (len & 1);
  }
  throw new Error('Malformed WAV');
}

const CHUNK = 1 << 18; // frames per I/O block

// Frames [from, from + count) as one Float32Array per channel, zero padded outside the file.
export function readRange(fd, info, from, count) {
  const nch = info.channels, out = Array.from({ length: nch }, () => new Float32Array(Math.max(0, count)));
  const s = Math.max(0, from), e = Math.min(info.frames, from + count);
  const buf = Buffer.alloc(Math.min(CHUNK, Math.max(1, e - s)) * nch * 4);
  for (let f = s; f < e; f += CHUNK) {
    const nf = Math.min(CHUNK, e - f);
    fs.readSync(fd, buf, 0, nf * nch * 4, info.dataOffset + f * nch * 4);
    const v = new Float32Array(buf.buffer, buf.byteOffset, nf * nch);
    for (let i = 0, k = 0; i < nf; i++) for (let c = 0; c < nch; c++) out[c][f - from + i] = v[k++];
  }
  return out;
}

export function writeRange(fd, info, from, channels, skip = 0, count = channels[0].length - skip) {
  const nch = info.channels;
  const buf = Buffer.alloc(Math.min(CHUNK, Math.max(1, count)) * nch * 4);
  const v = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  for (let f = 0; f < count; f += CHUNK) {
    const nf = Math.min(CHUNK, count - f);
    for (let i = 0, k = 0; i < nf; i++) for (let c = 0; c < nch; c++) v[k++] = channels[c][skip + f + i];
    fs.writeSync(fd, buf, 0, nf * nch * 4, info.dataOffset + (from + f) * nch * 4);
  }
}

const rmsDb = (chs, s, e) => {
  let p = 0, n = 0;
  for (const x of chs) for (let i = Math.max(0, s); i < Math.min(x.length, e); i++) { p += x[i] * x[i]; n++; }
  return n ? Math.round(10 * Math.log10(Math.max(1e-20, p / n)) * 100) / 100 : null;
};

// ── jobs ────────────────────────────────────────────────────────────────
export function runJob(job) {
  const fd = fs.openSync(job.src, 'r');
  try {
    const info = wavInfo(fd), sr = info.sampleRate;
    switch (job.op) {
      case 'attenuate':
      case 'heal': {
        // Only the region plus a context margin is read, processed and patched
        // into a copy of the file; everything else stays bit-identical.
        // The region (box, lasso polygon or brush strokes) is in source seconds;
        // its time bounds already include feathers / brush rims.
        const p = job.params, n = dsp.fftSizeFor(sr);
        const { t0, t1 } = dsp.makeRegion(sr, n, p);
        const margin = 4 * n;
        const f0 = Math.max(0, Math.floor(t0 * sr) - margin), f1 = Math.min(info.frames, Math.ceil(t1 * sr) + margin);
        if (f1 <= f0) throw Object.assign(new Error('Region is outside the audio'), { status: 400, code: 'invalid_args' });
        const chs = readRange(fd, info, f0, f1 - f0);
        const local = dsp.shiftRegion(p, -f0 / sr);
        const stats = job.op === 'attenuate' ? dsp.attenuateRegion(chs, sr, local) : dsp.healRegion(chs, sr, local);
        fs.copyFileSync(job.src, job.dest);
        const out = fs.openSync(job.dest, 'r+');
        try { writeRange(out, info, f0, chs); } finally { fs.closeSync(out); }
        return stats;
      }
      case 'learn': {
        const f0 = Math.max(0, Math.floor(job.start * sr)), f1 = Math.min(info.frames, Math.ceil(job.end * sr));
        const chs = readRange(fd, info, f0, f1 - f0);
        const profile = dsp.learnNoiseProfile(chs, sr, { start: f0 / sr, end: f1 / sr, offset: f0 / sr });
        return dsp.serializeProfile(profile);
      }
      case 'denoise': {
        const chs = readRange(fd, info, 0, info.frames);
        const profile = dsp.deserializeProfile(job.profile);
        const ps = Math.floor(profile.start * sr), pe = Math.ceil(profile.end * sr);
        const before = rmsDb(chs, ps, pe), overallBefore = rmsDb(chs, 0, info.frames);
        const stats = dsp.reduceNoise(chs, sr, profile, job.params);
        const after = rmsDb(chs, ps, pe), overallAfter = rmsDb(chs, 0, info.frames);
        fs.copyFileSync(job.src, job.dest);
        const out = fs.openSync(job.dest, 'r+');
        try { writeRange(out, info, 0, chs); } finally { fs.closeSync(out); }
        return { ...stats, noisePrintRangeDbfs: { before, after }, overallRmsDbfs: { before: overallBefore, after: overallAfter } };
      }
      case 'pitch': {
        const o = job.opts, margin = Math.ceil(0.06 * sr);
        const f0 = Math.max(0, Math.floor(o.start * sr) - margin), f1 = Math.min(info.frames, Math.ceil(o.end * sr) + margin);
        const chs = readRange(fd, info, f0, f1 - f0);
        const mono = chs.length === 1 ? chs[0] : Float32Array.from(chs[0], (_, i) => chs.reduce((s, c) => s + c[i], 0) / chs.length);
        return dsp.detectPitch(mono, sr, { ...o, offset: f0 / sr });
      }
      case 'spectrogram': {
        const o = job.opts;
        const png = dsp.renderSpectrogram((from, count) => readRange(fd, info, from, count), sr, info.frames, o);
        return png;
      }
      default: throw new Error(`Unknown spectral job ${job.op}`);
    }
  } finally { fs.closeSync(fd); }
}

if (!isMainThread && workerData?.klangSpectral) {
  try {
    const result = runJob(workerData.klangSpectral);
    parentPort.postMessage({ ok: true, result });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: { message: err.message, status: err.status, code: err.code } });
  }
}
