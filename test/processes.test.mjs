// Audition-style destructive processes (server/audition_fx.py): centre extraction, dereverb,
// sound remover, phase alignment, Doppler and pitch bend — each measured on synthetic audio
// through the real API (new asset, swapped into clips, range + preview plumbing).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort } from './helpers.mjs';
import { readWav, writeWav } from '../server/audio.js';

const SR = 48000;
const TAU = 2 * Math.PI;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klang-proc-'));
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
let server, pid;

async function j(method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', 'X-Actor': 'agent:process-test' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
async function upload(name, channels) {
  const f = path.join(dir, `${name}.wav`);
  await writeWav(f, channels.map((c) => Float32Array.from(c)), SR);
  const res = await fetch(`${BASE}/api/projects/${pid}/assets?name=${name}`, { method: 'POST', body: fs.readFileSync(f), headers: { 'Content-Type': 'audio/wav' } });
  assert.equal(res.status, 201);
  return (await res.json()).id;
}
const assetWav = (id) => readWav(path.join(dir, 'data', 'projects', pid, 'assets', `${id}.wav`));
async function processed(assetId, kind, params, extra = {}) {
  const r = await j('POST', `/api/projects/${pid}/assets/${assetId}/process`, { kind, params, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { ...(await assetWav(r.data.asset.id)), result: r.data };
}

const db = (x) => 20 * Math.log10(x + 1e-30);
const rms = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };
const S = (s) => Math.round(s * SR);
// Amplitude of the component at f in x[a, b) (Hann-windowed DFT).
function amp(x, f, a = 0, b = x.length) {
  let re = 0, im = 0, ws = 0;
  for (let i = a; i < b; i++) { const w = 0.5 - 0.5 * Math.cos((TAU * (i - a)) / (b - a)); ws += w; re += w * x[i] * Math.cos((TAU * f * i) / SR); im += w * x[i] * Math.sin((TAU * f * i) / SR); }
  return (2 * Math.hypot(re, im)) / ws;
}
// Dominant frequency in x[a, b): coarse scan, then golden-section refinement of the DFT peak.
function domFreq(x, a, b, lo, hi) {
  let best = lo, bv = 0;
  for (let f = lo; f <= hi; f += 2) { const v = amp(x, f, a, b); if (v > bv) { bv = v; best = f; } }
  let l = best - 2, h = best + 2;
  for (let k = 0; k < 30; k++) { const m1 = l + (h - l) * 0.382, m2 = l + (h - l) * 0.618; if (amp(x, m1, a, b) > amp(x, m2, a, b)) h = m2; else l = m1; }
  return (l + h) / 2;
}
function corr(a, b, from, to) {
  let ab = 0, aa = 0, bb = 0;
  for (let i = from; i < to; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return ab / Math.sqrt(aa * bb);
}
// Deterministic noise.
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; }; }

before(async () => {
  server = spawn('node', ['server/index.js'], { env: { ...process.env, PORT, KLANG_DATA: path.join(dir, 'data') }, stdio: 'pipe' });
  for (let i = 0; i < 200; i++) {
    try { await fetch(BASE + '/api'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  pid = (await j('POST', '/api/projects', { name: 'Processes', sampleRate: SR })).data.id;
});
after(() => { server?.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('the six Audition processes are listed with numeric params', async () => {
  const { data } = await j('GET', '/api/processes');
  for (const k of ['centerExtract', 'dereverb', 'soundRemove', 'phaseAlign', 'doppler', 'pitchBend']) {
    assert.ok(data[k]?.description?.length > 40, k);
    for (const [p, s] of Object.entries(data[k].params)) assert.ok(['number', 'integer'].includes(s.type) && s.default !== undefined, `${k}.${p}`);
  }
  assert.equal(data.pitchBend.keepsLength, false);
  assert.equal(data.doppler.keepsLength, true);
});

test('centerExtract: keeps the centred tone and kills the hard-left one (and the reverse)', async () => {
  const n = S(3);
  const c = Array.from({ length: n }, (_, i) => 0.3 * Math.sin((TAU * 440 * i) / SR));
  const l = Array.from({ length: n }, (_, i) => 0.3 * Math.sin((TAU * 1000 * i) / SR));
  const id = await upload('centre', [c.map((v, i) => v + l[i]), c]);
  const src = await assetWav(id);
  const chg = (o, ch, f) => db(amp(o.channels[ch], f, S(0.5), S(2.5))) - db(amp(src.channels[0], f, S(0.5), S(2.5)));
  const ex = await processed(id, 'centerExtract', { mode: 0, lowHz: 20, highHz: 20000, strength: 1 });
  const rm = await processed(id, 'centerExtract', { mode: 1, lowHz: 20, highHz: 20000, strength: 1 });
  console.log(`  extract: 440 Hz ${chg(ex, 0, 440).toFixed(2)} dB, 1 kHz ${chg(ex, 0, 1000).toFixed(1)} dB; remove: 440 Hz ${chg(rm, 0, 440).toFixed(1)} dB, 1 kHz ${chg(rm, 0, 1000).toFixed(2)} dB`);
  assert.ok(chg(ex, 0, 440) >= -1 && chg(ex, 1, 440) >= -1);
  assert.ok(chg(ex, 0, 1000) <= -20);
  assert.ok(chg(rm, 0, 440) <= -20 && chg(rm, 1, 440) <= -20);
  assert.ok(chg(rm, 0, 1000) >= -1);
  // Only the band it is told to act on.
  const band = await processed(id, 'centerExtract', { mode: 0, lowHz: 2000, highHz: 20000, strength: 1 });
  assert.ok(Math.abs(chg(band, 0, 1000)) < 0.5, 'outside lowHz–highHz untouched');
  // Mono input → clear 400.
  const mono = await upload('mono', [c]);
  const bad = await j('POST', `/api/projects/${pid}/assets/${mono}/process`, { kind: 'centerExtract', params: {} });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error.message, /stereo/);
});

test('dereverb: tail after bursts drops ≥ 6 dB, direct sound stays within 1.5 dB', async () => {
  const n = S(8), bl = S(0.03), r = rng(3);
  const dry = new Float64Array(n);
  const onsets = [0.3, 1.3, 2.3, 3.3, 4.3, 5.3, 6.3].map(S); // 1 s apart: each tail still rings into the next burst
  for (const o of onsets) for (let i = 0; i < bl; i++) dry[o + i] += 0.5 * Math.sin((TAU * 1000 * i) / SR) * (0.5 - 0.5 * Math.cos((TAU * i) / bl));
  // Room: direct path + exponentially decaying noise, RT60 = 1 s (−60 dB per second).
  const ir = Array.from({ length: S(1.2) }, (_, i) => (i === 0 ? 1 : i < S(0.003) ? 0 : 0.15 * r() * Math.exp((-6.9 * i) / SR)));
  const wet = new Float32Array(n);
  for (const o of onsets) for (let i = 0; i < bl; i++) { const d = dry[o + i]; if (!d) continue; for (let k = 0; k < ir.length && o + i + k < n; k++) wet[o + i + k] += d * ir[k]; }
  const id = await upload('room', [wet]);
  for (const rt60 of [0, 1]) {
    const out = await processed(id, 'dereverb', { amount: 0.7, rt60 });
    const y = out.channels[0];
    const direct = onsets.slice(1, 6).map((o) => db(rms(y, o, o + bl)) - db(rms(wet, o, o + bl)));
    const tail = onsets.slice(1, 6).map((o) => db(rms(y, o + bl + S(0.1), o + bl + S(0.6))) - db(rms(wet, o + bl + S(0.1), o + bl + S(0.6))));
    console.log(`  rt60 ${rt60 || 'auto'} (${JSON.stringify(out.result.asset.process.params.measured)}): direct ${direct.map((v) => v.toFixed(2)).join(', ')} dB; tail ${tail.map((v) => v.toFixed(1)).join(', ')} dB`);
    for (const d of direct) assert.ok(Math.abs(d) <= 1.5, `direct ${d}`);
    for (const t of tail) assert.ok(t <= -6, `tail ${t}`);
    if (!rt60) assert.ok(Math.abs(out.result.asset.process.params.measured.rt60Estimated - 1) < 0.3, 'RT60 estimated near 1 s');
  }
});

test('soundRemove: learns a ringtone from one ring and removes the other one', async () => {
  const n = S(8), r = rng(5);
  const speech = new Float64Array(n), ring = new Float64Array(n);
  const f0s = [140, 170, 200, 230, 260];
  for (let a = 0; a < n; a += S(0.25)) {
    const f0 = f0s[Math.floor((r() + 0.5) * 5)], L = S(0.22);
    for (let i = 0; i < L && a + i < n; i++) {
      let v = 0; for (let h = 1; h <= 6; h++) v += (0.25 / h) * Math.sin((TAU * f0 * h * i) / SR);
      speech[a + i] = v * (0.5 - 0.5 * Math.cos((TAU * i) / L));
    }
  }
  for (let i = S(0.95); i < S(2.05); i++) speech[i] = 0; // the first ring happens in a pause: a clean example
  for (const t0 of [1, 5]) {
    let ph = 0;
    for (let i = 0; i < S(1); i++) { const t = i / SR; ph += (TAU * (Math.floor(t / 0.05) % 2 ? 2300 : 1800)) / SR; ring[S(t0) + i] = 0.2 * Math.sin(ph) * Math.min(1, t / 0.005, (1 - t) / 0.005); }
  }
  const x = Array.from(speech, (v, i) => v + ring[i]);
  const id = await upload('ring', [x]);
  const out = await processed(id, 'soundRemove', { strength: 1, sensitivity: 0.5, learnStart: 1, learnEnd: 2 });
  const y = out.channels[0];
  const resid = Array.from({ length: S(1) }, (_, i) => y[S(5) + i] - speech[S(5) + i]);
  const ring2 = db(rms(resid)) - db(rms(ring, S(5), S(6)));
  const other = [[0, 0.9], [2.2, 4.8], [6.2, 8]].map(([a, b]) => db(rms(y, S(a), S(b))) - db(rms(x, S(a), S(b))));
  console.log(`  second ring ${ring2.toFixed(1)} dB; other content ${other.map((v) => v.toFixed(2)).join(', ')} dB; ${JSON.stringify(out.result.asset.process.params.measured)}`);
  assert.ok(ring2 <= -15, `ring ${ring2}`);
  for (const o of other) assert.ok(Math.abs(o) <= 1.5, `other ${o}`);
  const bad = await j('POST', `/api/projects/${pid}/assets/${id}/process`, { kind: 'soundRemove', params: {} });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error.message, /learnStart/);
});

test('phaseAlign: finds a 0.5 ms inter-channel delay and aligns R to L', async () => {
  const n = S(3), r = rng(1);
  let lp = 0;
  const L = Array.from({ length: n }, () => (lp = 0.95 * lp + 0.05 * r()));
  const d = S(0.0005);
  const R = L.map((_, i) => (i >= d ? L[i - d] : 0));
  const id = await upload('phase', [L, R]);
  const src = await assetWav(id);
  const out = await processed(id, 'phaseAlign', { maxShiftMs: 10, centre: 0 });
  const m = out.result.asset.process.params.measured;
  const c = corr(out.channels[0], out.channels[1], S(0.1), n - S(0.1));
  console.log(`  offset ${m.offsetMs} ms; correlation ${corr(src.channels[0], src.channels[1], S(0.1), n - S(0.1)).toFixed(3)} → ${c.toFixed(5)}`);
  assert.ok(Math.abs(m.offsetMs - 0.5) < 0.02, `offset ${m.offsetMs}`);
  assert.ok(c > 0.99, `correlation ${c}`);
  const mid = await processed(id, 'phaseAlign', { maxShiftMs: 10, centre: 1 });
  assert.ok(corr(mid.channels[0], mid.channels[1], S(0.1), n - S(0.1)) > 0.99);
});

test('doppler: pitch is higher before the pass than after; same length', async () => {
  const n = S(4);
  const id = await upload('car', [Array.from({ length: n }, (_, i) => 0.5 * Math.sin((TAU * 1000 * i) / SR))]);
  const out = await processed(id, 'doppler', { speed: 30, distance: 10, passTime: 2, volumeChange: 1 });
  const y = out.channels[0];
  const fb = domFreq(y, S(0.8), S(1.6), 900, 1200), fa = domFreq(y, S(2.4), S(3.2), 800, 1100);
  console.log(`  before ${fb.toFixed(1)} Hz, after ${fa.toFixed(1)} Hz (c/(c∓v): ${(1000 * 343 / 313).toFixed(0)} / ${(1000 * 343 / 373).toFixed(0)})`);
  assert.equal(out.frames, n);
  assert.ok(fb > 1050 && fa < 950, `${fb} / ${fa}`);
  assert.equal(out.result.clipsUpdated, 0);
});

test('pitchBend: 0 → +12 st shortens by the mean rate and ends an octave up', async () => {
  const n = S(4);
  const id = await upload('tape', [Array.from({ length: n }, (_, i) => 0.5 * Math.sin((TAU * 440 * i) / SR))]);
  const out = await processed(id, 'pitchBend', { startSemitones: 0, endSemitones: 12, curve: 0 });
  const y = out.channels[0];
  const expected = n * (1 - 0.5) / Math.LN2; // ∫ 2^(−f) df over the file
  const f0 = domFreq(y, S(0.02), S(0.07), 400, 500), f1 = domFreq(y, y.length - S(0.06), y.length - S(0.01), 800, 950);
  console.log(`  length ${(out.frames / n).toFixed(4)}× (expected ${(expected / n).toFixed(4)}×); start ${f0.toFixed(1)} Hz, end ${f1.toFixed(1)} Hz (ratio ${(f1 / f0).toFixed(3)})`);
  assert.ok(Math.abs(out.frames - expected) < S(0.01));
  assert.ok(Math.abs(f1 / f0 - 2) < 0.04, `ratio ${f1 / f0}`);
  // Length-changing: no range processing.
  const bad = await j('POST', `/api/projects/${pid}/assets/${id}/process`, { kind: 'pitchBend', params: {}, start: 0, end: 1 });
  assert.equal(bad.status, 400);
});

test('range processing and preview work for the new kinds', async () => {
  const n = S(3);
  const id = await upload('rangeTone', [Array.from({ length: n }, (_, i) => 0.4 * Math.sin((TAU * 600 * i) / SR))]);
  const out = await processed(id, 'doppler', { speed: 40, distance: 5, passTime: -1, volumeChange: 0 }, { start: 1, end: 2 });
  const src = await assetWav(id);
  let diffOutside = 0;
  for (let i = 0; i < S(0.9); i++) diffOutside = Math.max(diffOutside, Math.abs(out.channels[0][i] - src.channels[0][i]));
  assert.ok(diffOutside < 1e-6, 'outside the range untouched');
  const res = await fetch(`${BASE}/api/projects/${pid}/assets/${id}/process-preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'dereverb', params: { amount: 0.5 }, start: 0, end: 1 }) });
  assert.equal(res.status, 200);
  assert.ok((await res.arrayBuffer()).byteLength > SR * 4 * 0.9);
});
