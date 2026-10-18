// Shared audio graph — runs unchanged in the browser (AudioContext) and on the
// server (node-web-audio-api OfflineAudioContext), so preview == export.

export const EFFECTS = {
  gain: {
    label: 'Gain',
    description: 'Static level change.',
    params: {
      gain: { type: 'number', minimum: -60, maximum: 24, default: 0, unit: 'dB' },
    },
  },
  eq: {
    label: 'Parametric EQ',
    description: 'High-pass, low shelf, two peaking bands, high shelf, low-pass. Bands at 0 dB and filters at their extremes are bypassed.',
    params: {
      hpFreq: { type: 'number', minimum: 20, maximum: 2000, default: 20, unit: 'Hz', description: 'High-pass cutoff; 20 = off' },
      lowFreq: { type: 'number', minimum: 30, maximum: 1000, default: 120, unit: 'Hz' },
      lowGain: { type: 'number', minimum: -24, maximum: 24, default: 0, unit: 'dB' },
      mid1Freq: { type: 'number', minimum: 60, maximum: 8000, default: 400, unit: 'Hz' },
      mid1Gain: { type: 'number', minimum: -24, maximum: 24, default: 0, unit: 'dB' },
      mid1Q: { type: 'number', minimum: 0.1, maximum: 18, default: 1 },
      mid2Freq: { type: 'number', minimum: 200, maximum: 16000, default: 3000, unit: 'Hz' },
      mid2Gain: { type: 'number', minimum: -24, maximum: 24, default: 0, unit: 'dB' },
      mid2Q: { type: 'number', minimum: 0.1, maximum: 18, default: 1 },
      highFreq: { type: 'number', minimum: 1000, maximum: 18000, default: 8000, unit: 'Hz' },
      highGain: { type: 'number', minimum: -24, maximum: 24, default: 0, unit: 'dB' },
      lpFreq: { type: 'number', minimum: 1000, maximum: 20000, default: 20000, unit: 'Hz', description: 'Low-pass cutoff; 20000 = off' },
    },
  },
  compressor: {
    label: 'Compressor',
    description: 'Dynamic range compressor with makeup gain.',
    params: {
      threshold: { type: 'number', minimum: -60, maximum: 0, default: -20, unit: 'dB' },
      ratio: { type: 'number', minimum: 1, maximum: 20, default: 3 },
      knee: { type: 'number', minimum: 0, maximum: 40, default: 6, unit: 'dB' },
      attack: { type: 'number', minimum: 0, maximum: 1000, default: 10, unit: 'ms' },
      release: { type: 'number', minimum: 10, maximum: 1000, default: 200, unit: 'ms' },
      makeup: { type: 'number', minimum: 0, maximum: 24, default: 0, unit: 'dB' },
    },
  },
  delay: {
    label: 'Echo',
    description: 'Feedback delay. Dry signal stays at unity; mix sets the echo level.',
    params: {
      time: { type: 'number', minimum: 1, maximum: 2000, default: 300, unit: 'ms' },
      feedback: { type: 'number', minimum: 0, maximum: 0.9, default: 0.35 },
      mix: { type: 'number', minimum: 0, maximum: 1, default: 0.25 },
    },
  },
  reverb: {
    label: 'Reverb',
    description: 'Convolution reverb with a generated room tail. Dry stays at unity; mix sets the reverb level.',
    params: {
      decay: { type: 'number', minimum: 0.2, maximum: 8, default: 1.6, unit: 's', description: 'Time to fall 60 dB' },
      preDelay: { type: 'number', minimum: 0, maximum: 200, default: 12, unit: 'ms' },
      mix: { type: 'number', minimum: 0, maximum: 1, default: 0.2 },
    },
  },
  limiter: {
    label: 'Limiter',
    description: 'Brickwall peak limiter with 2.5 ms lookahead. Put it last on the master to guarantee a ceiling.',
    worklet: 'klang-limiter',
    params: {
      drive: { type: 'number', minimum: 0, maximum: 24, default: 0, unit: 'dB', description: 'Input gain into the limiter (louder = more limiting)' },
      ceiling: { type: 'number', minimum: -24, maximum: 0, default: -1, unit: 'dB' },
      release: { type: 'number', minimum: 1, maximum: 2000, default: 80, unit: 'ms' },
    },
  },
  gate: {
    label: 'Noise gate',
    description: 'Turns the signal down by `range` when it falls below `threshold` (breaths, room noise between phrases).',
    worklet: 'klang-gate',
    params: {
      threshold: { type: 'number', minimum: -90, maximum: 0, default: -45, unit: 'dB' },
      range: { type: 'number', minimum: -90, maximum: 0, default: -40, unit: 'dB' },
      attack: { type: 'number', minimum: 0.1, maximum: 100, default: 2, unit: 'ms' },
      hold: { type: 'number', minimum: 0, maximum: 1000, default: 60, unit: 'ms' },
      release: { type: 'number', minimum: 5, maximum: 3000, default: 150, unit: 'ms' },
    },
  },
  deesser: {
    label: 'De-esser',
    description: 'Turns down only the high band when sibilance (s, sh, t) gets loud.',
    worklet: 'klang-deesser',
    params: {
      frequency: { type: 'number', minimum: 2000, maximum: 12000, default: 6000, unit: 'Hz' },
      threshold: { type: 'number', minimum: -60, maximum: 0, default: -30, unit: 'dB' },
      reduction: { type: 'number', minimum: 0, maximum: 24, default: 10, unit: 'dB', description: 'Maximum reduction' },
    },
  },
  saturation: {
    label: 'Saturation',
    description: 'Soft-clipping warmth and density.',
    worklet: 'klang-saturation',
    params: {
      drive: { type: 'number', minimum: 0, maximum: 30, default: 6, unit: 'dB' },
      mix: { type: 'number', minimum: 0, maximum: 1, default: 1 },
      output: { type: 'number', minimum: -24, maximum: 6, default: 0, unit: 'dB' },
    },
  },
};

// Worklet DSP must be loaded into a context before building a graph that uses it.
const workletsLoaded = new WeakMap();
export function loadWorklets(ctx, url) {
  if (!workletsLoaded.has(ctx)) workletsLoaded.set(ctx, ctx.audioWorklet.addModule(url));
  return workletsLoaded.get(ctx);
}
let WorkletNodeCtor = globalThis.AudioWorkletNode;
export function setWorkletNode(ctor) { WorkletNodeCtor = ctor; }

import { MOD_EFFECTS, buildModEffect } from './modfx.js';
Object.assign(EFFECTS, MOD_EFFECTS);
import { MORE_EFFECTS, buildMoreEffect } from './morefx.js';
Object.assign(EFFECTS, MORE_EFFECTS);
import { STUDIO_EFFECTS, buildStudioEffect } from './studiofx.js';
Object.assign(EFFECTS, STUDIO_EFFECTS);

// Lowpass/highpass biquads take Q in dB; −3.01 dB is a flat Butterworth response.
const BUTTERWORTH_Q_DB = -3.0103;

export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => (g > 0 ? 20 * Math.log10(g) : -Infinity);

export function effectDefaults(type) {
  const def = EFFECTS[type];
  const out = {};
  for (const [k, p] of Object.entries(def.params)) out[k] = p.default;
  return out;
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const irCache = new WeakMap();
// Deterministic impulse response: identical in browser and server.
export function makeImpulse(ctx, decay, preDelayMs) {
  let perCtx = irCache.get(ctx);
  if (!perCtx) irCache.set(ctx, (perCtx = new Map()));
  const key = `${decay.toFixed(3)}:${preDelayMs.toFixed(1)}`;
  if (perCtx.has(key)) return perCtx.get(key);
  const sr = ctx.sampleRate;
  const pre = Math.floor((preDelayMs / 1000) * sr);
  const len = pre + Math.floor(decay * sr);
  const buf = ctx.createBuffer(2, Math.max(len, 1), sr);
  for (let ch = 0; ch < 2; ch++) {
    const rnd = mulberry32(9001 + ch * 7919);
    const data = buf.getChannelData(ch);
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sr;
      // -60 dB at `decay`, with a gentle high-frequency roll-off via smoothing.
      data[i] = (rnd() * 2 - 1) * Math.exp((-6.907755 * t) / decay);
    }
    let prev = 0;
    for (let i = pre; i < len; i++) { prev = prev * 0.35 + data[i] * 0.65; data[i] = prev; }
  }
  perCtx.set(key, buf);
  return buf;
}

// Returns { input, output, nodes, update(params) } for one effect instance.
// update() changes parameters on a running graph without rebuilding it.
// Every node exists regardless of settings so preview and render share topology.
export function buildEffect(ctx, fx, timing) {
  if (MOD_EFFECTS[fx.type] && fx.enabled !== false) return buildModEffect(ctx, fx, (params) => ({ ...effectDefaults(fx.type), ...(params || {}) }), timing);
  if (STUDIO_EFFECTS[fx.type] && fx.enabled !== false) return buildStudioEffect(ctx, fx, (params) => ({ ...effectDefaults(fx.type), ...(params || {}) }), timing);
  if (MORE_EFFECTS[fx.type] && fx.enabled !== false) return buildMoreEffect(ctx, fx, (params) => ({ ...effectDefaults(fx.type), ...(params || {}) }), timing, WorkletNodeCtor);
  const nodes = [];
  const mk = (n) => (nodes.push(n), n);
  const input = mk(ctx.createGain());
  const output = mk(ctx.createGain());
  let update = () => {};
  // targets: automatable params → { param: AudioParam, map: value → AudioParam value }.
  const targets = {};
  if (fx.enabled === false) { input.connect(output); return { input, output, nodes, update, targets }; }
  const P = (params) => ({ ...effectDefaults(fx.type), ...(params || {}) });

  const def = EFFECTS[fx.type];
  if (def?.worklet) {
    const node = mk(new WorkletNodeCtor(ctx, def.worklet, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [timing?.channels || 2] }));
    input.connect(node).connect(output);
    update = (params) => {
      const p = P(params);
      for (const k of Object.keys(def.params)) node.parameters.get(k).value = p[k];
    };
    for (const k of Object.keys(def.params)) targets[k] = { param: node.parameters.get(k), map: (v) => v };
    update(fx.params);
    return { input, output, nodes, update, targets };
  }

  switch (fx.type) {
    case 'gain': {
      input.connect(output);
      update = (params) => { input.gain.value = dbToGain(P(params).gain); };
      targets.gain = { param: input.gain, map: dbToGain };
      break;
    }
    case 'eq': {
      const hp = mk(ctx.createBiquadFilter()), lo = mk(ctx.createBiquadFilter()), m1 = mk(ctx.createBiquadFilter());
      const m2 = mk(ctx.createBiquadFilter()), hi = mk(ctx.createBiquadFilter()), lp = mk(ctx.createBiquadFilter());
      input.connect(hp).connect(lo).connect(m1).connect(m2).connect(hi).connect(lp).connect(output);
      // A peaking filter at 0 dB is an exact identity, so "off" filters become that.
      const pass = (b) => { b.type = 'peaking'; b.gain.value = 0; b.frequency.value = 1000; b.Q.value = 1; };
      update = (params) => {
        const p = P(params);
        if (p.hpFreq > 20) { hp.type = 'highpass'; hp.frequency.value = p.hpFreq; hp.Q.value = BUTTERWORTH_Q_DB; } else pass(hp);
        lo.type = 'lowshelf'; lo.frequency.value = p.lowFreq; lo.gain.value = p.lowGain;
        m1.type = 'peaking'; m1.frequency.value = p.mid1Freq; m1.gain.value = p.mid1Gain; m1.Q.value = p.mid1Q;
        m2.type = 'peaking'; m2.frequency.value = p.mid2Freq; m2.gain.value = p.mid2Gain; m2.Q.value = p.mid2Q;
        hi.type = 'highshelf'; hi.frequency.value = p.highFreq; hi.gain.value = p.highGain;
        if (p.lpFreq < 20000) { lp.type = 'lowpass'; lp.frequency.value = p.lpFreq; lp.Q.value = BUTTERWORTH_Q_DB; } else pass(lp);
      };
      const id = (v) => v;
      Object.assign(targets, {
        lowGain: { param: lo.gain, map: id }, lowFreq: { param: lo.frequency, map: id },
        mid1Gain: { param: m1.gain, map: id }, mid1Freq: { param: m1.frequency, map: id }, mid1Q: { param: m1.Q, map: id },
        mid2Gain: { param: m2.gain, map: id }, mid2Freq: { param: m2.frequency, map: id }, mid2Q: { param: m2.Q, map: id },
        highGain: { param: hi.gain, map: id }, highFreq: { param: hi.frequency, map: id },
        // Automated cut filters stay active (20 Hz / 20 kHz are then near-transparent).
        hpFreq: { param: hp.frequency, map: id, before: () => { hp.type = 'highpass'; hp.Q.value = BUTTERWORTH_Q_DB; hp.gain.value = 0; } },
        lpFreq: { param: lp.frequency, map: id, before: () => { lp.type = 'lowpass'; lp.Q.value = BUTTERWORTH_Q_DB; lp.gain.value = 0; } },
      });
      break;
    }
    case 'compressor': {
      const c = mk(ctx.createDynamicsCompressor());
      const makeup = mk(ctx.createGain());
      input.connect(c).connect(makeup).connect(output);
      update = (params) => {
        const p = P(params);
        c.threshold.value = p.threshold; c.ratio.value = p.ratio; c.knee.value = p.knee;
        c.attack.value = p.attack / 1000; c.release.value = p.release / 1000;
        makeup.gain.value = dbToGain(p.makeup);
      };
      Object.assign(targets, {
        threshold: { param: c.threshold, map: (v) => v }, ratio: { param: c.ratio, map: (v) => v }, knee: { param: c.knee, map: (v) => v },
        attack: { param: c.attack, map: (v) => v / 1000 }, release: { param: c.release, map: (v) => v / 1000 },
        makeup: { param: makeup.gain, map: dbToGain },
      });
      break;
    }
    case 'delay': {
      const d = mk(ctx.createDelay(2.5));
      const fb = mk(ctx.createGain());
      const wet = mk(ctx.createGain());
      input.connect(output);
      input.connect(d); d.connect(fb); fb.connect(d); d.connect(wet); wet.connect(output);
      update = (params) => {
        const p = P(params);
        d.delayTime.value = p.time / 1000; fb.gain.value = p.feedback; wet.gain.value = p.mix;
      };
      Object.assign(targets, { time: { param: d.delayTime, map: (v) => v / 1000 }, feedback: { param: fb.gain, map: (v) => v }, mix: { param: wet.gain, map: (v) => v } });
      break;
    }
    case 'reverb': {
      const conv = mk(ctx.createConvolver());
      conv.normalize = true;
      const wet = mk(ctx.createGain());
      input.connect(output);
      input.connect(conv); conv.connect(wet); wet.connect(output);
      let irKey = '';
      update = (params) => {
        const p = P(params);
        const key = `${p.decay}:${p.preDelay}`;
        if (key !== irKey) { irKey = key; conv.buffer = makeImpulse(ctx, p.decay, p.preDelay); }
        wet.gain.value = p.mix;
      };
      targets.mix = { param: wet.gain, map: (v) => v };
      break;
    }
    default:
      input.connect(output);
  }
  update(fx.params);
  return { input, output, nodes, update, targets };
}

function buildChain(ctx, effects, nodes, fxHandles, timing) {
  const head = ctx.createGain(); nodes.push(head);
  let cur = head;
  for (const fx of effects || []) {
    const e = buildEffect(ctx, fx, timing);
    if (e.sources) nodes.push(...e.sources);
    nodes.push(...e.nodes);
    fxHandles?.set(fx.id, e);
    cur.connect(e.input);
    cur = e.output;
  }
  return { input: head, output: cur };
}

// Fade curves, x = 0 (silent) … 1 (full). equalPower keeps the summed power of a
// crossfade constant; sCurve eases both ends; exponential starts slow (natural-sounding fade-in).
export const FADE_SHAPES = {
  linear: (x) => x,
  equalPower: (x) => Math.sin((x * Math.PI) / 2),
  sCurve: (x) => (1 - Math.cos(Math.PI * x)) / 2,
  exponential: (x) => x * x,
};
const shapeFn = (name) => FADE_SHAPES[name] || FADE_SHAPES.linear;

// Fade multiplier (0…1) of a clip at timeline time t.
export function fadeAt(clip, t) {
  const s = clip.start, e = clip.start + clip.duration;
  if (t < s || t > e) return 0;
  let f = 1;
  if (clip.fadeIn > 0 && t < s + clip.fadeIn) f = Math.min(f, shapeFn(clip.fadeInShape)(Math.max(0, (t - s) / clip.fadeIn)));
  if (clip.fadeOut > 0 && t > e - clip.fadeOut) f = Math.min(f, shapeFn(clip.fadeOutShape)(Math.max(0, (e - t) / clip.fadeOut)));
  return Math.max(0, f);
}

// Gain of a clip (linear, before track processing) at timeline time t.
// Clip volume envelope: points {time, value} with time in SOURCE seconds (so they stay
// glued to the audio when the clip is moved, trimmed or split) and value in dB.
export function clipEnvelopeDb(clip, t) {
  const env = clip.envelope;
  if (!env?.length) return 0;
  return automationAt(env, clip.offset + (t - clip.start) * (clip.rate || 1), 0);
}
export function clipGainAt(clip, t) {
  return dbToGain((clip.gain || 0) + clipEnvelopeDb(clip, t)) * fadeAt(clip, t);
}

// Breakpoints for the clip envelope; curved fades are approximated by 24 linear segments.
function envelopePoints(clip) {
  const cs = clip.start, ce = clip.start + clip.duration;
  const pts = [cs, cs + (clip.fadeIn || 0), ce - (clip.fadeOut || 0), ce];
  const sub = (a, b, shape) => { if (shape && shape !== 'linear' && b > a) for (let k = 1; k < 24; k++) pts.push(a + ((b - a) * k) / 24); };
  sub(cs, cs + (clip.fadeIn || 0), clip.fadeInShape);
  sub(ce - (clip.fadeOut || 0), ce, clip.fadeOutShape);
  // Envelope points (and dB-space subdivisions of big jumps) inside the clip.
  const env = clip.envelope || [];
  for (let i = 0; i < env.length; i++) {
    const tl = cs + (env[i].time - clip.offset);
    if (tl > cs && tl < ce) pts.push(tl);
    const nx = env[i + 1];
    if (nx && Math.abs(nx.value - env[i].value) > 3) {
      const steps = Math.min(16, Math.ceil(Math.abs(nx.value - env[i].value) / 3));
      for (let k = 1; k < steps; k++) { const tt = cs + (env[i].time + ((nx.time - env[i].time) * k) / steps - clip.offset); if (tt > cs && tt < ce) pts.push(tt); }
    }
  }
  return pts.sort((a, b) => a - b);
}

// Stacking (Audition's clip order): where clips on one track overlap, the upper one plays
// and covers the lower — unless the overlap is a crossfade (both sides faded across it).
// Upper = higher z (the ops raise a clip when it is placed or moved onto others); equal z
// falls back to the later start.
const above = (a, b) => (b.z || 0) > (a.z || 0) || ((b.z || 0) === (a.z || 0) && b.start > a.start);
export function occludedSpans(track, clip) {
  const spans = [];
  const ce = clip.start + clip.duration;
  for (const o of track.clips) {
    if (o === clip || o.id === clip.id || !above(clip, o)) continue;
    const s = Math.max(clip.start, o.start), e = Math.min(ce, o.start + o.duration);
    if (e - s <= 1e-6) continue;
    const isCrossfade = (o.start >= clip.start && (clip.fadeOut || 0) >= ce - o.start - 1e-6 && (o.fadeIn || 0) >= ce - o.start - 1e-6)
      || (o.start < clip.start && (o.fadeOut || 0) >= o.start + o.duration - clip.start - 1e-6 && (clip.fadeIn || 0) >= o.start + o.duration - clip.start - 1e-6);
    if (!isCrossfade) spans.push([s, e]);
  }
  return spans;
}
const EDGE = 0.005;
function occlusionMask(spans, t) {
  let m = 1;
  for (const [s, e] of spans) {
    if (t >= s && t <= e) return 0;
    if (t > s - EDGE && t < s) m = Math.min(m, (s - t) / EDGE);
    if (t > e && t < e + EDGE) m = Math.min(m, (t - e) / EDGE);
  }
  return m;
}

export function projectEnd(project) {
  let end = 0;
  for (const tr of project.tracks) for (const c of tr.clips) end = Math.max(end, c.start + c.duration);
  return end;
}

// Automation: points [{time, value}] (volume in dB relative to the fader, pan -1…1),
// linear between points, held flat before the first and after the last.
export function automationAt(points, t, fallback) {
  if (!points?.length) return fallback;
  if (t <= points[0].time) return points[0].value;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (t <= b.time) return b.time === a.time ? b.value : a.value + ((t - a.time) / (b.time - a.time)) * (b.value - a.value);
  }
  return points[points.length - 1].value;
}
function scheduleAutomation(param, points, map, neutral, from, T, dbCurve = map(1) !== 1 && map === dbToGain) {
  if (!points?.length) { if (neutral !== null) param.value = neutral; return; }
  param.setValueAtTime(map(automationAt(points, from, 0)), T(from));
  // Volume ramps are done in dB space by subdividing long segments.
  for (let i = 0; i < points.length; i++) {
    const b = points[i];
    if (b.time <= from) continue;
    const a = i > 0 ? points[i - 1] : null;
    if (a && Math.abs(b.value - a.value) > 3 && dbCurve) {
      const start = Math.max(a.time, from);
      const steps = Math.min(32, Math.ceil(Math.abs(b.value - a.value) / 2));
      for (let k = 1; k < steps; k++) {
        const t = start + ((b.time - start) * k) / steps;
        param.linearRampToValueAtTime(map(automationAt(points, t, 0)), T(t));
      }
    }
    param.linearRampToValueAtTime(map(b.value), T(b.time));
  }
}

// Which parameters of an effect type can follow automation.
const CORE_AUTOMATABLE = {
  gain: ['gain'],
  eq: ['hpFreq', 'lowFreq', 'lowGain', 'mid1Freq', 'mid1Gain', 'mid1Q', 'mid2Freq', 'mid2Gain', 'mid2Q', 'highFreq', 'highGain', 'lpFreq'],
  compressor: ['threshold', 'ratio', 'knee', 'attack', 'release', 'makeup'],
  delay: ['time', 'feedback', 'mix'],
  reverb: ['mix'],
};
export function automatableParams(type) {
  const def = EFFECTS[type];
  if (!def) return [];
  if (def.worklet) return Object.keys(def.params);
  return CORE_AUTOMATABLE[type] || def.automatable || [];
}

// Effect parameter automation lives next to volume/pan under keys "fx:<effectId>:<param>".
export const fxAutoKey = (effectId, param) => `fx:${effectId}:${param}`;
function scheduleFxAutomation(automation, fxHandles, from, T) {
  for (const [key, points] of Object.entries(automation || {})) {
    if (!key.startsWith('fx:') || !points?.length) continue;
    const [, effectId, name] = key.split(':');
    const target = fxHandles.get(effectId)?.targets?.[name];
    if (!target) continue;
    target.before?.();
    scheduleAutomation(target.param, points, target.map, null, from, T, target.map === dbToGain);
  }
}

// Everything that requires rebuilding the graph when it changes (as opposed to
// parameters that update() can set live).
const automatedFx = (project) => new Set([project.master?.automation, ...project.tracks.map((t) => t.automation)]
  .flatMap((a) => Object.keys(a || {}).filter((k) => k.startsWith('fx:') && a[k]?.length).map((k) => k.split(':')[1])));

// ── 5.1 surround ─────────────────────────────────────────────────────────
// Channel order L R C LFE Ls Rs (SMPTE/WAV). Position: x −1 left … 1 right, y −1 back … 1
// front. Pairwise constant-power panning around the speaker ring; towards the centre of
// the room the sound spreads over all five speakers.
const RING = [{ ch: 4, a: -110 }, { ch: 0, a: -30 }, { ch: 2, a: 0 }, { ch: 1, a: 30 }, { ch: 5, a: 110 }];
export function surroundGains(x = 0, y = 1) {
  const g = new Float64Array(6);
  const r = Math.min(1, Math.hypot(x, y));
  const theta = r < 1e-6 ? 0 : (Math.atan2(x, y) * 180) / Math.PI;
  const ring = [...RING, { ch: 4, a: 250 }];
  let th = theta < -110 ? theta + 360 : theta;
  for (let i = 0; i < ring.length - 1; i++) {
    const A = ring[i], B = ring[i + 1];
    if (th >= A.a && th <= B.a) { const f = (th - A.a) / (B.a - A.a); g[A.ch] += Math.cos((f * Math.PI) / 2); g[B.ch] += Math.sin((f * Math.PI) / 2); break; }
  }
  const spread = 1 / Math.sqrt(5);
  for (const sp of RING) g[sp.ch] = r * g[sp.ch] + (1 - r) * spread;
  const norm = Math.sqrt(RING.reduce((n, sp) => n + g[sp.ch] ** 2, 0)) || 1;
  for (const sp of RING) g[sp.ch] /= norm;
  return g;
}
function buildSurroundPanner(ctx, nodes) {
  const mono = ctx.createGain();
  mono.channelCount = 1; mono.channelCountMode = 'explicit'; mono.channelInterpretation = 'speakers';
  const merger = ctx.createChannelMerger(6);
  const speakers = RING.map(({ ch }) => { const gn = ctx.createGain(); mono.connect(gn); gn.connect(merger, 0, ch); return [ch, gn]; });
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 120;
  const lfe = ctx.createGain(); mono.connect(lp); lp.connect(lfe); lfe.connect(merger, 0, 3);
  nodes.push(mono, merger, lp, lfe, ...speakers.map((x) => x[1]));
  return {
    input: mono, output: merger,
    update(t) {
      const g = surroundGains(t.pan || 0, t.surroundY ?? 1);
      for (const [ch, gn] of speakers) gn.gain.value = g[ch];
      lfe.gain.value = (t.lfe ?? -60) <= -60 ? 0 : dbToGain(t.lfe);
    },
  };
}

export function structureKey(project) {
  // Effects with automated parameters are rebuilt on any change instead of live-updated,
  // so a slider move never overrides the scheduled automation.
  const auto = automatedFx(project);
  const fxKey = (e) => [e.id, e.type, e.enabled, auto.has(e.id) ? e.params : 0];
  return JSON.stringify([
    project.tracks.map((t) => [t.id, t.kind, t.output, (t.sends || []).map((x) => [x.id, x.busId, x.pre]), t.clips, t.automation, t.effects.map(fxKey)]),
    project.master.effects.map(fxKey), project.master.automation, project.channels || 2,
  ]);
}

// Buses are solo-safe: soloing a voice keeps the reverb bus it feeds audible.
const trackLevel = (project, t) => {
  if (t.kind === 'bus') return t.mute ? 0 : dbToGain(t.gain || 0);
  const anySolo = project.tracks.some((x) => x.solo && x.kind !== 'bus');
  return t.mute || (anySolo && !t.solo) ? 0 : dbToGain(t.gain || 0);
};

/**
 * Wire the whole project into ctx and schedule playback of [from, to).
 * buffers: Map assetId -> AudioBuffer. when: ctx time at which `from` sounds.
 * onTrack(trackId, node): optional tap after each track's fader (for meters).
 * Returns { output, update(project), stop() }.
 */
export function buildProjectGraph(ctx, project, buffers, { from = 0, to = Infinity, when = 0, destination, onTrack, streamSource, irBuffers, speed = 1, exact = false } = {}) {
  const nodes = [];
  const sources = [];
  const fx = new Map();
  const trackNodes = new Map();

  const channels = project.channels === 6 ? 6 : 2;
  const timing = { from, when, channels, irBuffers: irBuffers || buffers };
  // speed: transport playback speed (review at 1.25× etc.); 1 for every export.
  const T = (x) => when + (x - from) / speed;
  const masterChain = buildChain(ctx, project.master?.effects, nodes, fx, timing);
  scheduleFxAutomation(project.master?.automation, fx, from, T);
  const masterGain = ctx.createGain(); nodes.push(masterGain);
  masterChain.output.connect(masterGain);
  masterGain.connect(destination || ctx.destination);

  const sendNodes = new Map();

  // Buses first, so tracks can route into them. Buses always feed the master.
  const ordered = [...project.tracks.filter((t) => t.kind === 'bus'), ...project.tracks.filter((t) => t.kind !== 'bus')];
  const busInputs = new Map();
  for (const track of ordered) {
    const busSurround = channels === 6 && track.kind === 'bus';
    const chain = buildChain(ctx, track.effects, nodes, fx, busSurround ? timing : { ...timing, channels: 2 });
    const auto = ctx.createGain(); nodes.push(auto);
    const autoPan = ctx.createStereoPanner(); nodes.push(autoPan);
    const pan = ctx.createStereoPanner(); nodes.push(pan);
    const tg = ctx.createGain(); nodes.push(tg);
    let surround = null;
    if (busSurround) chain.output.connect(auto), auto.connect(tg); // 5.1 buses carry all six channels straight through
    else if (channels === 6) {
      surround = buildSurroundPanner(ctx, nodes);
      chain.output.connect(auto); auto.connect(surround.input); surround.output.connect(tg);
    } else { chain.output.connect(auto); auto.connect(autoPan); autoPan.connect(pan); pan.connect(tg); }
    const dest = track.kind !== 'bus' && track.output && busInputs.get(track.output);
    tg.connect(dest || masterChain.input);
    if (track.kind === 'bus') busInputs.set(track.id, chain.input);
    for (const send of track.kind === 'bus' ? [] : track.sends || []) {
      const busIn = busInputs.get(send.busId);
      if (!busIn) continue;
      const sg = ctx.createGain(); nodes.push(sg);
      (send.pre ? autoPan : tg).connect(sg); sg.connect(busIn);
      sendNodes.set(send.id, sg);
    }
    scheduleAutomation(auto.gain, track.automation?.volume, dbToGain, 1, from, T);
    scheduleFxAutomation(track.automation, fx, from, T);
    scheduleAutomation(autoPan.pan, track.automation?.pan, (v) => v, 0, from, T);
    trackNodes.set(track.id, { pan, gain: tg, surround });
    onTrack?.(track.id, tg);
    if (track.kind === 'bus') continue;

    for (const clip of track.clips) {
      const buf = buffers.get(clip.assetId);
      if (!buf && !streamSource) continue;
      const cs = clip.start, ce = clip.start + clip.duration;
      if (ce <= from || cs >= to) continue;
      const startAt = Math.max(cs, from);
      const skip = startAt - cs;
      const playDur = Math.min(ce, to) - startAt;
      if (playDur <= 0) continue;

      // Long assets in the browser stream from a media element instead of a decoded buffer.
      // Varispeed: a clip with rate r reads its source r× faster (pitch and tempo together).
      const rate = clip.rate || 1;
      const src = buf ? ctx.createBufferSource() : streamSource(clip, { at: T(startAt), offset: (clip.offset || 0) + skip * rate, duration: playDur / speed, rate: rate * speed });
      if (!src) continue;
      // Looping clips repeat offset … offset+loopLength.
      const looping = buf && clip.loop && clip.loopLength > 0;
      const exactCopy = exact && buf && !looping && rate === 1 && speed === 1 && buf.sampleRate === ctx.sampleRate;
      if (buf && !exactCopy) src.buffer = buf;
      if (looping) { src.loop = true; src.loopStart = clip.offset || 0; src.loopEnd = (clip.offset || 0) + clip.loopLength; }
      const g = ctx.createGain(); nodes.push(g);
      // Dual-mono: a mono clip feeds both channels at full level, so a centred mono clip is
      // 0 dB in L and R (Audition's default L/R-cut pan law), not −3 dB.
      g.channelCount = 2; g.channelCountMode = 'explicit'; g.channelInterpretation = 'speakers';
      // Gain envelope: breakpoints at fade edges, all expressed as linear ramps.
      const occ = occludedSpans(track, clip);
      const gainAt = (x) => clipGainAt(clip, x) * (occ.length ? occlusionMask(occ, x) : 1);
      const pts = [...envelopePoints(clip), ...occ.flatMap(([s, e]) => [s - EDGE, s, e, e + EDGE])].filter((x) => x >= startAt && x <= ce).sort((a, b) => a - b);
      g.gain.setValueAtTime(gainAt(startAt), T(startAt));
      for (const x of pts) g.gain.linearRampToValueAtTime(gainAt(x), T(x));
      src.connect(g); g.connect(chain.input);
      if (buf) src.playbackRate.value = rate * speed;
      if (exactCopy) {
        // Offline export: hand the source a private, sample-aligned copy that starts on a
        // render-quantum boundary with offset 0, the one case every engine copies verbatim
        // (no interpolation for fractional start times or offsets).
        const sr = ctx.sampleRate, at = Math.round(T(startAt) * sr), a0 = at - (at % 128), pad = at - a0;
        const s0 = Math.round(((clip.offset || 0) + skip) * sr), n = Math.max(0, Math.min(Math.round(playDur * sr), buf.length - s0));
        const own = ctx.createBuffer(buf.numberOfChannels, Math.max(1, pad + n), sr);
        for (let c = 0; c < buf.numberOfChannels; c++) own.copyToChannel(buf.getChannelData(c).subarray(s0, s0 + n), c, pad);
        src.buffer = own;
        src.start(a0 / sr);
      } else if (looping) src.start(T(startAt), (clip.offset || 0) + ((skip * rate) % clip.loopLength));
      else if (buf) src.start(T(startAt), (clip.offset || 0) + skip * rate, playDur * rate);
      if (looping) src.stop(T(startAt) + playDur / speed);
      sources.push(src);
    }
  }

  function update(p) {
    const auto = automatedFx(p);
    masterGain.gain.value = dbToGain(p.master?.gain || 0);
    for (const t of p.tracks) {
      const n = trackNodes.get(t.id);
      if (n) { n.pan.pan.value = t.pan || 0; n.gain.gain.value = trackLevel(p, t); n.surround?.update(t); }
      for (const x of t.sends || []) { const sg = sendNodes.get(x.id); if (sg) sg.gain.value = trackLevel(p, t) === 0 ? 0 : dbToGain(x.level ?? -6); } // muted or soloed-out: pre-fader sends go quiet too
      for (const e of t.effects) if (!auto.has(e.id)) fx.get(e.id)?.update(e.params);
    }
    for (const e of p.master?.effects || []) if (!auto.has(e.id)) fx.get(e.id)?.update(e.params);
  }
  update(project);

  return {
    output: masterGain,
    sources,
    update,
    stop() {
      for (const s of sources) { try { s.stop(); } catch {} try { s.disconnect(); } catch {} }
      for (const n of nodes) { try { n.stop?.(); } catch {} try { n.disconnect(); } catch {} }
    },
  };
}
