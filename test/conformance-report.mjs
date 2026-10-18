// Standards-based conformance measurements for Klang's audio path.
//
// Every check generates its test signal exactly as the cited standard describes it, pushes it
// through Klang's public API (import → session → render/analyze/convert/export) or through the
// live meter worklet, and measures the result independently (own DSP + ffmpeg ebur128).
// Tolerances come from the standards, never from what Klang happens to produce.
//
//   node test/conformance-report.mjs   → prints a markdown table and writes docs/conformance.md
//   node --test test/conformance.test.mjs runs the same CHECKS as assertions.
//
// References:
//   EBU Tech 3341 v4 (2023) "Loudness Metering: 'EBU Mode' metering to supplement EBU R 128"
//     — Table 1 minimum-requirements test signals (cases 1–6, 9, 12, 15–19 are synthetic).
//   EBU Tech 3342 v4 (2023) "Loudness Range" — Table 1 test signals (cases 1–4 synthetic).
//   ITU-R BS.1770-4 (2015) Annex 1 (K-weighting, gating) and Annex 2 (true-peak, 4× oversampling).
//   AES17-2020 (measurement of digital audio equipment): 997 Hz test tone, THD+N / SINAD.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKLET = path.join(ROOT, 'public/js/engine/dsp-worklet.js');

// ── server ───────────────────────────────────────────────────────────────
export async function startServer() {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klang-conf-'));
  const data = path.join(dir, 'data');
  const proc = spawn('node', ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), KLANG_DATA: data }, stdio: 'pipe' });
  proc.stdout.resume(); proc.stderr.resume();
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 300 && !up; i++) { try { await fetch(base + '/api'); up = true; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  if (!up) { proc.kill(); throw new Error('server did not start'); }
  return { base, data, dir, proc, stop: () => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// ── API helpers ──────────────────────────────────────────────────────────
async function j(env, method, url, body) {
  const res = await fetch(env.base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (res.status >= 400) throw new Error(`${method} ${url} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}
async function op(env, pid, o, args) { return (await j(env, 'POST', `/api/projects/${pid}/ops`, { ops: [{ op: o, args }] })).results[0]; }
async function upload(env, pid, channels, sr, name = 'sig') {
  const res = await fetch(`${env.base}/api/projects/${pid}/assets?name=${name}`, { method: 'POST', body: wavF32(channels, sr) });
  if (res.status !== 201) throw new Error(`upload ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Build a session. spec: { sr, layout, master: {gain, effects}, buses: [{name, effects}],
 * tracks: [{ channels, start, gain, pan, surroundY, effects, bus (index), clip: {gain, fadeIn, fadeOut} }] }
 */
async function session(env, spec) {
  const p = await j(env, 'POST', '/api/projects', { name: spec.name || 'conformance', sampleRate: spec.sr });
  if (spec.layout) await op(env, p.id, 'project.setLayout', { layout: spec.layout });
  if (spec.master?.gain) await op(env, p.id, 'master.update', { gain: spec.master.gain });
  for (const e of spec.master?.effects || []) await op(env, p.id, 'effect.add', e);
  const buses = [];
  for (const b of spec.buses || []) {
    const { trackId } = await op(env, p.id, 'track.add', { name: b.name || 'Bus', kind: 'bus' });
    for (const e of b.effects || []) await op(env, p.id, 'effect.add', { ...e, trackId });
    buses.push(trackId);
  }
  const assets = [];
  for (const t of spec.tracks) {
    const a = await upload(env, p.id, t.channels, t.sr || spec.sr);
    assets.push(a);
    const { trackId } = await op(env, p.id, 'track.add', { name: 'T' });
    const upd = { trackId };
    for (const k of ['gain', 'pan', 'surroundY']) if (t[k] !== undefined) upd[k] = t[k];
    if (t.bus !== undefined) upd.output = buses[t.bus];
    if (Object.keys(upd).length > 1) await op(env, p.id, 'track.update', upd);
    for (const e of t.effects || []) await op(env, p.id, 'effect.add', { ...e, trackId });
    await op(env, p.id, 'clip.add', { trackId, assetId: a.id, start: t.start || 0, ...(t.clip || {}) });
  }
  return { pid: p.id, assets };
}

async function fetchFile(env, url) {
  const res = await fetch(env.base + url);
  if (res.status !== 200) throw new Error(`GET ${url} → ${res.status}`);
  const f = path.join(env.dir, `dl-${Math.random().toString(36).slice(2)}${path.extname(url) || '.wav'}`);
  fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
  return f;
}
// Decode any audio file losslessly to float64 channels with ffmpeg.
export function decode(file) {
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', file]).toString()).streams.find((s) => s.codec_type === 'audio');
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f64le', '-c:a', 'pcm_f64le', '-'], { maxBuffer: 2 ** 31 - 1 });
  const nch = info.channels, inter = new Float64Array(raw.buffer, raw.byteOffset, raw.length / 8), n = inter.length / nch;
  const channels = Array.from({ length: nch }, () => new Float64Array(n));
  for (let i = 0, k = 0; i < n; i++) for (let c = 0; c < nch; c++) channels[c][i] = inter[k++];
  return { sr: +info.sample_rate, channels, codec: info.codec_name, bits: +(info.bits_per_raw_sample || info.bits_per_sample || 0) };
}
async function renderFile(env, pid, opts) {
  const r = await j(env, 'POST', `/api/projects/${pid}/render`, opts);
  return fetchFile(env, r.url);
}
async function analyzeLoudness(env, pid) {
  return (await j(env, 'POST', `/api/projects/${pid}/analyze`, { include: ['loudness'] })).loudness;
}
// Independent ffmpeg EBU R128 true-peak measurement (ebur128 peak=true, BS.1770-4 Annex 2).
function ffTruePeak(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const s = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
  const m = s.match(/True peak:\s*\n\s*Peak:\s+(-?[\d.]+|-inf)\s+dBFS/);
  return m ? parseFloat(m[1]) : NaN;
}

// ── signals ──────────────────────────────────────────────────────────────
const TAU = 2 * Math.PI;
const amp = (dbfs) => Math.pow(10, dbfs / 20);
export const dB = (x) => 20 * Math.log10(x);
// A sine whose level steps through [dBFS, seconds] segments (phase continuous).
function steppedSine(segments, f, sr, phaseDeg = 0) {
  const n = Math.round(segments.reduce((s, [, d]) => s + d, 0) * sr);
  const out = new Float64Array(n);
  let i = 0;
  for (const [lvl, d] of segments) {
    const end = Math.min(n, i + Math.round(d * sr)), a = amp(lvl);
    for (; i < end; i++) out[i] = a * Math.sin(TAU * f * i / sr + phaseDeg * Math.PI / 180);
  }
  return out;
}
// Deterministic white noise (xorshift32), uniform in [-a, a].
function noise(n, a, seed = 1) {
  const out = new Float64Array(n);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; out[i] = a * (s / 2 ** 31 - 1); }
  return out;
}
const f32 = (x) => Float32Array.from(x);

export function wavF32(channels, sr) {
  const nch = channels.length, n = channels[0].length;
  const data = new Float32Array(n * nch);
  for (let i = 0, k = 0; i < n; i++) for (let c = 0; c < nch; c++) data[k++] = channels[c][i];
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.byteLength, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(nch, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * nch * 4, 28); h.writeUInt16LE(nch * 4, 32); h.writeUInt16LE(32, 34);
  h.write('data', 36); h.writeUInt32LE(data.byteLength, 40);
  return Buffer.concat([h, Buffer.from(data.buffer)]);
}

// ── measurement DSP ──────────────────────────────────────────────────────
// Least-squares fit of DC + sines at known frequencies over x[a, b).
// Returns amplitudes per frequency and the residual (what is not explained by the fit).
export function fitSines(x, sr, freqs, a = 0, b = x.length) {
  const K = 2 * freqs.length + 1, n = b - a;
  const basis = (i, k) => { if (k === K - 1) return 1; const f = freqs[k >> 1], w = TAU * f * (i + a) / sr; return k & 1 ? Math.sin(w) : Math.cos(w); };
  const G = Array.from({ length: K }, () => new Float64Array(K)), r = new Float64Array(K);
  const row = new Float64Array(K);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < K; k++) row[k] = basis(i, k);
    const v = x[a + i];
    for (let p = 0; p < K; p++) { r[p] += row[p] * v; const gp = G[p]; for (let q = p; q < K; q++) gp[q] += row[p] * row[q]; }
  }
  for (let p = 0; p < K; p++) for (let q = 0; q < p; q++) G[p][q] = G[q][p];
  // Gaussian elimination with partial pivoting.
  const c = Array.from(r);
  const M = G.map((g) => Array.from(g));
  for (let p = 0; p < K; p++) {
    let best = p; for (let q = p + 1; q < K; q++) if (Math.abs(M[q][p]) > Math.abs(M[best][p])) best = q;
    [M[p], M[best]] = [M[best], M[p]]; [c[p], c[best]] = [c[best], c[p]];
    for (let q = p + 1; q < K; q++) { const f = M[q][p] / M[p][p]; if (!f) continue; for (let s = p; s < K; s++) M[q][s] -= f * M[p][s]; c[q] -= f * c[p]; }
  }
  const coef = new Float64Array(K);
  for (let p = K - 1; p >= 0; p--) { let s = c[p]; for (let q = p + 1; q < K; q++) s -= M[p][q] * coef[q]; coef[p] = s / M[p][p]; }
  const amps = freqs.map((_, i) => Math.hypot(coef[2 * i], coef[2 * i + 1]));
  const resid = new Float64Array(n);
  for (let i = 0; i < n; i++) { let y = 0; for (let k = 0; k < K; k++) y += coef[k] * basis(i, k); resid[i] = x[a + i] - y; }
  return { amps, dc: coef[K - 1], resid };
}
const rms = (x) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / x.length); };
const mean = (x) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i]; return s / x.length; };
function maxAbsDiff(a, b, shift = 0) {
  let m = 0;
  const n = Math.min(a.length - shift, b.length);
  for (let i = 0; i < n; i++) { const d = Math.abs(a[i + shift] - b[i]); if (d > m) m = d; }
  return m;
}
const fmtDb = (x, d = 1) => (x === 0 ? '−∞' : Number.isFinite(x) ? x.toFixed(d).replace('-', '−') : String(x));
const fmtRes = (peak) => (peak === 0 ? 'bit-identical' : `${fmtDb(dB(peak))} dBFS`);

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -TAU / len;
    for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) {
      const wr = Math.cos(ang * k), wi = Math.sin(ang * k), a = i + k, b = a + len / 2;
      const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
}
// Welch power spectral density (one-sided, power per bin normalised so a full-scale sine
// reads 0 dB in its peak bin sum and white noise of variance s² sums to s² over all bins).
export function welch(x, N = 8192) {
  const w = Float64Array.from({ length: N }, (_, i) => 0.35875 - 0.48829 * Math.cos(TAU * i / N) + 0.14128 * Math.cos(2 * TAU * i / N) - 0.01168 * Math.cos(3 * TAU * i / N));
  const wss = w.reduce((s, v) => s + v * v, 0);
  const psd = new Float64Array(N / 2 + 1);
  let segs = 0;
  for (let s = 0; s + N <= x.length; s += N / 2) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[s + i] * w[i];
    fft(re, im);
    for (let k = 0; k <= N / 2; k++) psd[k] += (re[k] * re[k] + im[k] * im[k]) * (k && k < N / 2 ? 2 : 1);
    segs++;
  }
  for (let k = 0; k <= N / 2; k++) psd[k] /= segs * wss * N; // Parseval: Σ bins = mean square
  return psd;
}
const bandPower = (psd, sr, N, lo, hi) => { let s = 0, n = 0; for (let k = Math.ceil(lo * N / sr); k <= Math.floor(hi * N / sr); k++) { s += psd[k]; n++; } return { sum: s, mean: s / n }; };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// ── live meter (klang-meter worklet) fed offline ─────────────────────────
// Returns one reading per 100 ms block: { t (s, end of block), m, s, i, tp }.
export async function runMeter(channels, sr) {
  const { OfflineAudioContext, AudioWorkletNode } = await import('node-web-audio-api');
  const n = channels[0].length;
  const ctx = new OfflineAudioContext(channels.length, n, sr);
  await ctx.audioWorklet.addModule(WORKLET);
  const buf = ctx.createBuffer(channels.length, n, sr);
  channels.forEach((c, i) => buf.copyToChannel(f32(c), i));
  const src = ctx.createBufferSource(); src.buffer = buf;
  const meter = new AudioWorkletNode(ctx, 'klang-meter', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: channels.length, channelCountMode: 'explicit' });
  const msgs = [];
  meter.port.onmessage = (e) => msgs.push(e.data);
  src.connect(meter); src.start(0);
  await ctx.startRendering();
  const expect = Math.floor(n / Math.round(sr * 0.1));
  for (let i = 0; i < 100 && msgs.length < expect; i++) await new Promise((r) => setTimeout(r, 20));
  return msgs.map((m, k) => ({ t: (k + 1) * 0.1, ...m }));
}

// ── the checks ───────────────────────────────────────────────────────────
// Each: { id, group, metric, standard, tolerance, run(env) → { measured, pass } | { skip } }.
const SR = 48000;
const stereo = (x) => [x, x];
const within = (v, target, tol) => Number.isFinite(v) && Math.abs(v - target) <= tol;
const lufs = (v) => `${fmtDb(v, 2)} LUFS`;

// Tech 3341 Table 1, synthetic cases. Levels are dBFS of the sine *peak* per channel
// (a stereo 1 kHz sine at −23 dBFS reads −23 LUFS, which is how the spec is built).
const T3341 = {
  1: { segs: [[-23, 20]], expect: -23, desc: 'stereo 1 kHz sine −23 dBFS, 20 s' },
  2: { segs: [[-33, 20]], expect: -33, desc: 'stereo 1 kHz sine −33 dBFS, 20 s' },
  3: { segs: [[-36, 10], [-23, 60], [-36, 10]], expect: -23, desc: '−36/−23/−36 dBFS, 10/60/10 s' },
  4: { segs: [[-72, 10], [-36, 10], [-23, 60], [-36, 10], [-72, 10]], expect: -23, desc: '−72/−36/−23/−36/−72 dBFS, 10/10/60/10/10 s' },
  5: { segs: [[-26, 20], [-20, 20.1], [-26, 20]], expect: -23, desc: '−26/−20/−26 dBFS, 20/20.1/20 s' },
};
// Tech 3342 Table 1, synthetic cases (stereo 1 kHz sine, levels per channel).
const T3342 = {
  1: { segs: [[-20, 20], [-30, 20]], expect: 10 },
  2: { segs: [[-20, 20], [-15, 20]], expect: 5 },
  3: { segs: [[-40, 20], [-20, 20]], expect: 20 },
  4: { segs: [[-50, 20], [-35, 20], [-20, 20], [-35, 20], [-50, 20]], expect: 15 },
};
// Tech 3341 Table 1 true-peak cases (48 kHz stereo sines; expected dBTP, tolerance +0.2/−0.4 dB).
// The cases describe steady tones. A tone switched on/off abruptly is NOT that signal: its
// band-limited reconstruction genuinely overshoots at the edges (ideal 32× oversampling of a
// gated fs/4 sine reads −5.9 dBTP instead of −6.0, ffmpeg reads −5.6), so the 2 s tones get
// 10 ms raised-cosine edges. This is the only deviation from the spec text.
const TP = {
  15: { f: SR / 4, a: 0.5, ph: 0, expect: -6.0, desc: 'fs/4 sine, −6 dBFS, 0° phase' },
  16: { f: SR / 4, a: 0.5, ph: 45, expect: -6.0, desc: 'fs/4 sine, −6 dBFS peak, 45° phase' },
  17: { f: SR / 6, a: 0.5, ph: 60, expect: -6.0, desc: 'fs/6 sine, −6 dBFS peak, 60° phase' },
  18: { f: SR / 8, a: 0.5, ph: 67.5, expect: -6.0, desc: 'fs/8 sine, −6 dBFS peak, 67.5° phase' },
  19: { f: SR / 4, a: Math.SQRT2, ph: 45, expect: 3.0, desc: 'fs/4 sine, 45° phase, samples at 0 dBFS' },
};

export const CHECKS = [];
const add = (c) => CHECKS.push(c);

// 1. EBU Tech 3341 — server analysis (ffmpeg ebur128 on Klang's rendered mix) and the live meter.
for (const [n, c] of Object.entries(T3341)) {
  add({
    id: `3341-${n}-server`, group: 'Loudness (EBU Tech 3341)', metric: `Integrated loudness, case ${n} (${c.desc}) — server analyze`,
    standard: `EBU Tech 3341 case ${n}`, tolerance: `${fmtDb(c.expect)} ±0.1 LUFS`,
    async run(env) {
      const { pid } = await session(env, { sr: SR, tracks: [{ channels: stereo(steppedSine(c.segs, 1000, SR)) }] });
      const v = (await analyzeLoudness(env, pid)).integratedLufs;
      return { measured: lufs(v), pass: within(v, c.expect, 0.1) };
    },
  });
  add({
    id: `3341-${n}-meter`, group: 'Loudness (EBU Tech 3341)', metric: `Integrated loudness, case ${n} — live meter worklet`,
    standard: `EBU Tech 3341 case ${n}`, tolerance: `${fmtDb(c.expect)} ±0.1 LUFS`,
    async run() {
      const r = await runMeter(stereo(steppedSine(c.segs, 1000, SR)), SR);
      const v = r.at(-1).i;
      return { measured: lufs(v), pass: within(v, c.expect, 0.1) };
    },
  });
}
// Cases 1 and 2 also require M and S to read the same value (steady tone).
for (const n of [1, 2]) {
  const c = T3341[n];
  add({
    id: `3341-${n}-meter-ms`, group: 'Loudness (EBU Tech 3341)', metric: `Momentary + short-term, case ${n} — live meter worklet`,
    standard: `EBU Tech 3341 case ${n}`, tolerance: `M, S = ${fmtDb(c.expect)} ±0.1 LUFS`,
    async run() {
      const r = (await runMeter(stereo(steppedSine(c.segs, 1000, SR)), SR)).filter((x) => x.t >= 3);
      const ms = r.flatMap((x) => [x.m, x.s]);
      const worst = ms.reduce((w, v) => (Math.abs(v - c.expect) > Math.abs(w - c.expect) ? v : w), ms[0]);
      return { measured: `worst ${lufs(worst)}`, pass: ms.every((v) => within(v, c.expect, 0.1)) };
    },
  });
}
add({
  id: '3341-6-server', group: 'Loudness (EBU Tech 3341)', metric: 'Integrated loudness, case 6 (5-channel: L,R −28, C −24, Ls,Rs −30 dBFS) — 5.1 session, server analyze',
  standard: 'EBU Tech 3341 case 6 / BS.1770-4 channel weights', tolerance: '−23.0 ±0.1 LUFS',
  async run(env) {
    const s = steppedSine([[0, 20]], 1000, SR).map((v) => v * 0.1); // −20 dBFS mono source, level set by track gain
    // Speaker positions (x = sin θ, y = cos θ) for L −30°, R +30°, C 0°, Ls −110°, Rs +110°.
    const at = (deg, lvl) => ({ channels: [s], pan: Math.sin(deg * Math.PI / 180), surroundY: Math.cos(deg * Math.PI / 180), gain: lvl + 20 });
    const { pid } = await session(env, { sr: SR, layout: '5.1', tracks: [at(-30, -28), at(30, -28), at(0, -24), at(-110, -30), at(110, -30)] });
    const v = (await analyzeLoudness(env, pid)).integratedLufs;
    return { measured: lufs(v), pass: within(v, -23, 0.1) };
  },
});
add({
  id: '3341-6-meter', group: 'Loudness (EBU Tech 3341)', metric: 'Integrated loudness, case 6 (5-channel) — live meter worklet',
  standard: 'EBU Tech 3341 case 6', tolerance: '−23.0 ±0.1 LUFS',
  async run() { return { skip: 'not applicable: klang-meter sums only the first two input channels (dsp-worklet.js LoudnessMeter.process) and the player feeds it the stereo fold-down, so it is a stereo meter by design' }; },
});
add({
  id: '3341-9-meter', group: 'Loudness (EBU Tech 3341)', metric: 'Short-term loudness, case 9 (1.34 s −20 dBFS / 1.66 s −30 dBFS ×5) — live meter',
  standard: 'EBU Tech 3341 case 9', tolerance: 'S = −23.0 ±0.1 LUFS from 3 s on',
  async run() {
    const segs = []; for (let k = 0; k < 5; k++) segs.push([-20, 1.34], [-30, 1.66]);
    const r = (await runMeter(stereo(steppedSine(segs, 1000, SR)), SR)).filter((x) => x.t >= 3 - 1e-9);
    const vals = r.map((x) => x.s);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    return { measured: `${lufs(lo)} … ${lufs(hi)}`, pass: vals.length > 0 && vals.every((v) => within(v, -23, 0.1)) };
  },
});
add({
  id: '3341-12-meter', group: 'Loudness (EBU Tech 3341)', metric: 'Momentary loudness, case 12 (0.18 s −20 dBFS / 0.22 s −30 dBFS ×25) — live meter',
  standard: 'EBU Tech 3341 case 12', tolerance: 'M = −23.0 ±0.1 LUFS from 1 s on',
  async run() {
    const segs = []; for (let k = 0; k < 25; k++) segs.push([-20, 0.18], [-30, 0.22]);
    const r = (await runMeter(stereo(steppedSine(segs, 1000, SR)), SR)).filter((x) => x.t >= 1 - 1e-9);
    const vals = r.map((x) => x.m);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    return { measured: `${lufs(lo)} … ${lufs(hi)}`, pass: vals.length > 0 && vals.every((v) => within(v, -23, 0.1)) };
  },
});
add({
  id: '3341-files', group: 'Loudness (EBU Tech 3341)', metric: 'Cases 7, 8, 10, 11, 13, 14, 20–23',
  standard: 'EBU Tech 3341', tolerance: '—',
  async run() { return { skip: 'not reproduced: these cases are defined by the EBU reference files (authentic programme material or burst sequences only specified by the files), not by the spec text' }; },
});

// 2. EBU Tech 3342 loudness range.
for (const [n, c] of Object.entries(T3342)) {
  add({
    id: `3342-${n}-server`, group: 'Loudness range (EBU Tech 3342)', metric: `LRA, case ${n} (${c.segs.map(([l, d]) => `${fmtDb(l, 0)} dBFS ${d} s`).join(' / ')}) — server analyze`,
    standard: `EBU Tech 3342 case ${n}`, tolerance: `${c.expect} ±1 LU`,
    async run(env) {
      const { pid } = await session(env, { sr: SR, tracks: [{ channels: stereo(steppedSine(c.segs, 1000, SR)) }] });
      const v = (await analyzeLoudness(env, pid)).loudnessRangeLu;
      return { measured: `${fmtDb(v, 1)} LU`, pass: within(v, c.expect, 1) };
    },
  });
}
add({
  id: '3342-files', group: 'Loudness range (EBU Tech 3342)', metric: 'Cases 5, 6 (authentic programme)', standard: 'EBU Tech 3342', tolerance: '—',
  async run() { return { skip: 'not reproduced: defined by EBU reference programme files' }; },
});

// 3. True peak (BS.1770-4 Annex 2, Tech 3341 cases 15–19) and the true-peak limiter.
for (const [n, c] of Object.entries(TP)) {
  add({
    id: `tp-${n}-server`, group: 'True peak (ITU-R BS.1770-4)', metric: `True peak, case ${n} (${c.desc}) — server analyze`,
    standard: `BS.1770-4 Annex 2; EBU Tech 3341 case ${n}`, tolerance: `${c.expect > 0 ? '+' : ''}${fmtDb(c.expect)} +0.2/−0.4 dBTP`,
    async run(env) {
      const x = new Float64Array(SR * 2).map((_, i) => c.a * Math.sin(TAU * c.f * i / SR + c.ph * Math.PI / 180));
      const E = Math.round(0.01 * SR);
      for (let i = 0; i < E; i++) { const g = 0.5 - 0.5 * Math.cos(Math.PI * i / E); x[i] *= g; x[x.length - 1 - i] *= g; }
      const { pid } = await session(env, { sr: SR, tracks: [{ channels: stereo(x) }] });
      const v = (await analyzeLoudness(env, pid)).truePeakDbtp;
      return { measured: `${v > 0 ? '+' : ''}${fmtDb(v, 2)} dBTP`, pass: Number.isFinite(v) && v - c.expect <= 0.2 && c.expect - v <= 0.4 };
    },
  });
}
// Limiter: inter-sample-peak-heavy material driven hot; the export must stay ≤ −1 dBTP.
const LIMIT_SIGNALS = {
  'fs/4 sine, 45°, +3 dBTP': () => { const x = new Float64Array(SR * 4).map((_, i) => Math.SQRT2 * Math.sin(TAU * i / 4 + Math.PI / 4)); return stereo(x); },
  'naive 1 kHz square ±1 (Gibbs overshoot)': () => { const x = new Float64Array(SR * 4).map((_, i) => (Math.floor(i * 2000 / SR) % 2 ? -1 : 1)); return stereo(x); },
  'white noise +6 dB hot, uncorrelated L/R': () => [noise(SR * 4, 2, 7), noise(SR * 4, 2, 99)],
  'multitone 5/9.5/11.9/17 kHz, 0 dBFS samples': () => { const fs4 = [5000, 9500, 11900, 17000]; const x = new Float64Array(SR * 4).map((_, i) => fs4.reduce((s, f, k) => s + 0.5 * Math.sin(TAU * f * i / SR + k), 0)); const pk = x.reduce((m, v) => Math.max(m, Math.abs(v)), 0); return stereo(x.map((v) => v / pk)); },
};
for (const [name, gen] of Object.entries(LIMIT_SIGNALS)) {
  add({
    id: `limiter-${name}`, group: 'True peak (ITU-R BS.1770-4)', metric: `Limiter (ceiling −1) true peak of export — ${name}`,
    standard: 'BS.1770-4 Annex 2 (ffmpeg ebur128 peak=true)', tolerance: '≤ −1.0 dBTP',
    async run(env) {
      const { pid } = await session(env, { sr: SR, master: { effects: [{ type: 'limiter', params: { ceiling: -1 } }] }, tracks: [{ channels: gen() }] });
      const f = await renderFile(env, pid, { format: 'wav', bitDepth: 32 });
      const v = ffTruePeak(f);
      const ref = refTruePeak(decode(f).channels);
      return { measured: `${v > 0 ? '+' : ''}${fmtDb(v, 2)} dBTP (16× sinc reference: ${ref > 0 ? '+' : ''}${fmtDb(ref, 2)})`, pass: Number.isFinite(v) && v <= -1.0 };
    },
    why: 'Root cause: the limiter\'s peak detector (public/js/engine/dsp-worklet.js, TP_COEFS + Limiter.interPeak) interpolates with only 8 Hann-windowed sinc taps at 3 phases. Its half-sample response is −0.5 dB at 0.35·fs (16.8 kHz) and −7.3 dB at 0.45·fs, so high-frequency inter-sample peaks are under-read; the limiter holds its own estimate at exactly −1.000 dB while the real true peak is higher. The independent 16× sinc reference confirms the overshoot, so it is not an ffmpeg artefact. Fix: a BS.1770-4 Annex 2-grade detector (≥ 48-tap 4× polyphase, better 8×) and/or a ~0.5 dB internal safety margin, and no hard sample clip after the gain (it creates new inter-sample peaks).',
  });
}
// Reference true-peak meter: 16× oversampling with a 64-tap Kaiser(β=12) windowed sinc per phase.
function refTruePeak(channels) {
  const P = 16, H = 32, beta = 12;
  const i0 = (x) => { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; };
  const taps = [];
  for (let p = 1; p < P; p++) {
    const fr = p / P, h = new Float64Array(2 * H);
    for (let j = 0; j < 2 * H; j++) { const x = j - (H - 1) - fr; const r = x / H; h[j] = (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * (Math.abs(r) < 1 ? i0(beta * Math.sqrt(1 - r * r)) / i0(beta) : 0); }
    taps.push(h);
  }
  let pk = 0;
  for (const x of channels) {
    for (let i = 0; i < x.length; i++) pk = Math.max(pk, Math.abs(x[i]));
    for (let i = H; i + H < x.length; i++) for (const h of taps) { let v = 0; for (let j = 0; j < 2 * H; j++) v += h[j] * x[i - (H - 1) + j]; const a = Math.abs(v); if (a > pk) pk = a; }
  }
  return dB(pk);
}

// 4. Transparency / null tests.
const nullSource = (sr, nch, secs = 2) => Array.from({ length: nch }, (_, c) => { const n = noise(sr * secs, 0.5, 11 + c); for (let i = 0; i < n.length; i++) n[i] += 0.3 * Math.sin(TAU * 997 * i / sr + c); return f32(n); });
// Render a one-clip session and compare out[i + shift] with src[i + srcOff].
async function nullTest(env, { sr, nch, bus = false, start = 0, shift = 0, secs = 2, clip, srcOff = 0 }) {
  const src = nullSource(sr, nch, secs);
  const { pid } = await session(env, { sr, buses: bus ? [{ name: 'Bus' }] : [], tracks: [{ channels: src, start, clip, ...(bus ? { bus: 0 } : {}) }] });
  const out = decode(await renderFile(env, pid, { format: 'wav', bitDepth: 32 }));
  const n = Math.min(out.channels[0].length - shift, src[0].length - srcOff);
  let peak = 0, peakG = 0, so = 0, ss = 0, worstAt = 0;
  for (let c = 0; c < out.channels.length; c++) {
    const o = out.channels[c], s = src[Math.min(c, nch - 1)];
    for (let i = 0; i < n; i++) { so += o[i + shift] * s[i + srcOff]; ss += s[i + srcOff] * s[i + srcOff]; }
  }
  const g = so / ss; // least-squares gain of output vs source
  for (let c = 0; c < out.channels.length; c++) {
    const o = out.channels[c], s = src[Math.min(c, nch - 1)];
    for (let i = 0; i < n; i++) {
      const d = Math.abs(o[i + shift] - s[i + srcOff]); if (d > peak) { peak = d; worstAt = i; }
      peakG = Math.max(peakG, Math.abs(o[i + shift] - g * s[i + srcOff]));
    }
  }
  let lead = 0; for (let c = 0; c < out.channels.length; c++) for (let i = 0; i < shift; i++) lead = Math.max(lead, Math.abs(out.channels[c][i]));
  const expectLen = (clip?.duration ? Math.round(clip.duration * sr) : src[0].length - srcOff) + shift;
  const lenOk = Math.abs(out.channels[0].length - expectLen) <= 1;
  return { peak, peakG, gainDb: dB(g), worstAt: worstAt / sr, lead, lenOk, outSr: out.sr };
}
const nullPass = (r) => r.lenOk && (r.peak === 0 || dB(r.peak) <= -140);
const nullMeasured = (r) => `${fmtRes(r.peak)}${r.lenOk ? '' : ', length mismatch'}${r.peak && Math.abs(r.gainDb) > 0.001 ? ` (output gain ${fmtDb(r.gainDb, 2)} dB; after removing it: ${fmtRes(r.peakG)})` : ''}`;
const MONO_WHY = 'Root cause: a mono clip enters the track\'s StereoPannerNode (public/js/engine/graph.js buildProjectGraph: autoPan → pan) as a 1-channel signal; the Web Audio spec pans mono input with the equal-power law, so at pan 0 both outputs are x·cos(π/4) = −3.01 dB. Everything else in the path is transparent (residual after removing that exact gain is shown). Adobe Audition\'s default multitrack pan mode (L/R cut, logarithmic) leaves a centred mono clip at 0 dB in both channels. Fix: up-mix mono clips to dual-mono (channelCount 2, channelCountMode "explicit", interpretation "speakers") before the panners, or implement an L/R-cut pan law.';
for (const sr of [44100, 48000, 96000]) for (const nch of [1, 2]) {
  add({
    id: `null-${sr}-${nch}`, group: 'Transparency (null tests)', metric: `${nch === 1 ? 'Mono' : 'Stereo'} clip, no effects, 0 dB → 32-bit float WAV, ${sr / 1000} kHz`,
    standard: 'Null test vs source (bit-transparency)', tolerance: 'bit-identical or residual ≤ −140 dBFS',
    async run(env) {
      const r = await nullTest(env, { sr, nch });
      return { measured: `${nullMeasured(r)}${r.outSr !== sr ? `, rate ${r.outSr}` : ''}`, pass: r.outSr === sr && nullPass(r) };
    },
    ...(nch === 1 ? { why: MONO_WHY } : {}),
  });
}
for (const nch of [1, 2]) {
  add({
    id: `null-bus-${nch}`, group: 'Transparency (null tests)', metric: `${nch === 1 ? 'Mono' : 'Stereo'} clip routed through an empty bus, 48 kHz`,
    standard: 'Null test vs source', tolerance: 'bit-identical or residual ≤ −140 dBFS',
    async run(env) {
      const r = await nullTest(env, { sr: SR, nch, bus: true });
      return { measured: nullMeasured(r), pass: nullPass(r) };
    },
    ...(nch === 1 ? { why: MONO_WHY } : {}),
  });
}
const DRIFT_WHY = 'Root cause (upstream, node-web-audio-api 2.2.0 AudioBufferSourceNode): the buffer is copied verbatim only when start() is on a 128-frame render-quantum boundary and offset is 0. Any other start time or offset (even an exact whole number of frames) makes the node track its playhead in floating point and linearly interpolate; the error grows with play time. Measured directly on the library with a 1 kHz + 15 kHz tone: start at 1 frame → −151 dBFS after 1 s, −128 after 10 s, −82 after 60 s, −69 after 150 s, −59 dBFS after 290 s; start at 128 frames → bit-exact for 300 s. Klang hits this for every trimmed or moved clip (graph.js buildProjectGraph src.start(T(startAt), offset + skip)) and in every parallel segment (server/render-core.js renderSegment re-points clips into an excerpt, so offset ≠ 0). Fix (render-core.js): give each clip an excerpt buffer that begins exactly at its first rendered frame, zero-padded in front so that start(0, 0) is used — or mix clip buffers in JS for offline renders.';
add({
  id: 'null-offset', group: 'Transparency (null tests)', metric: 'Clip placed 1 sample late (start = 1/48000 s), stereo',
  standard: 'Sample-exact placement (null test vs source delayed 1 sample)', tolerance: 'residual ≤ −140 dBFS, first sample silent',
  async run(env) {
    const r = await nullTest(env, { sr: SR, nch: 2, start: 1 / SR, shift: 1 });
    return { measured: `${fmtRes(r.peak)} (worst at ${r.worstAt.toFixed(5)} s), leading sample ${r.lead === 0 ? '0' : fmtDb(dB(r.lead)) + ' dBFS'}`, pass: r.lead === 0 && (r.peak === 0 || dB(r.peak) <= -140) };
  },
  why: 'Root cause: clip times are stored rounded to 1 µs (server/ops.js clip.add/clip.update: start: r6(a.start)), so 1/48000 s = 20.833 µs becomes 21 µs = 1.008 frames. The AudioBufferSourceNode then starts at a fractional frame and linearly interpolates the entire clip (every output sample is 0.992·x[n] + 0.008·x[n−1]), the first source sample is dropped (output frame 1 is silent instead of x[0]), and the play-time drift described below adds to it. Fix: store/snap clip start, offset and duration to whole frames of the session rate (or keep them as frame counts).',
});
add({
  id: 'null-subsample', group: 'Transparency (null tests)', metric: 'Clip at a non-sample-aligned time (start = 10 µs = 0.48 frame), 20 Hz–20 kHz multitone: gain error',
  standard: 'Placement must not filter the audio (flat response, AES17)', tolerance: '|gain error| ≤ 0.1 dB',
  async run(env) {
    const tones = [100, 1000, 5000, 10000, 15000, 20000], a0 = 0.1;
    const x = f32(new Float64Array(SR * 2).map((_, i) => tones.reduce((s, f, k) => s + a0 * Math.sin(TAU * f * i / SR + k), 0)));
    const { pid } = await session(env, { sr: SR, tracks: [{ channels: [x, x], start: 0.00001 }] });
    const out = decode(await renderFile(env, pid, { format: 'wav', bitDepth: 32 }));
    const y = out.channels[0];
    const { amps } = fitSines(y, SR, tones, 4800, y.length - 4800);
    const errs = amps.map((v) => dB(v / a0));
    const worst = errs.reduce((w, e, i) => (Math.abs(e) > Math.abs(w.e) ? { e, f: tones[i] } : w), { e: 0, f: 0 });
    return { measured: `worst ${worst.e >= 0 ? '+' : ''}${fmtDb(worst.e, 2)} dB at ${worst.f} Hz`, pass: Math.abs(worst.e) <= 0.1 };
  },
  why: 'Root cause: same as the 1-sample case — a start time between frames makes the AudioBufferSourceNode render the clip through a linear interpolator (fractional delay d = 0.48 → |H| = |1 − d + d·e^−jω|, a treble roll-off). Clips dragged in the UI land between frames all the time. Fix: snap clip times to the frame grid.',
});
add({
  id: 'null-trimmed', group: 'Transparency (null tests)', metric: 'Trimmed clip (offset 1 s, 30 s long, start 0), stereo, single-pass render',
  standard: 'Null test vs source (bit-transparency)', tolerance: 'bit-identical or residual ≤ −140 dBFS',
  async run(env) {
    const r = await nullTest(env, { sr: SR, nch: 2, secs: 32, clip: { offset: 1, duration: 30 }, srcOff: SR });
    return { measured: `${nullMeasured(r)}, worst at ${r.worstAt.toFixed(1)} s`, pass: nullPass(r) };
  },
  why: DRIFT_WHY,
});
add({
  id: 'null-parallel', group: 'Transparency (null tests)', metric: 'Parallel segmented render vs single-pass render, 75 s session (fades, clip/track/master gain, pan, gain fx)',
  standard: 'Null test between render paths', tolerance: 'residual ≤ −120 dBFS',
  async run(env) {
    const sr = SR, secs = 75;
    const src = [noise(sr * secs, 0.4, 3), noise(sr * secs, 0.4, 5)].map((x) => { for (let i = 0; i < x.length; i++) x[i] += 0.3 * Math.sin(TAU * 440 * i / sr); return f32(x); });
    const { pid } = await session(env, { sr, master: { gain: -1, effects: [{ type: 'gain', params: { gain: -2 } }] }, tracks: [{ channels: src, gain: -3, pan: 0.3, effects: [{ type: 'gain', params: { gain: 1.5 } }], clip: { gain: -1, fadeIn: 3, fadeOut: 5 } }] });
    const parallel = decode(await renderFile(env, pid, { format: 'wav', bitDepth: 32 }));
    const project = await j(env, 'GET', `/api/projects/${pid}`);
    const { renderMix } = await import('../server/audio.js');
    const single = await renderMix(project, (aid) => path.join(env.data, 'projects', pid, 'assets', `${aid}.wav`), { threads: 1 });
    let peak = 0;
    for (let c = 0; c < 2; c++) peak = Math.max(peak, maxAbsDiff(parallel.channels[c], single.channels[c]));
    const lenOk = parallel.channels[0].length === single.channels[0].length;
    return { measured: `${fmtRes(peak)}${lenOk ? '' : ', length mismatch'}`, pass: lenOk && (peak === 0 || dB(peak) <= -120) };
  },
  why: DRIFT_WHY,
});

// 5. Sample-rate conversion (POST /sample-rate, SoX soxr).
async function convertAndFetch(env, sr, to, signals) {
  const p = await j(env, 'POST', '/api/projects', { name: 'src', sampleRate: sr });
  const assets = [];
  for (const s of signals) assets.push(await upload(env, p.id, [s], sr));
  await j(env, 'POST', `/api/projects/${p.id}/sample-rate`, { sampleRate: to });
  const out = [];
  for (const a of assets) out.push(decode(await fetchFile(env, `/api/projects/${p.id}/assets/${a.id}/audio`)));
  return out;
}
add({
  id: 'src-sinad', group: 'Sample-rate conversion', metric: '1 kHz sine −1 dBFS, 48 → 44.1 kHz: SINAD (= −THD+N)',
  standard: 'AES17-2020 THD+N method (fundamental notched by LS fit)', tolerance: '≥ 120 dB',
  async run(env) {
    const x = new Float64Array(SR * 4).map((_, i) => amp(-1) * Math.sin(TAU * 1000 * i / SR));
    const [o] = await convertAndFetch(env, SR, 44100, [x]);
    const y = o.channels[0], a = Math.round(0.25 * o.sr), b = y.length - a;
    const { amps, resid } = fitSines(y, o.sr, [1000], a, b);
    const sinad = dB((amps[0] / Math.SQRT2) / rms(resid));
    return { measured: `${sinad.toFixed(1)} dB (out rate ${o.sr})`, pass: o.sr === 44100 && sinad >= 120 };
  },
});
add({
  id: 'src-ripple', group: 'Sample-rate conversion', metric: 'Passband gain 20 Hz–20 kHz (13-tone multitone), 48 → 44.1 kHz',
  standard: 'Passband ripple (AES17 frequency response)', tolerance: '|gain error| ≤ 0.1 dB',
  async run(env) {
    const tones = [20, 50, 100, 300, 1000, 3000, 6000, 10000, 14000, 17000, 18500, 19500, 20000];
    const a0 = 0.05;
    const x = new Float64Array(SR * 4).map((_, i) => tones.reduce((s, f, k) => s + a0 * Math.sin(TAU * f * i / SR + k * 0.7), 0));
    const [o] = await convertAndFetch(env, SR, 44100, [x]);
    const y = o.channels[0], a = Math.round(0.25 * o.sr);
    const { amps } = fitSines(y, o.sr, tones, a, y.length - a);
    const errs = amps.map((v) => dB(v / a0));
    const worst = errs.reduce((w, e, i) => (Math.abs(e) > Math.abs(w.e) ? { e, f: tones[i] } : w), { e: 0, f: 0 });
    return { measured: `worst ${worst.e >= 0 ? '+' : ''}${fmtDb(worst.e, 3)} dB at ${worst.f} Hz`, pass: Math.abs(worst.e) <= 0.1 };
  },
});
add({
  id: 'src-alias', group: 'Sample-rate conversion', metric: '23 kHz tone −1 dBFS, 96 → 44.1 kHz: alias at 21.1 kHz',
  standard: 'Anti-alias stopband rejection', tolerance: '≤ −100 dB re input',
  async run(env) {
    const sr = 96000, a0 = amp(-1);
    const x = new Float64Array(sr * 4).map((_, i) => a0 * Math.sin(TAU * 23000 * i / sr));
    const [o] = await convertAndFetch(env, sr, 44100, [x]);
    const y = o.channels[0], a = Math.round(0.25 * o.sr);
    const { amps, resid } = fitSines(y, o.sr, [44100 - 23000], a, y.length - a);
    const alias = dB(amps[0] / a0), total = dB(rms(resid) * Math.SQRT2 / a0);
    return { measured: `alias ${fmtDb(alias)} dB, all other output ${fmtDb(total)} dB`, pass: alias <= -100 && total <= -100 };
  },
});

// 6. Export encoders.
// −20 dBFS 997 Hz tone: float32 samples below 0.125 carry ≥ 4 bits below the 24-bit LSB, so the
// quantiser sees (nearly) uniformly distributed fractions, as quantisation theory assumes.
async function encoderTest(env, format, bitDepth) {
  const x = new Float64Array(SR * 3).map((_, i) => amp(-20) * Math.sin(TAU * 997 * i / SR));
  const { pid } = await session(env, { sr: SR, tracks: [{ channels: [f32(x), f32(x.map((v) => -v))] }] });
  const ref = decode(await renderFile(env, pid, { format: 'wav', bitDepth: 32 }));
  const out = decode(await renderFile(env, pid, { format, bitDepth }));
  const n = Math.min(ref.channels[0].length, out.channels[0].length);
  const lsb = 2 ** -(bitDepth - 1);
  let worst = { rmsDb: -Infinity, meanLsb: 0, maxLsb: 0 };
  for (let c = 0; c < 2; c++) {
    const e = new Float64Array(n);
    for (let i = 0; i < n; i++) e[i] = out.channels[c][i] - ref.channels[c][i];
    let mx = 0; for (const v of e) mx = Math.max(mx, Math.abs(v));
    const r = { rmsDb: dB(rms(e)), meanLsb: mean(e) / lsb, maxLsb: mx / lsb };
    if (r.rmsDb > worst.rmsDb) worst = r;
  }
  return { ...worst, bits: out.bits, codec: out.codec };
}
for (const [format, bitDepth] of [['wav', 24], ['flac', 24]]) {
  // 24-bit: 6.02·24 = 144.5 dB. An ideal (round-to-nearest) quantiser has error uniform in
  // ±½ LSB → RMS = LSB/√12 = −149.3 dBFS (FS = 1.0); a truncating one reaches LSB/√3 = −143.2 dBFS.
  add({
    id: `enc-${format}${bitDepth}`, group: 'Export encoders', metric: `${format.toUpperCase()} ${bitDepth}-bit export vs 32-bit float export (997 Hz, −20 dBFS): quantisation error`,
    standard: 'Ideal 24-bit PCM quantiser (round to nearest; 6.02·N dB)', tolerance: 'error RMS ≤ −144.5 dBFS and |error| ≤ ½ LSB',
    async run(env) {
      const r = await encoderTest(env, format, bitDepth);
      return { measured: `RMS ${fmtDb(r.rmsDb)} dBFS, max ${r.maxLsb.toFixed(2)} LSB, mean ${r.meanLsb.toFixed(2).replace('-', '−')} LSB (${r.bits}-bit ${r.codec})`, pass: r.bits === 24 && r.rmsDb <= -144.5 && r.maxLsb <= 0.5 + 1e-6 };
    },
    why: `Root cause: server/audio.js FORMATS.${format} lets ffmpeg convert float → s32 (rounded) and then the ${format === 'wav' ? 'pcm_s24le encoder' : 'FLAC encoder (bits_per_raw_sample 24)'} drops the low 8 bits with an arithmetic shift, i.e. truncates (floor): verified 838861.5 LSB → 838861 and −838861.125 → −838862. Error is in (−1, 0] LSB instead of ±½ LSB, with a −½ LSB DC bias, ~6 dB above an ideal 24-bit quantiser (still ~−143 dBFS, far below audibility). Fix: round before the encoder, e.g. scale to 24-bit and round in Klang's own writer, or TPDF-dither to 24 bits (aresample=osf=s32:dither_method=triangular with output_sample_bits=24).`,
  });
}
// CD export (44.1 kHz/16-bit, TPDF dither): −90 dBFS 997 Hz tone (AES17) in a 44.1 kHz session.
let cdCache = null;
async function cdExport(env) {
  if (cdCache?.env === env) return cdCache.r;
  const sr = 44100, a0 = amp(-90);
  const x = f32(new Float64Array(sr * 30).map((_, i) => a0 * Math.sin(TAU * 997 * i / sr)));
  const { pid } = await session(env, { sr, tracks: [{ channels: [x, x] }] });
  const meta = await j(env, 'POST', `/api/projects/${pid}/cd`, {});
  const out = decode(await fetchFile(env, meta.wav.url));
  cdCache = { env, r: { out, a0, sr } };
  return cdCache.r;
}
add({
  id: 'cd-noise', group: 'Export encoders', metric: 'CD export (16-bit, TPDF dither): total noise floor with −90 dBFS 997 Hz tone',
  standard: 'TPDF dither theory (Vanderkooy/Lipshitz): ½ LSB quantiser + 2 LSB p-p TPDF → RMS LSB/2', tolerance: '−96.3 ±1 dBFS RMS (unweighted, 0–fs/2)',
  async run(env) {
    const { out, sr } = await cdExport(env);
    const y = out.channels[0], a = sr;
    const { resid } = fitSines(y, sr, [997], a, y.length - a);
    const psd = welch(resid, 8192);
    const v = 10 * Math.log10(bandPower(psd, sr, 8192, 0, sr / 2).sum);
    return { measured: `${fmtDb(v, 2)} dBFS (${out.bits}-bit ${out.codec}, ${out.sr} Hz)`, pass: out.sr === 44100 && out.bits === 16 && Math.abs(v - -96.3) <= 1 };
  },
});
add({
  id: 'cd-flat', group: 'Export encoders', metric: 'CD export: noise floor flatness (PSD of 10–20 kHz vs 100 Hz–2 kHz)',
  standard: 'TPDF (white) dither: spectrally flat', tolerance: '±1 dB',
  async run(env) {
    const { out, sr } = await cdExport(env);
    const y = out.channels[0];
    const { resid } = fitSines(y, sr, [997], sr, y.length - sr);
    const psd = welch(resid, 8192);
    const lo = bandPower(psd, sr, 8192, 100, 2000).mean, hi = bandPower(psd, sr, 8192, 10000, 20000).mean;
    const tilt = 10 * Math.log10(hi / lo);
    return { measured: `${tilt >= 0 ? '+' : ''}${tilt.toFixed(2)} dB`, pass: Math.abs(tilt) <= 1 };
  },
  why: 'Root cause: server/features/cd.js (exportCd, ffmpeg call) uses aresample dither_method=triangular_hp — high-pass TPDF (difference of successive TPDF values), whose spectrum rises towards Nyquist. Total noise is right (≈ −96.4 dBFS), but it is not spectrally flat. With dither_method=triangular the same ffmpeg chain measures −96.35 dBFS and −0.02 dB tilt. High-pass TPDF is a legitimate perceptual choice; if flat TPDF is the intended spec, change the one parameter.',
});
add({
  id: 'cd-spurs', group: 'Export encoders', metric: 'CD export: harmonics 2–20 of the −90 dBFS 997 Hz tone above local noise floor',
  standard: 'TPDF dither removes signal-correlated distortion', tolerance: 'no harmonic > local floor +3 dB; tone level −90.0 ±0.5 dBFS',
  async run(env) {
    const { out, sr, a0 } = await cdExport(env);
    const y = out.channels[0], N = 8192;
    const psd = welch(y.subarray(sr, y.length - sr), N);
    let worst = { ex: -Infinity, h: 0 };
    for (let h = 2; h * 997 < 20000; h++) {
      const k0 = Math.round(h * 997 * N / sr);
      let pk = 0; for (let k = k0 - 3; k <= k0 + 3; k++) pk = Math.max(pk, psd[k]);
      const neigh = []; for (let k = k0 - 60; k <= k0 + 60; k++) if (Math.abs(k - k0) > 8) neigh.push(psd[k]);
      const ex = 10 * Math.log10(pk / median(neigh));
      if (ex > worst.ex) worst = { ex, h };
    }
    const { amps } = fitSines(y, sr, [997], sr, y.length - sr);
    const lvl = dB(amps[0]);
    return { measured: `worst H${worst.h} ${worst.ex >= 0 ? '+' : ''}${worst.ex.toFixed(1)} dB; tone ${fmtDb(lvl, 2)} dBFS`, pass: worst.ex <= 3 && Math.abs(lvl - dB(a0)) <= 0.5 };
  },
});

// ── report ───────────────────────────────────────────────────────────────
export async function runChecks(env, checks = CHECKS, onRow) {
  const rows = [];
  for (const c of checks) {
    let r;
    try { r = await c.run(env); } catch (err) { r = { measured: `error: ${err.message}`, pass: false }; }
    const row = { ...c, ...r };
    rows.push(row);
    onRow?.(row);
  }
  return rows;
}
export function markdown(rows) {
  const esc = (s) => String(s).replace(/\|/g, '\\|');
  const lines = [
    '# Klang conformance report',
    '',
    `Generated by \`node test/conformance-report.mjs\` on ${new Date().toISOString().slice(0, 10)} (ffmpeg ${execFileSync('ffmpeg', ['-version']).toString().split('\n')[0].split(' ')[2]}, Node ${process.version}).`,
    'Test signals are generated as the cited standards define them and pushed through Klang\'s public API (import → session → render / analyze / sample-rate / CD export) or the `klang-meter` worklet run offline; results are measured independently (least-squares sine fits, Welch spectra, ffmpeg `ebur128`).',
    'The same checks run as assertions in `test/conformance.test.mjs`.',
    '',
  ];
  let group = null;
  for (const r of rows) {
    if (r.group !== group) {
      group = r.group;
      lines.push(`## ${group}`, '', '| Metric | Standard | Tolerance | Measured | Pass |', '|---|---|---|---|---|');
    }
    lines.push(`| ${esc(r.metric)} | ${esc(r.standard)} | ${esc(r.tolerance)} | ${esc(r.skip ? r.skip : r.measured)} | ${r.skip ? 'n/a' : r.pass ? '✅' : '❌ FAIL'} |`);
    const next = rows[rows.indexOf(r) + 1];
    if (!next || next.group !== group) lines.push('');
  }
  const n = rows.filter((r) => !r.skip), ok = n.filter((r) => r.pass).length;
  lines.push(`**${ok} / ${n.length} measured checks pass** (${rows.length - n.length} not applicable / not reproducible).`, '');
  const failed = n.filter((r) => !r.pass);
  if (failed.length) {
    lines.push('## Failures and root causes', '');
    const seen = new Map();
    for (const r of failed) { const k = r.why || 'Not yet investigated.'; if (!seen.has(k)) seen.set(k, []); seen.get(k).push(r.id); }
    for (const [why, ids] of seen) lines.push(`- **${ids.join(', ')}** — ${why}`);
    lines.push('');
  }
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const env = await startServer();
  try {
    const rows = await runChecks(env, CHECKS, (r) => process.stderr.write(`${r.skip ? 'SKIP' : r.pass ? 'PASS' : 'FAIL'}  ${r.id}: ${r.skip || r.measured}\n`));
    const md = markdown(rows);
    process.stdout.write(md);
    fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'docs', 'conformance.md'), md);
  } finally { env.stop(); }
  process.exit(0);
}
