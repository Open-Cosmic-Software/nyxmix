// Spectral editing + noise-print noise reduction: DSP unit tests and API/MCP tests.
import { freePort } from './helpers.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as dsp from '../server/features/spectral-dsp.js';
import { readWav, writeWav } from '../server/audio.js';

const SR = 48000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klang-spectral-'));

// ── helpers ──────────────────────────────────────────────────────────────
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const sine = (f, a, i) => a * Math.sin((2 * Math.PI * f * i) / SR);
// Goertzel amplitude (dBFS of a sine) of frequency f over [s0, s1) seconds.
function toneDb(x, f, s0, s1) {
  const a0 = Math.round(s0 * SR), a1 = Math.round(s1 * SR), w = (2 * Math.PI * f) / SR, c = 2 * Math.cos(w);
  let p = 0, q = 0;
  for (let i = a0; i < a1; i++) { const y = x[i] + c * p - q; q = p; p = y; }
  return 20 * Math.log10((Math.sqrt(p * p + q * q - c * p * q) * 2) / (a1 - a0));
}
const rmsDb = (x, s0, s1) => { let p = 0; const a = Math.round(s0 * SR), b = Math.round(s1 * SR); for (let i = a; i < b; i++) p += x[i] * x[i]; return 10 * Math.log10(p / (b - a)); };
const peak = (x, s0, s1) => { let p = 0; for (let i = Math.round(s0 * SR); i < Math.round(s1 * SR); i++) p = Math.max(p, Math.abs(x[i])); return p; };
const snrDb = (out, clean, s0, s1) => { let s = 0, e = 0; for (let i = Math.round(s0 * SR); i < Math.round(s1 * SR); i++) { s += clean[i] ** 2; e += (out[i] - clean[i]) ** 2; } return 10 * Math.log10(s / e); };

async function afftdn(noisy, filter) {
  const a = path.join(dir, 'aff-in.wav'), b = path.join(dir, 'aff-out.wav');
  await writeWav(a, [noisy], SR);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', a, '-af', filter, '-c:a', 'pcm_f32le', b]);
  const out = (await readWav(b)).channels[0];
  // afftdn may delay its output; align it to the input (noise makes the peak unique) for a fair comparison.
  let best = 0, bestC = -Infinity;
  for (let lag = -2048; lag <= 2048; lag++) {
    let c = 0;
    for (let i = SR * 0.2; i < SR * 0.7; i++) c += (out[i + lag] || 0) * noisy[i];
    if (c > bestC) { bestC = c; best = lag; }
  }
  return Float32Array.from({ length: noisy.length }, (_, i) => out[i + best] || 0);
}

// ── DSP unit tests ───────────────────────────────────────────────────────
test('real FFT matches a direct DFT and inverts exactly', () => {
  const n = 128, f = new dsp.RealFFT(n);
  const x = Float64Array.from({ length: n }, () => rnd() - 0.5);
  const re = new Float64Array(n / 2 + 1), im = new Float64Array(n / 2 + 1);
  f.forward(x, re, im);
  let err = 0;
  for (let k = 0; k <= n / 2; k++) {
    let r = 0, i = 0;
    for (let t = 0; t < n; t++) { r += x[t] * Math.cos((2 * Math.PI * k * t) / n); i -= x[t] * Math.sin((2 * Math.PI * k * t) / n); }
    err = Math.max(err, Math.abs(r - re[k]), Math.abs(i - im[k]));
  }
  assert.ok(err < 1e-10, `forward error ${err}`);
  const y = new Float64Array(n);
  f.inverse(re, im, y);
  assert.ok(x.every((v, i) => Math.abs(v - y[i]) < 1e-12));
});

test('STFT analysis → synthesis reconstructs the input (< -100 dB)', () => {
  const x = Float64Array.from({ length: SR * 2 + 333 }, (_, i) => sine(440, 0.5, i) + 0.1 * gauss());
  const orig = x.slice();
  dsp.stftProcess(x, { n: 2048, onFrame: () => {} });
  let e = 0, s = 0;
  for (let i = 0; i < x.length; i++) { e += (x[i] - orig[i]) ** 2; s += orig[i] ** 2; }
  const db = 10 * Math.log10(e / s);
  assert.ok(db < -100, `reconstruction error ${db.toFixed(1)} dB`);
  // Float32 storage in place: identical within float rounding.
  const y = Float32Array.from(orig), y0 = y.slice();
  dsp.stftProcess(y, { n: 2048, onFrame: () => {} });
  assert.ok(y.every((v, i) => Math.abs(v - y0[i]) < 1e-6));
});

test('long files stream through the STFT without a spectrogram matrix', () => {
  const x = new Float32Array(SR * 120); // 2 minutes: a full matrix would be ~90 MB
  for (let i = 0; i < x.length; i++) x[i] = 0.05 * (rnd() - 0.5);
  const prof = dsp.learnNoiseProfile([x], SR, { start: 0, end: 1 });
  const m0 = process.memoryUsage().arrayBuffers;
  dsp.reduceNoise([x], SR, prof, {});
  const grew = (process.memoryUsage().arrayBuffers - m0) / 1e6;
  assert.ok(grew < 8, `array buffers grew by ${grew.toFixed(1)} MB`);
});

test('attenuateRegion removes a 3 kHz tone inside the box and keeps 500 Hz', () => {
  const x = Float32Array.from({ length: SR * 2 }, (_, i) => sine(500, 0.3, i) + sine(3000, 0.3, i));
  const o = x.slice();
  dsp.attenuateRegion([o], SR, { start: 0.5, end: 1.5, lowHz: 2000, highHz: 4000, gainDb: -40 });
  const inside = toneDb(x, 3000, 0.7, 1.3) - toneDb(o, 3000, 0.7, 1.3);
  console.log(`  3 kHz inside box: −${inside.toFixed(1)} dB; 500 Hz change ${(toneDb(o, 500, 0.7, 1.3) - toneDb(x, 500, 0.7, 1.3)).toFixed(3)} dB`);
  assert.ok(inside > 35, `3 kHz only reduced by ${inside.toFixed(1)} dB`);
  assert.ok(Math.abs(toneDb(o, 500, 0.7, 1.3) - toneDb(x, 500, 0.7, 1.3)) < 0.1, '500 Hz must be untouched');
  assert.ok(Math.abs(toneDb(o, 3000, 0.05, 0.4) - toneDb(x, 3000, 0.05, 0.4)) < 0.1, '3 kHz outside the box must be untouched');
  assert.ok(Math.abs(toneDb(o, 3000, 1.6, 1.95) - toneDb(x, 3000, 1.6, 1.95)) < 0.1);
});

test('healRegion removes a click burst and keeps the tone and noise bed', () => {
  const clean = Float32Array.from({ length: SR * 2 }, (_, i) => sine(500, 0.2, i) + 0.02 * gauss());
  const x = clean.slice();
  for (let i = SR; i < SR * 1.004; i++) x[i] += (i % 2 ? 0.8 : -0.8) * Math.exp(-(i - SR) / 60);
  const o = x.slice();
  dsp.healRegion([o], SR, { start: 0.998, end: 1.006 });
  console.log(`  click window rms: clean ${rmsDb(clean, 0.98, 1.03).toFixed(2)}, clicked ${rmsDb(x, 0.98, 1.03).toFixed(2)}, healed ${rmsDb(o, 0.98, 1.03).toFixed(2)} dBFS; peak ${peak(x, 0.99, 1.02).toFixed(2)} → ${peak(o, 0.99, 1.02).toFixed(2)}`);
  assert.ok(peak(o, 0.99, 1.02) < 0.3, `peak still ${peak(o, 0.99, 1.02)}`);
  assert.ok(Math.abs(rmsDb(o, 0.98, 1.03) - rmsDb(clean, 0.98, 1.03)) < 1, 'healed level should match the clean bed');
  assert.ok(Math.abs(toneDb(o, 500, 0.95, 1.05) - toneDb(clean, 500, 0.95, 1.05)) < 0.3, 'tone through the region survives');
  for (let i = 0; i < o.length; i++) if (i < SR * 0.9 || i > SR * 1.1) assert.equal(o[i], x[i]);
});

test('reduceNoise beats ffmpeg afftdn on tone + white noise', async () => {
  const L = SR * 4, clean = new Float32Array(L), noisy = new Float32Array(L);
  for (let i = 0; i < L; i++) {
    const t = i / SR;
    clean[i] = t > 1 ? 0.3 * Math.sin(2 * Math.PI * 1000 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 1.3 * t)) : 0;
    noisy[i] = clean[i] + 0.05 * gauss();
  }
  const prof = dsp.learnNoiseProfile([noisy], SR, { start: 0, end: 0.9 });
  const ours = noisy.slice(), ours30 = noisy.slice();
  dsp.reduceNoise([ours], SR, prof, { reductionDb: 18 });
  dsp.reduceNoise([ours30], SR, prof, { reductionDb: 30 });
  const inSnr = snrDb(noisy, clean, 1.2, 3.8), outSnr = snrDb(ours, clean, 1.2, 3.8), out30 = snrDb(ours30, clean, 1.2, 3.8);
  const aff = await afftdn(noisy, 'afftdn=nr=18:nf=-26');
  const affStrong = await afftdn(noisy, 'afftdn=nr=40:nf=-26');
  const affSnr = snrDb(aff, clean, 1.2, 3.8), affStrongSnr = snrDb(affStrong, clean, 1.2, 3.8);
  console.log(`  white noise SNR: input ${inSnr.toFixed(1)} dB → ours@18 dB ${outSnr.toFixed(1)} dB, ours@30 dB ${out30.toFixed(1)} dB (noise-only ${rmsDb(noisy, 0.1, 0.9).toFixed(1)} → ${rmsDb(ours, 0.1, 0.9).toFixed(1)} dBFS); afftdn nr=18 ${affSnr.toFixed(1)} dB, nr=40 ${affStrongSnr.toFixed(1)} dB`);
  assert.ok(outSnr - inSnr > 14, `SNR gain only ${(outSnr - inSnr).toFixed(1)} dB`);
  assert.ok(outSnr > affSnr + 4, 'clearly better than afftdn at the same reduction');
  assert.ok(out30 > affStrongSnr + 6, 'ours at 30 dB clearly beats afftdn at 40 dB');
  assert.ok(Math.abs(rmsDb(ours, 0.1, 0.9) - (rmsDb(noisy, 0.1, 0.9) - 18)) < 1.5, 'noise-only part sits at the floor');
});

test('reduceNoise handles fan hum (tonal + broadband noise)', async () => {
  const L = SR * 4, clean = new Float32Array(L), noisy = new Float32Array(L);
  for (let i = 0; i < L; i++) {
    const t = i / SR;
    clean[i] = t > 1 ? sine(700, 0.2, i) + sine(2500, 0.1, i) * (t > 2 ? 1 : 0) : 0;
    const hum = sine(60, 0.03, i) + sine(120, 0.02, i) + sine(180, 0.015, i);
    noisy[i] = clean[i] + hum + 0.015 * gauss();
  }
  const prof = dsp.learnNoiseProfile([noisy], SR, { start: 0, end: 0.9 });
  const desc = dsp.describeProfile(prof);
  assert.ok(desc.tonalPeaks.some((p) => Math.abs(p.hz - 60) < 25), `hum not detected: ${JSON.stringify(desc.tonalPeaks)}`);
  const ours = noisy.slice();
  dsp.reduceNoise([ours], SR, prof, { reductionDb: 24 });
  const aff = await afftdn(noisy, 'afftdn=nr=24:nf=-36');
  const inSnr = snrDb(noisy, clean, 1.2, 3.8), outSnr = snrDb(ours, clean, 1.2, 3.8), affSnr = snrDb(aff, clean, 1.2, 3.8);
  console.log(`  hum + hiss SNR: input ${inSnr.toFixed(1)} dB → ours ${outSnr.toFixed(1)} dB; afftdn ${affSnr.toFixed(1)} dB`);
  assert.ok(outSnr - inSnr > 15, `SNR gain only ${(outSnr - inSnr).toFixed(1)} dB`);
  assert.ok(outSnr > affSnr + 5);
});

test('polygon attenuate removes a 3 kHz tone only inside a triangle', () => {
  // Triangle: full height (1.5–6 kHz) at 0.2 s, narrowing to a point at 1.5 kHz at 1.4 s.
  // It covers 3 kHz from 0.2 s until about 0.9 s, not later.
  const x = Float32Array.from({ length: SR * 2 }, (_, i) => sine(500, 0.3, i) + sine(3000, 0.3, i));
  const o = x.slice();
  const st = dsp.attenuateRegion([o], SR, { polygon: [[0.2, 1500], [0.2, 6000], [1.4, 1500]], gainDb: -40 });
  assert.equal(st.shape, 'polygon');
  const d = (f, a, b) => toneDb(o, f, a, b) - toneDb(x, f, a, b);
  console.log(`  triangle: 3 kHz 0.3–0.7 s ${d(3000, 0.3, 0.7).toFixed(1)} dB, 1.0–1.9 s ${d(3000, 1.0, 1.9).toFixed(2)} dB, before ${d(3000, 0.02, 0.15).toFixed(2)} dB; 500 Hz ${d(500, 0.3, 0.7).toFixed(3)} dB`);
  assert.ok(d(3000, 0.3, 0.7) < -35, 'tone inside the triangle is removed');
  assert.ok(Math.abs(d(3000, 1.05, 1.9)) < 0.1, 'tone after the hypotenuse is untouched');
  assert.ok(Math.abs(d(3000, 0.02, 0.15)) < 0.1, 'tone before the triangle is untouched');
  assert.ok(Math.abs(d(500, 0.3, 0.7)) < 0.1, '500 Hz below the triangle is untouched');
  // A box given as a polygon behaves like the box.
  const ob = x.slice(), op = x.slice();
  dsp.attenuateRegion([ob], SR, { start: 0.5, end: 1.5, lowHz: 2000, highHz: 4000, gainDb: -30 });
  dsp.attenuateRegion([op], SR, { polygon: [[0.5, 2000], [1.5, 2000], [1.5, 4000], [0.5, 4000]], gainDb: -30 });
  assert.ok(Math.abs(toneDb(ob, 3000, 0.7, 1.3) - toneDb(op, 3000, 0.7, 1.3)) < 0.5);
  assert.ok(Math.abs(toneDb(op, 500, 0.7, 1.3) - toneDb(x, 500, 0.7, 1.3)) < 0.1);
});

test('brush strokes: paint follows the stroke, erase cuts a hole', () => {
  const x = Float32Array.from({ length: SR * 2 }, (_, i) => sine(1000, 0.3, i) + sine(4000, 0.3, i));
  const o = x.slice();
  // A horizontal stroke along 4 kHz from 0.4 to 1.6 s, with 0.9–1.1 s erased again.
  dsp.attenuateRegion([o], SR, { gainDb: -40, strokes: [
    { points: [[0.4, 4000], [1.6, 4000]], radiusMs: 20, radiusSemitones: 2 },
    { points: [[0.95, 4000], [1.05, 4000]], radiusMs: 20, radiusSemitones: 4, erase: true },
  ] });
  const d = (f, a, b) => toneDb(o, f, a, b) - toneDb(x, f, a, b);
  console.log(`  brush: 4 kHz painted ${d(4000, 0.5, 0.8).toFixed(1)} dB, erased ${d(4000, 0.97, 1.03).toFixed(2)} dB; 1 kHz ${d(1000, 0.5, 0.8).toFixed(3)} dB`);
  assert.ok(d(4000, 0.5, 0.8) < -35);
  assert.ok(d(4000, 1.3, 1.5) < -35);
  assert.ok(Math.abs(d(4000, 0.97, 1.03)) < 1, 'erased part is kept');
  assert.ok(Math.abs(d(1000, 0.5, 0.8)) < 0.1, 'other frequencies untouched');
});

test('brush heal (spot healing brush) removes a click at a painted spot', () => {
  const clean = Float32Array.from({ length: SR * 2 }, (_, i) => sine(500, 0.2, i) + 0.02 * gauss());
  const x = clean.slice();
  for (let i = SR; i < SR * 1.004; i++) x[i] += (i % 2 ? 0.8 : -0.8) * Math.exp(-(i - SR) / 60);
  const o = x.slice();
  // One vertical dab over the click: a stroke from 1 kHz to 20 kHz at t = 1.001 s.
  const st = dsp.healRegion([o], SR, { strokes: [{ points: [[1.001, 1000], [1.001, 20000]], radiusMs: 6, radiusSemitones: 3 }] });
  assert.equal(st.shape, 'strokes');
  console.log(`  spot heal: click window rms clean ${rmsDb(clean, 0.98, 1.03).toFixed(2)}, clicked ${rmsDb(x, 0.98, 1.03).toFixed(2)}, healed ${rmsDb(o, 0.98, 1.03).toFixed(2)} dBFS; peak ${peak(x, 0.99, 1.02).toFixed(2)} → ${peak(o, 0.99, 1.02).toFixed(2)}`);
  assert.ok(peak(o, 0.99, 1.02) < 0.3, `peak still ${peak(o, 0.99, 1.02)}`);
  assert.ok(Math.abs(rmsDb(o, 0.98, 1.03) - rmsDb(clean, 0.98, 1.03)) < 1);
  assert.ok(Math.abs(toneDb(o, 500, 0.95, 1.05) - toneDb(clean, 500, 0.95, 1.05)) < 0.3, '500 Hz below the stroke survives');
  for (let i = 0; i < o.length; i++) if (i < SR * 0.9 || i > SR * 1.1) assert.equal(o[i], x[i]);
});

test('region masks are rasterised per frame: memory stays bounded for a long lasso and brush', () => {
  const x = new Float32Array(SR * 120);
  for (let i = 0; i < x.length; i++) x[i] = 0.05 * (rnd() - 0.5);
  // A 400-point ellipse spanning 110 s × 300 Hz–13 kHz: a full frame × bin mask would be ~4 MB per pass (Float64 ~8 MB).
  const poly = Array.from({ length: 400 }, (_, i) => { const a = (2 * Math.PI * i) / 400; return [60 + 55 * Math.cos(a), Math.exp(Math.log(2000) + 1.9 * Math.sin(a))]; });
  const strokes = [{ points: Array.from({ length: 2000 }, (_, i) => [2 + i * 0.05, 1000 + 4000 * Math.abs(Math.sin(i / 50))]), radiusMs: 40, radiusSemitones: 3 }];
  global.gc?.();
  const m0 = process.memoryUsage().arrayBuffers;
  let peakGrow = 0;
  const t0 = Date.now();
  dsp.attenuateRegion([x], SR, { polygon: poly, gainDb: -20 });
  peakGrow = Math.max(peakGrow, process.memoryUsage().arrayBuffers - m0);
  dsp.healRegion([x], SR, { strokes });
  peakGrow = Math.max(peakGrow, process.memoryUsage().arrayBuffers - m0);
  console.log(`  110 s lasso attenuate + 100 s brush heal on 2 min: ${Date.now() - t0} ms, array buffers grew ${(peakGrow / 1e6).toFixed(2)} MB`);
  assert.ok(peakGrow < 2e6, `array buffers grew by ${(peakGrow / 1e6).toFixed(1)} MB`);
});

test('pitch: 220 Hz tone, a glide, and silence', () => {
  const tone = Float32Array.from({ length: SR * 2 }, (_, i) => sine(220, 0.3, i) + 0.003 * gauss());
  const p = dsp.detectPitch(tone, SR, {});
  const s = dsp.summarizePitch(p);
  console.log(`  220 Hz tone → median ${s.medianHz} Hz (${s.minHz}–${s.maxHz}), voiced ${s.voicedFraction}, confidence ${s.meanConfidence}`);
  assert.ok(Math.abs(s.medianHz - 220) < 1, `median ${s.medianHz}`);
  assert.ok(s.voicedFraction > 0.95);
  assert.ok(s.minHz > 217 && s.maxHz < 223);
  // Glide 150 → 450 Hz over 2 s (linear in Hz).
  let ph = 0;
  const glide = Float32Array.from({ length: SR * 2 }, (_, i) => { ph += (2 * Math.PI * (150 + 150 * (i / SR))) / SR; return 0.3 * Math.sin(ph); });
  const g = dsp.detectPitch(glide, SR, {});
  let worst = 0;
  for (let i = 0; i < g.times.length; i++) {
    const t = g.times[i];
    if (t < 0.1 || t > 1.9) continue;
    const want = 150 + 150 * t;
    assert.ok(g.hz[i] !== null, `unvoiced at ${t}`);
    worst = Math.max(worst, Math.abs(g.hz[i] / want - 1));
  }
  console.log(`  glide 150 → 450 Hz: worst deviation ${(worst * 100).toFixed(2)}%`);
  assert.ok(worst < 0.01, `glide off by ${(worst * 100).toFixed(2)}%`);
  const quiet = Float32Array.from({ length: SR }, () => 1e-5 * gauss());
  assert.equal(dsp.summarizePitch(dsp.detectPitch(quiet, SR, {})).voicedFraction, 0);
  // Decimated track keeps the shape.
  const pts = dsp.pitchPoints(g, 20);
  assert.equal(pts.length, 20);
  assert.ok(pts[19][1] > pts[0][1] * 2.2);
});

test('spectrogram PNG has the requested size', () => {
  const x = Float32Array.from({ length: SR }, (_, i) => sine(1000, 0.5, i));
  const png = dsp.renderSpectrogram((from, count) => [Float32Array.from({ length: count }, (_, i) => x[from + i] ?? 0)], SR, x.length, { start: 0, end: 1, width: 120, height: 60, minHz: 30, maxHz: 24000 });
  assert.equal(png.readUInt32BE(16), 120);
  assert.equal(png.readUInt32BE(20), 60);
});

// ── API + MCP ────────────────────────────────────────────────────────────
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
let server;
async function j(method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', 'X-Actor': 'agent:spectral-test' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const mcp = (name, args) => j('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

before(async () => {
  server = spawn('node', ['server/index.js'], { env: { ...process.env, PORT, KLANG_DATA: path.join(dir, 'data') }, stdio: 'pipe' });
  for (let i = 0; i < 200; i++) {
    try { await fetch(BASE + '/api'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});
after(() => { server?.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

let pid, assetId, clipId;
test('API: import noisy speech-like audio and place it', async () => {
  pid = (await j('POST', '/api/projects', { name: 'Spectral', sampleRate: 48000 })).data.id;
  const f = path.join(dir, 'noisy.wav');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=800:d=4:sample_rate=48000', '-f', 'lavfi', '-i', 'anoisesrc=d=5:c=white:a=0.03:r=48000:seed=7',
    '-filter_complex', '[0]volume=0.5,adelay=1000:all=1[s];[s][1]amix=inputs=2:normalize=0:duration=longest', f]);
  const res = await fetch(`${BASE}/api/projects/${pid}/assets?name=voice`, { method: 'POST', body: fs.readFileSync(f), headers: { 'Content-Type': 'audio/wav' } });
  assert.equal(res.status, 201);
  assetId = (await res.json()).id;
  const r = await j('POST', `/api/projects/${pid}/ops`, { ops: [{ op: 'track.add', args: { name: 'Voice' } }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId, start: 2 } }] });
  clipId = r.data.results[1].clipId;
});

test('API: spectrogram PNG with exact mapping headers', async () => {
  const res = await fetch(`${BASE}/api/projects/${pid}/assets/${assetId}/spectrogram?start=0.5&end=3&width=400&height=150&minHz=40`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-freq-scale'), 'log');
  assert.equal(res.headers.get('x-freq-min'), '40');
  assert.equal(res.headers.get('x-freq-max'), '24000');
  const png = Buffer.from(await res.arrayBuffer());
  assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 400);
  assert.equal(png.readUInt32BE(20), 150);
});

test('API: noise print → denoise-print swaps clips; undo restores', async () => {
  const none = await j('GET', `/api/projects/${pid}/assets/${assetId}/noiseprint`);
  assert.equal(none.data.noisePrint, null);
  const bad = await j('POST', `/api/projects/${pid}/assets/${assetId}/denoise-print`, {});
  assert.equal(bad.status, 409);
  const np = await j('POST', `/api/projects/${pid}/assets/${assetId}/noiseprint`, { start: 0, end: 0.9 });
  assert.equal(np.status, 201, JSON.stringify(np.data));
  assert.ok(np.data.noisePrint.frames > 50);
  assert.match(np.data.noisePrint.character, /Broadband/);
  const got = await j('GET', `/api/projects/${pid}/assets/${assetId}/noiseprint`);
  assert.equal(got.data.noisePrint.storedOn, assetId);

  const r = await j('POST', `/api/projects/${pid}/assets/${assetId}/denoise-print`, { reductionDb: 20 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.clipsUpdated, 1);
  assert.match(r.data.asset.name, /voice · noise reduction/);
  const m = r.data.measured.noisePrintRangeDbfs;
  assert.ok(m.after < m.before - 17, `noise ${m.before} → ${m.after}`);
  let p = (await j('GET', `/api/projects/${pid}`)).data;
  assert.equal(p.tracks[0].clips[0].assetId, r.data.asset.id);
  // The derived asset finds the print of its source.
  const inherited = await j('GET', `/api/projects/${pid}/assets/${r.data.asset.id}/noiseprint`);
  assert.equal(inherited.data.noisePrint.storedOn, assetId);
  await j('POST', `/api/projects/${pid}/undo`);
  p = (await j('GET', `/api/projects/${pid}`)).data;
  assert.equal(p.tracks[0].clips[0].assetId, assetId);
});

test('API: spectral attenuate and heal create swapped assets; bad regions are rejected', async () => {
  const bad = await j('POST', `/api/projects/${pid}/assets/${assetId}/spectral`, { action: 'heal', start: 2, end: 1 });
  assert.equal(bad.status, 400);
  const bad2 = await j('POST', `/api/projects/${pid}/assets/${assetId}/spectral`, { action: 'blur', start: 1, end: 2 });
  assert.equal(bad2.status, 400);
  const r = await j('POST', `/api/projects/${pid}/assets/${assetId}/spectral`, { action: 'attenuate', start: 1.5, end: 2.5, lowHz: 600, highHz: 1000, gainDb: -40 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.clipsUpdated, 1);
  const out = await readWav(path.join(dir, 'data', 'projects', pid, 'assets', `${r.data.asset.id}.wav`));
  const src = await readWav(path.join(dir, 'data', 'projects', pid, 'assets', `${assetId}.wav`));
  const drop = toneDb(src.channels[0], 800, 1.7, 2.3) - toneDb(out.channels[0], 800, 1.7, 2.3);
  assert.ok(drop > 30, `800 Hz dropped only ${drop.toFixed(1)} dB`);
  assert.ok(Math.abs(toneDb(src.channels[0], 800, 3.2, 3.8) - toneDb(out.channels[0], 800, 3.2, 3.8)) < 0.05);
  const h = await j('POST', `/api/projects/${pid}/assets/${r.data.asset.id}/spectral`, { action: 'heal', start: 3, end: 3.05 });
  assert.equal(h.status, 201, JSON.stringify(h.data));
  assert.match(h.data.asset.name, /· spectral edit$/);
  assert.doesNotMatch(h.data.asset.name, /spectral edit · spectral edit/);
});

test('API: lasso attenuate and brush spot heal round-trip; undo restores; bad regions are rejected', async () => {
  const base = `/api/projects/${pid}/assets/${assetId}/spectral`;
  const cases = [
    [{ action: 'attenuate', polygon: [[1, 500], [2, 500]] }, /at least 3/],
    [{ action: 'attenuate', start: 1, end: 2, polygon: [[1, 500], [2, 500], [2, 900]] }, /exactly one region/],
    [{ action: 'heal', strokes: [] }, /at least one stroke/],
    [{ action: 'heal', strokes: [{ points: [[1, 500]], erase: true }] }, /only erase/],
    [{ action: 'heal', strokes: [{ points: [[1, 500, 3]] }] }, /\[t, hz\]/],
    [{ action: 'heal', strokes: [{ points: [[1, 500]], size: 3 }] }, /not a known field/],
    [{ action: 'attenuate', polygon: [[1, 500], [2, 500], [2, 900]], lowHz: 100 }, /only apply to a box/],
    [{ action: 'heal', strokes: [{ points: [[99, 500]] }] }, /after the end/],
  ];
  for (const [body, re] of cases) {
    const r = await j('POST', base, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.data.error.message, re);
  }
  // Lasso around the 800 Hz tone in 1.5–2.5 s only.
  const before = (await j('GET', `/api/projects/${pid}`)).data.tracks[0].clips[0].assetId;
  const srcAsset = before;
  const r = await j('POST', `/api/projects/${pid}/assets/${srcAsset}/spectral`, { action: 'attenuate', gainDb: -40, polygon: [[1.5, 600], [2.5, 600], [2.5, 1000], [1.5, 1000]] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.region.shape, 'polygon');
  assert.equal(r.data.clipsUpdated, 1);
  assert.match(r.data.asset.name, /spectral edit$/);
  const wav = (id) => readWav(path.join(dir, 'data', 'projects', pid, 'assets', `${id}.wav`));
  const src = (await wav(srcAsset)).channels[0], out = (await wav(r.data.asset.id)).channels[0];
  const drop = toneDb(src, 800, 1.7, 2.3) - toneDb(out, 800, 1.7, 2.3);
  assert.ok(drop > 30, `800 Hz dropped only ${drop.toFixed(1)} dB`);
  assert.ok(Math.abs(toneDb(src, 800, 3.2, 3.8) - toneDb(out, 800, 3.2, 3.8)) < 0.05);
  // Spot heal on the result.
  const h = await j('POST', `/api/projects/${pid}/assets/${r.data.asset.id}/spectral`, { action: 'heal', strokes: [{ points: [[3.1, 2000], [3.1, 12000]], radiusMs: 10, radiusSemitones: 3 }] });
  assert.equal(h.status, 201, JSON.stringify(h.data));
  assert.equal(h.data.region.shape, 'strokes');
  assert.deepEqual(h.data.region.strokes[0].points, [[3.1, 2000], [3.1, 12000]]);
  assert.ok(h.data.region.bounds.start < 3.1 && h.data.region.bounds.end > 3.1);
  let p = (await j('GET', `/api/projects/${pid}`)).data;
  assert.equal(p.tracks[0].clips[0].assetId, h.data.asset.id);
  assert.equal(p.assets.find((a) => a.id === h.data.asset.id).process.params.shape, 'strokes');
  // Samples far from the stroke are bit-identical.
  const healed = (await wav(h.data.asset.id)).channels[0], prev = (await wav(r.data.asset.id)).channels[0];
  for (let i = 0; i < healed.length; i += 97) if (Math.abs(i / SR - 3.1) > 0.15) assert.equal(healed[i], prev[i]);
  await j('POST', `/api/projects/${pid}/undo`);
  p = (await j('GET', `/api/projects/${pid}`)).data;
  assert.equal(p.tracks[0].clips[0].assetId, r.data.asset.id);
  await j('POST', `/api/projects/${pid}/undo`);
  p = (await j('GET', `/api/projects/${pid}`)).data;
  assert.equal(p.tracks[0].clips[0].assetId, srcAsset);
});

test('API: pitch track of the 800 Hz tone', async () => {
  const r = await j('GET', `/api/projects/${pid}/assets/${assetId}/pitch?start=0.5&end=3&maxPoints=50`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.track.length, 50);
  assert.ok(Math.abs(r.data.summary.medianHz - 800) < 4, JSON.stringify(r.data.summary));
  // 0.5–1 s is noise only, 1–3 s is the tone: about 80% voiced.
  assert.ok(r.data.summary.voicedFraction > 0.7 && r.data.summary.voicedFraction < 0.9, JSON.stringify(r.data.summary));
  const early = r.data.track.filter(([t]) => t < 0.95), late = r.data.track.filter(([t]) => t > 1.05);
  assert.ok(early.every(([, hz]) => hz === null));
  assert.ok(late.every(([, hz]) => Math.abs(hz - 800) < 5));
  const full = await j('GET', `/api/projects/${pid}/assets/${assetId}/pitch?start=1&end=2`);
  assert.equal(full.data.track.length, 101);
  assert.equal((await j('GET', `/api/projects/${pid}/assets/${assetId}/pitch?start=2&end=1`)).status, 400);
});

test('MCP: spectral tools are listed and noise_reduction learns + applies in one call', async () => {
  const list = await j('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = list.data.result.tools.map((t) => t.name);
  for (const n of ['spectral_edit', 'noise_reduction', 'spectral_image', 'get_pitch']) assert.ok(names.includes(n), n);
  const se = list.data.result.tools.find((t) => t.name === 'spectral_edit');
  assert.ok(se.inputSchema.properties.polygon && se.inputSchema.properties.strokes);
  assert.deepEqual(se.inputSchema.required, ['projectId', 'action']);
  const r = await mcp('noise_reduction', { projectId: pid, clipId, start: 0, end: 0.8, reductionDb: 18 });
  assert.ok(!r.data.result.isError, JSON.stringify(r.data));
  const body = JSON.parse(r.data.result.content[0].text);
  assert.equal(body.noisePrint.learnedNow, true);
  assert.ok(body.measured.noisePrintRangeDbfs.after < body.measured.noisePrintRangeDbfs.before - 15);
  const img = await mcp('spectral_image', { projectId: pid, clipId, width: 300, height: 120 });
  assert.equal(img.data.result.content[0].type, 'image');
  assert.match(img.data.result.content[1].text, /log scale/);
  const e = await mcp('spectral_edit', { projectId: pid, clipId, action: 'attenuate', start: 1, end: 1.5, lowHz: 700, highHz: 900 });
  assert.ok(!e.data.result.isError, JSON.stringify(e.data));
  const sp = await mcp('spectral_edit', { projectId: pid, clipId, action: 'heal', strokes: [{ points: [[2.2, 3000]], radiusMs: 8, radiusSemitones: 12 }] });
  assert.ok(!sp.data.result.isError, JSON.stringify(sp.data));
  assert.equal(JSON.parse(sp.data.result.content[0].text).region.shape, 'strokes');
  const pi = await mcp('get_pitch', { projectId: pid, clipId });
  assert.ok(!pi.data.result.isError, JSON.stringify(pi.data));
  const pj = JSON.parse(pi.data.result.content[0].text);
  assert.ok(Math.abs(pj.summary.medianHz - 800) < 4, JSON.stringify(pj.summary));
  assert.ok(pj.track.length <= 120 && pj.track.length >= 100);
  assert.ok(pj.summary.voicedFraction > 0.6);
});
