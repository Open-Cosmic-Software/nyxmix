// More effects (morefx.js + the processors appended to dsp-worklet.js): every effect renders
// cleanly, a render that starts mid-timeline matches the full render, and each one does what
// its description says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { OfflineAudioContext, AudioWorkletNode } from 'node-web-audio-api';
import { buildMoreEffect, MORE_EFFECTS } from '../public/js/engine/morefx.js';

const SR = 48000;
const WORKLET = fileURLToPath(new URL('../public/js/engine/dsp-worklet.js', import.meta.url));
const defaults = (type) => Object.fromEntries(Object.entries(MORE_EFFECTS[type].params).map(([k, v]) => [k, v.default]));
const P = (type) => (params) => ({ ...defaults(type), ...(params || {}) });
const TYPES = Object.keys(MORE_EFFECTS);

/**
 * Render `seconds` of the effect starting at timeline time `from`. `signal(t, ch)` gives the
 * input sample at timeline time t, so the input is identical whatever `from` is.
 */
async function render(type, { params = {}, from = 0, seconds = 1, signal }) {
  const n = Math.round(SR * seconds);
  const ctx = new OfflineAudioContext(2, n, SR);
  await ctx.audioWorklet.addModule(WORKLET);
  const buf = ctx.createBuffer(2, n, SR);
  const f0 = Math.round(from * SR);
  for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < n; i++) d[i] = signal((f0 + i) / SR, ch); }
  const src = ctx.createBufferSource(); src.buffer = buf;
  const fx = buildMoreEffect(ctx, { id: 'x', type, params }, P(type), { from, when: 0 }, AudioWorkletNode);
  src.connect(fx.input); fx.output.connect(ctx.destination); src.start(0);
  const out = await ctx.startRendering();
  // Copy: the rendered buffer's memory belongs to the native context.
  return [new Float32Array(out.getChannelData(0)), new Float32Array(out.getChannelData(1))];
}

const TAU = 2 * Math.PI;
const sine = (f, a = 0.5) => (t) => a * Math.sin(TAU * f * t);
// Music-like test signal: three partials with a 2 Hz swelling envelope, slightly different per channel.
const music = (t, ch) => 0.5 * (0.3 + 0.7 * Math.abs(Math.sin(TAU * 2 * t)) ** 4) * (0.6 * Math.sin(TAU * 220 * t) + 0.3 * Math.sin(TAU * 331 * t + ch) + 0.2 * Math.sin(TAU * 1250 * t));
const db = (x) => 20 * Math.log10(x);
const rms = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };
const peak = (x, a = 0, b = x.length) => { let m = 0; for (let i = a; i < b; i++) m = Math.max(m, Math.abs(x[i])); return m; };
// Amplitude of the component at frequency f (Hann-windowed DFT bin, exact for whole-window tones within ~1%).
function amp(x, f, a = 0, b = x.length) {
  let re = 0, im = 0, wsum = 0;
  for (let i = a; i < b; i++) {
    const w = 0.5 - 0.5 * Math.cos((TAU * (i - a)) / (b - a)); wsum += w;
    re += w * x[i] * Math.cos((TAU * f * i) / SR); im += w * x[i] * Math.sin((TAU * f * i) / SR);
  }
  return (2 * Math.hypot(re, im)) / wsum;
}
const S = (s) => Math.round(s * SR);
const maxDiff = (a, b, from, to) => { let m = 0; for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

// Extreme settings: every parameter at its minimum, every parameter at its maximum.
const extremes = (type, which) => Object.fromEntries(Object.entries(MORE_EFFECTS[type].params).map(([k, v]) => [k, v[which]]));

test('every effect definition is well formed', () => {
  assert.ok(TYPES.length >= 13);
  for (const [type, def] of Object.entries(MORE_EFFECTS)) {
    assert.ok(def.label && def.description, type);
    for (const [k, s] of Object.entries(def.params)) {
      assert.equal(s.type, 'number', `${type}.${k}`);
      assert.ok(s.minimum <= s.default && s.default <= s.maximum, `${type}.${k} default in range`);
    }
  }
  assert.equal(buildMoreEffect(null, { type: 'nope' }, () => ({}), {}), null);
});

// (a) Builds and renders without NaN/Inf; output bounded for default, minimum and maximum settings.
for (const type of TYPES) {
  test(`${type}: renders finite, bounded output (default/min/max params)`, async () => {
    // Defaults must stay near unity; extreme settings may legitimately add up to ~+36 dB (e.g. every EQ band and the output at maximum).
    for (const [params, bound] of [[{}, 2], [extremes(type, 'minimum'), 64], [extremes(type, 'maximum'), 64]]) {
      const [L, R] = await render(type, { params, seconds: 0.5, signal: music });
      for (const x of [L, R]) {
        for (let i = 0; i < x.length; i++) assert.ok(Number.isFinite(x[i]), `${type} ${JSON.stringify(params)}: non-finite sample at ${i}`);
        assert.ok(peak(x) < bound, `${type} ${JSON.stringify(params)}: peak ${peak(x)}`);
      }
    }
  });
}

// (b) Parity: starting at timeline 2 s must sound like the tail of a render from 0.
// b1 — input silent before 2 s: both renders start with empty delay lines/envelopes, so the
//   only possible difference is timeline-locked state (LFO, grain-window and sample-and-hold
//   phase). Tolerance 2e-3 (≈ −54 dBFS): native oscillators use wavetables, and float32
//   accumulation differs slightly between a phase set at 2 s and one reached by running.
// b2 — continuous input: the tail render lacks the history (echo tails, envelope state, the
//   pitch shifter's splice offsets), so we compare only after a 1 s settle window (longest
//   memory here: ping-pong set to 100 ms × feedback 0.3, the 350 ms sustain envelope of the
//   transient shaper, one grain cycle of the pitch shifter at +7 st ≈ 120 ms).
const PARITY = { pingpong: { time: 100, feedback: 0.3 }, pitchshift: { semitones: 7 } };
for (const type of TYPES) {
  test(`${type}: render from 2 s equals the tail of a render from 0 s`, async () => {
    const params = PARITY[type] || {};
    const late = (t, ch) => (t < 2 ? 0 : music(t, ch));
    let full = await render(type, { params, seconds: 4, signal: late });
    let tail = await render(type, { params, from: 2, seconds: 2, signal: late });
    for (let ch = 0; ch < 2; ch++) {
      const d = maxDiff(full[ch].subarray(S(2)), tail[ch], 0, S(2));
      assert.ok(d < 2e-3, `silent history, ch ${ch}: max diff ${d}`);
    }
    full = await render(type, { params, seconds: 4, signal: music });
    tail = await render(type, { params, from: 2, seconds: 2, signal: music });
    for (let ch = 0; ch < 2; ch++) {
      const d = maxDiff(full[ch].subarray(S(2)), tail[ch], S(1), S(2));
      assert.ok(d < 2e-3, `continuous input after settle, ch ${ch}: max diff ${d}`);
    }
  });
}

// (c) Functional checks.
test('filter: 12 dB/oct slopes, bell gain and notch depth at the expected frequencies', async () => {
  const g = async (params, f) => { const [L] = await render('filter', { params, seconds: 0.5, signal: sine(f) }); return db(amp(L, f, S(0.1)) / 0.5); };
  const lp = { mode: 0, frequency: 1000 };
  assert.ok(Math.abs(await g(lp, 250)) < 0.3, 'lowpass passband');
  const lp4k = await g(lp, 4000);
  assert.ok(lp4k < -22 && lp4k > -27, `lowpass two octaves up: ${lp4k} dB (2nd order ≈ −24)`);
  const hp250 = await g({ mode: 1, frequency: 1000 }, 250);
  assert.ok(hp250 < -22 && hp250 > -27, `highpass two octaves down: ${hp250} dB`);
  assert.ok(Math.abs((await g({ mode: 6, frequency: 1000, gain: 6 }, 1000)) - 6) < 0.1, 'peaking +6 dB');
  assert.ok((await g({ mode: 3, frequency: 1000, Q: 1 }, 1000)) < -30, 'notch');
  assert.ok(Math.abs((await g({ mode: 4, frequency: 200, gain: -9 }, 40)) + 9) < 0.5, 'lowshelf −9 dB');
});

test('graphiceq: flat at 0 dB, +12 dB on the 1 kHz band hits +12 dB at 1 kHz', async () => {
  const [flat] = await render('graphiceq', { seconds: 0.3, signal: music });
  const dry = Float32Array.from({ length: flat.length }, (_, i) => music(i / SR, 0));
  assert.ok(maxDiff(flat, dry, 0, flat.length) < 1e-5, 'all bands at 0 dB is transparent');
  const [L] = await render('graphiceq', { params: { b1k: 12 }, seconds: 0.5, signal: sine(1000, 0.1) });
  assert.ok(Math.abs(db(amp(L, 1000, S(0.1)) / 0.1) - 12) < 0.2);
});

test('multiband: with ratios at 1 the three LR4 bands sum flat (within 0.1 dB); a band compresses on its own', async () => {
  const off = { lowRatio: 1, midRatio: 1, highRatio: 1 };
  for (const f of [40, 100, 200, 500, 1000, 3000, 6000, 12000]) {
    const [L] = await render('multiband', { params: off, seconds: 0.5, signal: sine(f) });
    const g = db(rms(L, S(0.2)) / (0.5 / Math.SQRT2));
    assert.ok(Math.abs(g) < 0.1, `${f} Hz: ${g.toFixed(3)} dB`);
  }
  // Squash only the low band: a loud 80 Hz tone drops, a 1 kHz tone of the same level does not.
  const squash = { ...off, lowThreshold: -40, lowRatio: 10 };
  const [lo] = await render('multiband', { params: squash, seconds: 1, signal: sine(80) });
  const [mid] = await render('multiband', { params: squash, seconds: 1, signal: sine(1000) });
  assert.ok(db(rms(lo, S(0.5)) / (0.5 / Math.SQRT2)) < -15, 'low band compressed');
  assert.ok(Math.abs(db(rms(mid, S(0.5)) / (0.5 / Math.SQRT2))) < 0.2, 'mid band untouched');
});

test('expander: a tone 10 dB under threshold drops 10 dB more at 2:1; loud tones pass', async () => {
  const quiet = 10 ** (-50 / 20), loud = 10 ** (-20 / 20);
  const [q] = await render('expander', { params: { threshold: -40, ratio: 2 }, seconds: 1, signal: sine(440, quiet) });
  const gq = db(amp(q, 440, S(0.5)) / quiet);
  assert.ok(Math.abs(gq + 10) < 1, `quiet tone gain ${gq} dB`);
  const [l] = await render('expander', { params: { threshold: -40, ratio: 2 }, seconds: 1, signal: sine(440, loud) });
  assert.ok(Math.abs(db(amp(l, 440, S(0.5)) / loud)) < 0.2);
});

test('transient: attack boosts onsets, sustain cuts tails, steady tones are left alone', async () => {
  // Plucks: 330 Hz with a 2 ms rise and 120 ms decay, every 500 ms.
  const pluck = (t) => { const u = t % 0.5; return 0.4 * Math.min(1, u / 0.002) * Math.exp(-u / 0.12) * Math.sin(TAU * 330 * t); };
  const dry = Float32Array.from({ length: S(2) }, (_, i) => pluck(i / SR));
  const onset = (x) => { let s = 0; for (let k = 1; k < 4; k++) s += peak(x, S(k * 0.5), S(k * 0.5 + 0.01)); return s; };
  const late = (x) => { let s = 0; for (let k = 1; k < 4; k++) s += rms(x, S(k * 0.5 + 0.15), S(k * 0.5 + 0.35)); return s; };
  const [a] = await render('transient', { params: { attack: 12, sustain: 0 }, seconds: 2, signal: pluck });
  const onsetGain = db(onset(a) / onset(dry));
  assert.ok(onsetGain > 4, `onset gain ${onsetGain} dB`);
  assert.ok(Math.abs(db(late(a) / late(dry))) < 1.5, `tail with attack only: ${db(late(a) / late(dry))} dB`);
  const [s] = await render('transient', { params: { attack: 0, sustain: -12 }, seconds: 2, signal: pluck });
  assert.ok(db(late(s) / late(dry)) < -4, `tail gain with sustain −12: ${db(late(s) / late(dry))} dB`);
  const [st] = await render('transient', { params: { attack: 12, sustain: 12 }, seconds: 1, signal: sine(220) });
  assert.ok(Math.abs(db(amp(st, 220, S(0.5)) / 0.5)) < 0.5, 'steady tone unchanged');
});

test('distortion: drive creates odd harmonics; drive 0 / mix 0 / output 0 is transparent', async () => {
  const [d] = await render('distortion', { params: { drive: 24, tone: 20000, output: 0 }, seconds: 0.5, signal: sine(500) });
  const h3 = db(amp(d, 1500, S(0.1)) / amp(d, 500, S(0.1)));
  assert.ok(h3 > -20, `3rd harmonic ${h3} dB`);
  assert.ok(peak(d, S(0.1)) <= 1.05, 'bounded by the curve');
  const [c] = await render('distortion', { params: { drive: 0, mix: 0, output: 0 }, seconds: 0.2, signal: music });
  const dry = Float32Array.from({ length: c.length }, (_, i) => music(i / SR, 0));
  assert.ok(maxDiff(c, dry, 0, c.length) < 1e-6);
});

test('bitcrusher: 4 bits gives levels on a 1/8 grid; low rates hold samples', async () => {
  const [L] = await render('bitcrusher', { params: { bits: 4, rate: 48000, mix: 1 }, seconds: 0.2, signal: music });
  const levels = new Set();
  for (const v of L) { assert.ok(Math.abs(v * 8 - Math.round(v * 8)) < 1e-6, `${v} not on the 1/8 grid`); levels.add(Math.round(v * 8)); }
  assert.ok(levels.size <= 17 && levels.size > 3, `${levels.size} levels`);
  const [H] = await render('bitcrusher', { params: { bits: 16, rate: 4000, mix: 1 }, seconds: 0.2, signal: sine(300) });
  let changes = 0; for (let i = 1; i < H.length; i++) if (H[i] !== H[i - 1]) changes++;
  assert.ok(Math.abs(changes - 0.2 * 4000) < 10, `${changes} steps in 0.2 s at 4 kHz`);
});

test('pingpong: echoes alternate left, right, left with feedback scaling', async () => {
  // A 4 ms, 1 kHz burst at 0.1 s (well below the damping corner, so echoes keep their level).
  const burst = (t) => (Math.abs(t - 0.1) < 0.002 ? Math.cos((Math.PI * (t - 0.1)) / 0.004) ** 2 * Math.sin(TAU * 1000 * t) : 0);
  const [L, R] = await render('pingpong', { params: { time: 100, feedback: 0.5, mix: 1, damping: 20000 }, seconds: 0.5, signal: burst });
  const win = (x, t) => peak(x, S(t - 0.01), S(t + 0.01));
  const first = win(L, 0.2);
  assert.ok(first > 0.9 && win(R, 0.2) < 1e-3, `first echo left (${first})`);
  assert.ok(Math.abs(win(R, 0.3) / first - 0.5) < 0.02 && win(L, 0.3) < 1e-3, 'second echo right at feedback');
  const ratio = win(L, 0.4) / first;
  assert.ok(Math.abs(ratio - 0.25) < 0.02 && win(R, 0.4) < 1e-3, `third echo (left) at feedback² ${ratio}`);
});

test('autofilter: depth 0 is a static band-pass; the LFO sweeps the level of an off-centre tone', async () => {
  const [s] = await render('autofilter', { params: { depth: 0, frequency: 800, Q: 2, mode: 1 }, seconds: 0.5, signal: sine(800) });
  assert.ok(Math.abs(db(amp(s, 800, S(0.1)) / 0.5)) < 0.3, 'centre passes at 0 dB');
  const [m] = await render('autofilter', { params: { depth: 4, frequency: 800, Q: 1, mode: 0, rate: 1 }, seconds: 1, signal: sine(2000) });
  const levels = []; for (let k = 0; k < 20; k++) levels.push(db(rms(m, S(k * 0.05), S(k * 0.05 + 0.05)) + 1e-9));
  assert.ok(Math.max(...levels) - Math.min(...levels) > 15, `sweep range ${Math.max(...levels) - Math.min(...levels)} dB`);
});

test('pitchshift: +12 moves a 220 Hz tone to 440 Hz, −12 to 110 Hz', async () => {
  const dominant = (x) => { let best = 0, bf = 0; for (let f = 60; f <= 1000; f += 2) { const a = amp(x, f, S(0.2)); if (a > best) { best = a; bf = f; } } return bf; };
  const [up] = await render('pitchshift', { params: { semitones: 12 }, seconds: 1, signal: sine(220) });
  const fu = dominant(up);
  assert.ok(Math.abs(fu - 440) <= 4, `dominant ${fu} Hz`);
  assert.ok(amp(up, 440, S(0.2)) > 10 * amp(up, 220, S(0.2)), '440 Hz dominates 220 Hz by 20 dB');
  const [down] = await render('pitchshift', { params: { semitones: -12 }, seconds: 1, signal: sine(220) });
  assert.ok(Math.abs(dominant(down) - 110) <= 4, `dominant ${dominant(down)} Hz`);
});

test('doubler: mono in → decorrelated stereo out; mix 0 is transparent', async () => {
  const [L, R] = await render('doubler', { params: { mix: 1 }, seconds: 1, signal: (t) => music(t, 0) });
  assert.ok(maxDiff(L, R, S(0.1), S(1)) > 0.05, 'left and right differ');
  const [c] = await render('doubler', { params: { mix: 0 }, seconds: 0.2, signal: music });
  const dry = Float32Array.from({ length: c.length }, (_, i) => music(i / SR, 0));
  assert.ok(maxDiff(c, dry, 0, c.length) < 1e-6);
});

test('invert: both or one channel flips polarity exactly', async () => {
  const dry = (ch) => Float32Array.from({ length: S(0.1) }, (_, i) => music(i / SR, ch));
  const [L, R] = await render('invert', { seconds: 0.1, signal: music });
  assert.ok(maxDiff(L, dry(0).map((v) => -v), 0, L.length) < 1e-7 && maxDiff(R, dry(1).map((v) => -v), 0, R.length) < 1e-7);
  const [L1, R1] = await render('invert', { params: { channel: 1 }, seconds: 0.1, signal: music });
  assert.ok(maxDiff(L1, dry(0).map((v) => -v), 0, L1.length) < 1e-7 && maxDiff(R1, dry(1), 0, R1.length) < 1e-7);
});

test('dcfilter: removes a 0.3 DC offset, leaves 440 Hz intact', async () => {
  const [L] = await render('dcfilter', { seconds: 1, signal: (t) => 0.3 + 0.2 * Math.sin(TAU * 440 * t) });
  let mean = 0; for (let i = S(0.5); i < S(1); i++) mean += L[i]; mean /= S(0.5);
  assert.ok(Math.abs(mean) < 1e-3, `residual DC ${mean}`);
  assert.ok(Math.abs(db(amp(L, 440, S(0.5)) / 0.2)) < 0.05);
});

test('vocalenhancer: amount 0 is transparent; amount 1 lifts presence over mud', async () => {
  const lvl = 10 ** (-36 / 20);
  const g = async (amount, f) => { const [L] = await render('vocalenhancer', { params: { amount }, seconds: 0.6, signal: sine(f, lvl) }); return db(amp(L, f, S(0.3)) / lvl); };
  assert.ok(Math.abs(await g(0, 1000)) < 0.1, 'amount 0');
  const tilt = (await g(1, 3500)) - (await g(1, 300));
  assert.ok(tilt > 6, `presence − mud: ${tilt} dB`);
  assert.ok((await g(1, 50)) < -6, 'low cut');
});

test('ringmod: 1 kHz × 200 Hz carrier gives 800 and 1200 Hz sidebands, no 1 kHz', async () => {
  const [L] = await render('ringmod', { params: { frequency: 200, mix: 1 }, seconds: 0.5, signal: sine(1000) });
  assert.ok(Math.abs(amp(L, 800, S(0.1)) - 0.25) < 0.01 && Math.abs(amp(L, 1200, S(0.1)) - 0.25) < 0.01);
  assert.ok(amp(L, 1000, S(0.1)) < 1e-3);
});

test('exciter: adds the octave above, keeps the fundamental; amount 0 is transparent', async () => {
  const [L] = await render('exciter', { params: { frequency: 3000, amount: 1 }, seconds: 0.5, signal: sine(4000, 0.3) });
  assert.ok(db(amp(L, 8000, S(0.1)) / 0.3) > -20, `2nd harmonic ${db(amp(L, 8000, S(0.1)) / 0.3)} dB`);
  assert.ok(Math.abs(db(amp(L, 4000, S(0.1)) / 0.3)) < 0.2);
  const [c] = await render('exciter', { params: { amount: 0 }, seconds: 0.2, signal: music });
  const dry = Float32Array.from({ length: c.length }, (_, i) => music(i / SR, 0));
  assert.ok(maxDiff(c, dry, 0, c.length) < 1e-6);
});

test('5.1 bus/master: every effect accepts six channels and keeps the centre channel', async () => {
  for (const type of TYPES) {
    const n = S(0.25);
    const ctx = new OfflineAudioContext(6, n, SR);
    await ctx.audioWorklet.addModule(WORKLET);
    const buf = ctx.createBuffer(6, n, SR);
    for (let ch = 0; ch < 6; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < n; i++) d[i] = music(i / SR, ch); }
    const src = ctx.createBufferSource(); src.buffer = buf;
    const fx = buildMoreEffect(ctx, { id: 'x', type, params: {} }, P(type), { from: 0, when: 0, channels: 6 }, AudioWorkletNode);
    src.connect(fx.input); fx.output.connect(ctx.destination); src.start(0);
    const out = await ctx.startRendering();
    assert.equal(out.numberOfChannels, 6);
    const C = new Float32Array(out.getChannelData(2));
    for (const v of C) assert.ok(Number.isFinite(v), `${type}: non-finite`);
    assert.ok(rms(C, S(0.1)) > 0.01, `${type}: centre channel lost (${rms(C, S(0.1))})`);
  }
});

test('graph.js: the new effects are registered and build through buildProjectGraph', async () => {
  const { EFFECTS, buildProjectGraph, setWorkletNode } = await import('../public/js/engine/graph.js');
  setWorkletNode(AudioWorkletNode);
  for (const t of TYPES) assert.equal(EFFECTS[t], MORE_EFFECTS[t]);
  const run = async (effects) => {
    const ctx = new OfflineAudioContext(2, S(0.5), SR);
    await ctx.audioWorklet.addModule(WORKLET);
    const b = ctx.createBuffer(1, S(0.5), SR); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin((TAU * 220 * i) / SR);
    const project = { sampleRate: SR, master: { gain: 0, effects: [] }, tracks: [{ id: 't', kind: 'audio', gain: 0, pan: 0, sends: [], automation: {}, effects, clips: [{ id: 'c', assetId: 'a', start: 0, duration: 0.5, offset: 0, gain: 0 }] }] };
    buildProjectGraph(ctx, project, new Map([['a', b]]), { from: 0, when: 0 });
    return new Float32Array((await ctx.startRendering()).getChannelData(0));
  };
  const fx = TYPES.map((type, i) => ({ id: `e${i}`, type, params: {}, enabled: true }));
  const on = await run(fx);
  for (const v of on) assert.ok(Number.isFinite(v));
  assert.ok(peak(on) > 0.01 && peak(on) < 4, `chain peak ${peak(on)}`);
  // All disabled = bypass: identical to a track without effects.
  const off = await run(fx.map((e) => ({ ...e, enabled: false })));
  const none = await run([]);
  assert.ok(maxDiff(off, none, 0, off.length) < 1e-6);
});
