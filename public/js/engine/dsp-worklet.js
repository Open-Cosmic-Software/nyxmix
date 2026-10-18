// Custom DSP as AudioWorklet processors. Loaded by the browser AND by the server's
// offline renderer (node-web-audio-api), so these sound identical in preview and export.
/* global sampleRate, registerProcessor, AudioWorkletProcessor */

const dbToGain = (db) => Math.pow(10, db / 20);
const coef = (ms) => (ms <= 0 ? 0 : Math.exp(-1 / ((ms / 1000) * sampleRate)));
const kparams = (defs) => Object.entries(defs).map(([name, [def, min, max]]) => ({ name, defaultValue: def, minValue: min, maxValue: max, automationRate: 'k-rate' }));

// True-peak interpolator: 8× oversampling (7 phases between two samples) with 32-tap
// Kaiser-windowed sinc, accurate to <0.02 dB up to 0.45·fs (BS.1770 asks for ≥4×).
const TP_TAPS = 32, TP_MID = TP_TAPS / 2 - 1;
const besselI0 = (x) => { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; };
const TP_COEFS = [1, 2, 3, 4, 5, 6, 7].map((k) => {
  const t = k / 8, c = [], beta = 8;
  for (let j = 0; j < TP_TAPS; j++) {
    const x = TP_MID + t - j;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const r = x / (TP_TAPS / 2);
    c.push(sinc * (Math.abs(r) < 1 ? besselI0(beta * Math.sqrt(1 - r * r)) / besselI0(beta) : 0));
  }
  const sum = c.reduce((a, b) => a + b, 0);
  return c.map((v) => v / sum);
});

// Brickwall limiter with lookahead: the gain starts dropping before a peak arrives.
// Detection is true-peak aware (inter-sample peaks), so exports pass dBTP limits.
const LIMITER = { ceiling: [-1, -24, 0], release: [80, 1, 2000], drive: [0, 0, 24] };
class Limiter extends AudioWorkletProcessor {
  static get parameterDescriptors() { return kparams(LIMITER); }
  constructor() {
    super();
    this.L = Math.max(1, Math.round(sampleRate * 0.0025));
    this.buf = [new Float32Array(this.L + 1), new Float32Array(this.L + 1)];
    this.w = 0; this.g = 1; this.n = 0;
    // Sliding minimum of the required gain over the lookahead window (monotonic deque).
    this.dqN = new Float64Array(this.L + 2); this.dqV = new Float32Array(this.L + 2);
    this.dqHead = 0; this.dqLen = 0;
    this.hist = [new Float32Array(TP_TAPS), new Float32Array(TP_TAPS)]; // recent input per channel
  }
  // Peak between samples (what true-peak meters see), around the middle of the window.
  static interPeak(h) {
    let pk = Math.max(Math.abs(h[TP_MID]), Math.abs(h[TP_MID + 1]));
    for (const c of TP_COEFS) {
      let v = 0;
      for (let j = 0; j < TP_TAPS; j++) v += c[j] * h[j];
      const a = Math.abs(v); if (a > pk) pk = a;
    }
    return pk;
  }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    const n = out[0].length, nch = out.length;
    const ceil = dbToGain(p.ceiling[0]), drive = dbToGain(p.drive[0]);
    const rel = coef(p.release[0]);
    const atk = 1 - Math.exp(-8 / this.L); // reaches the target well within the lookahead
    const { L, buf } = this;
    const cap = L + 2;
    for (let i = 0; i < n; i++) {
      let pk = 0;
      for (let c = 0; c < nch; c++) {
        const x = ((inp[c] || inp[0] || [])[i] || 0) * drive;
        (buf[c] || (buf[c] = new Float32Array(L + 1)))[this.w] = x;
        const h = this.hist[c] || (this.hist[c] = new Float32Array(TP_TAPS));
        h.copyWithin(0, 1); h[TP_TAPS - 1] = x;
        const a = Limiter.interPeak(h); if (a > pk) pk = a;
      }
      // The interpolated peak lies a few samples back; the lookahead window still covers it.
      const need = pk > ceil ? ceil / pk : 1;
      const n0 = this.n++;
      while (this.dqLen && this.dqV[(this.dqHead + this.dqLen - 1) % cap] >= need) this.dqLen--;
      const tail = (this.dqHead + this.dqLen) % cap;
      this.dqN[tail] = n0; this.dqV[tail] = need; this.dqLen++;
      while (this.dqN[this.dqHead] <= n0 - (L + 1)) { this.dqHead = (this.dqHead + 1) % cap; this.dqLen--; }
      const target = this.dqV[this.dqHead];
      this.g = target < this.g ? this.g + (target - this.g) * atk : target + (this.g - target) * rel;
      const r = (this.w + 1) % (L + 1);
      for (let c = 0; c < nch; c++) {
        // No hard clip here: clipping single samples would create new inter-sample peaks.
        out[c][i] = buf[c][r] * this.g;
      }
      this.w = r;
    }
    return true;
  }
}
registerProcessor('klang-limiter', Limiter);

// Noise gate / downward expander with hold.
const GATE = { threshold: [-45, -90, 0], range: [-40, -90, 0], attack: [2, 0.1, 100], hold: [60, 0, 1000], release: [150, 5, 3000] };
class Gate extends AudioWorkletProcessor {
  static get parameterDescriptors() { return kparams(GATE); }
  constructor() { super(); this.env = 0; this.g = 0; this.held = 0; }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    const n = out[0].length, nch = out.length;
    const thr = dbToGain(p.threshold[0]), floor = dbToGain(p.range[0]);
    const a = coef(p.attack[0]), r = coef(p.release[0]);
    const holdN = (p.hold[0] / 1000) * sampleRate;
    const envRel = coef(20);
    for (let i = 0; i < n; i++) {
      let pk = 0;
      for (let c = 0; c < nch; c++) { const v = Math.abs((inp[c] || inp[0] || [])[i] || 0); if (v > pk) pk = v; }
      this.env = pk > this.env ? pk : this.env * envRel;
      let target;
      if (this.env >= thr) { target = 1; this.held = holdN; } else if (this.held > 0) { target = 1; this.held--; } else target = floor;
      this.g = target > this.g ? target + (this.g - target) * a : target + (this.g - target) * r;
      for (let c = 0; c < nch; c++) out[c][i] = ((inp[c] || inp[0] || [])[i] || 0) * this.g;
    }
    return true;
  }
}
registerProcessor('klang-gate', Gate);

// Split-band de-esser: only the band above `frequency` is turned down when it gets loud.
const DEESS = { frequency: [6000, 2000, 12000], threshold: [-30, -60, 0], reduction: [10, 0, 24] };
class DeEsser extends AudioWorkletProcessor {
  static get parameterDescriptors() { return kparams(DEESS); }
  constructor() { super(); this.z = [[0, 0, 0, 0], [0, 0, 0, 0]]; this.env = 0; this.g = 1; this.f = 0; this.target = 1; }
  design(f) {
    const w = (2 * Math.PI * f) / sampleRate, cs = Math.cos(w), al = Math.sin(w) / (2 * 0.7071);
    const a0 = 1 + al;
    this.b = [(1 + cs) / 2 / a0, -(1 + cs) / a0, (1 + cs) / 2 / a0];
    this.a = [(-2 * cs) / a0, (1 - al) / a0];
    this.f = f;
  }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    const n = out[0].length, nch = out.length;
    if (p.frequency[0] !== this.f) this.design(p.frequency[0]);
    const thrDb = p.threshold[0], maxRed = p.reduction[0];
    const atk = coef(1), rel = coef(60), gs = coef(3);
    const [b0, b1, b2] = this.b, [a1, a2] = this.a;
    const hp = new Float32Array(nch);
    for (let i = 0; i < n; i++) {
      let pk = 0;
      for (let c = 0; c < nch; c++) {
        const x = (inp[c] || inp[0] || [])[i] || 0, z = this.z[c] || (this.z[c] = [0, 0, 0, 0]);
        const y = b0 * x + b1 * z[0] + b2 * z[1] - a1 * z[2] - a2 * z[3];
        z[1] = z[0]; z[0] = x; z[3] = z[2]; z[2] = y;
        hp[c] = y;
        const a = Math.abs(y); if (a > pk) pk = a;
      }
      this.env = pk > this.env ? pk + (this.env - pk) * atk : pk + (this.env - pk) * rel;
      if ((i & 7) === 0) {
        const envDb = 20 * Math.log10(this.env + 1e-12);
        this.target = dbToGain(-Math.min(maxRed, Math.max(0, (envDb - thrDb) * 0.75)));
      }
      this.g = this.target + (this.g - this.target) * gs;
      for (let c = 0; c < nch; c++) {
        const x = (inp[c] || inp[0] || [])[i] || 0;
        out[c][i] = x - hp[c] + hp[c] * this.g;
      }
    }
    return true;
  }
}
registerProcessor('klang-deesser', DeEsser);

// Soft-clip saturation for warmth and density.
const SAT = { drive: [6, 0, 30], mix: [1, 0, 1], output: [0, -24, 6] };
class Saturation extends AudioWorkletProcessor {
  static get parameterDescriptors() { return kparams(SAT); }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    const d = dbToGain(p.drive[0]), mix = p.mix[0], o = dbToGain(p.output[0]);
    const norm = 1 / Math.tanh(d);
    for (let c = 0; c < out.length; c++) {
      const x = inp[c] || inp[0], y = out[c];
      if (!x) { y.fill(0); continue; }
      // Full scale stays at full scale; quieter material gets denser and louder.
      for (let i = 0; i < y.length; i++) y[i] = ((1 - mix) * x[i] + mix * Math.tanh(x[i] * d) * norm) * o;
    }
    return true;
  }
}
registerProcessor('klang-saturation', Saturation);

// ITU-R BS.1770 / EBU R128 loudness meter. Posts { m, s, i, tp } about ten times a second.
class LoudnessMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    const fs = sampleRate;
    let K = Math.tan((Math.PI * 1681.974450955533) / fs), Q = 0.7071752369554196;
    const Vh = Math.pow(10, 3.999843853973347 / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    let a0 = 1 + K / Q + K * K;
    this.s1 = { b0: (Vh + (Vb * K) / Q + K * K) / a0, b1: (2 * (K * K - Vh)) / a0, b2: (Vh - (Vb * K) / Q + K * K) / a0, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
    K = Math.tan((Math.PI * 38.13547087602444) / fs); Q = 0.5003270373238773;
    a0 = 1 + K / Q + K * K;
    this.s2 = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
    this.z = [[new Float64Array(4), new Float64Array(4)], [new Float64Array(4), new Float64Array(4)]];
    this.step = Math.round(fs * 0.1);           // 100 ms sub-blocks
    this.acc = 0; this.n = 0; this.tp = 0;
    this.blocks = [];                           // mean-square per 100 ms
    this.gated = [];                            // 400 ms block loudness history for integration
    this.port.onmessage = (e) => { if (e.data === 'reset') { this.blocks = []; this.gated = []; this.tp = 0; } };
  }
  filt(x, z, c) {
    const y = c.b0 * x + c.b1 * z[0] + c.b2 * z[1] - c.a1 * z[2] - c.a2 * z[3];
    z[1] = z[0]; z[0] = x; z[3] = z[2]; z[2] = y;
    return y;
  }
  process(inputs) {
    const inp = inputs[0];
    if (!inp || !inp.length) return true;
    const n = inp[0].length;
    for (let i = 0; i < n; i++) {
      let ms = 0;
      for (let c = 0; c < Math.min(2, inp.length); c++) {
        const x = inp[c][i], z = this.z[c];
        const a = Math.abs(x); if (a > this.tp) this.tp = a;
        const y = this.filt(this.filt(x, z[0], this.s1), z[1], this.s2);
        ms += y * y;
      }
      if (inp.length === 1) ms *= 2;
      this.acc += ms; this.n++;
      if (this.n >= this.step) {
        this.blocks.push(this.acc / this.n); this.acc = 0; this.n = 0;
        if (this.blocks.length > 30) this.blocks.shift();
        const mean = (k) => { const b = this.blocks.slice(-k); return b.reduce((x, y) => x + y, 0) / b.length; };
        const L = (v) => -0.691 + 10 * Math.log10(v + 1e-20);
        const m = this.blocks.length >= 4 ? mean(4) : null;
        if (m !== null) this.gated.push(m);
        // Integrated: absolute gate -70 LUFS, then relative gate -10 LU.
        let integrated = null;
        const abs = this.gated.filter((v) => L(v) > -70);
        if (abs.length) {
          const rel = L(abs.reduce((x, y) => x + y, 0) / abs.length) - 10;
          const kept = abs.filter((v) => L(v) > rel);
          if (kept.length) integrated = L(kept.reduce((x, y) => x + y, 0) / kept.length);
        }
        this.port.postMessage({ m: m === null ? null : L(m), s: this.blocks.length >= 30 ? L(mean(30)) : null, i: integrated, tp: 20 * Math.log10(this.tp + 1e-20) });
      }
    }
    return true;
  }
}
registerProcessor('klang-meter', LoudnessMeter);

// ── More effects (morefx.js) ─────────────────────────────────────────────
// Input channel c, falling back to channel 0 (mono input) or silence.
const chan = (inp, c) => (inp && (inp[c] || inp[0])) || null;
// Timeline frame of the first sample this processor renders: options carry the timeline
// position `from` that sounds at context time `when` (as in graph.js), so phase-dependent
// state (grain windows, sample-and-hold) is locked to the timeline, not to playback start.
const timelineFrame = (o) => {
  const f = typeof currentFrame === 'number' ? currentFrame : 0; // eslint-disable-line no-undef
  return Math.round(((o?.from || 0) - (o?.when || 0)) * sampleRate) + f;
};

// Downward expander: below `threshold` the level drops `ratio` dB per dB, at most `range` dB.
const EXPANDER = { threshold: [-40, -90, 0], ratio: [2, 1, 20], range: [-40, -90, 0], attack: [1, 0.1, 100], release: [100, 5, 3000] };
class Expander extends AudioWorkletProcessor {
  static get parameterDescriptors() { return kparams(EXPANDER); }
  constructor() { super(); this.env = 0; this.g = null; this.target = 1; this.k = 0; }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    const n = out[0].length, nch = out.length;
    const thr = p.threshold[0], ratio = p.ratio[0], range = p.range[0];
    // Start closed, as after silence, so a render starting mid-timeline matches a full one.
    if (this.g === null) this.g = this.target = ratio > 1 ? dbToGain(range) : 1;
    const a = coef(p.attack[0]), r = coef(p.release[0]), envRel = coef(30);
    for (let i = 0; i < n; i++) {
      let pk = 0;
      for (let c = 0; c < nch; c++) { const x = chan(inp, c); const v = x ? Math.abs(x[i]) : 0; if (v > pk) pk = v; }
      this.env = pk > this.env ? pk : this.env * envRel;
      if ((this.k++ & 7) === 0) {
        const envDb = 20 * Math.log10(this.env + 1e-12);
        this.target = envDb >= thr ? 1 : dbToGain(Math.max(range, (envDb - thr) * (ratio - 1)));
      }
      // Opening (gain rising) uses attack; closing uses release.
      this.g = this.target > this.g ? this.target + (this.g - this.target) * a : this.target + (this.g - this.target) * r;
      for (let c = 0; c < nch; c++) { const x = chan(inp, c); out[c][i] = x ? x[i] * this.g : 0; }
    }
    return true;
  }
}
registerProcessor('klang-expander', Expander);

// Transient shaper: onsets are where a fast-attack envelope leads a slow-attack one,
// sustain is where a slow-release envelope trails above a fast-release one. Level-independent.
// The envelopes follow a ~10 ms sliding peak (no waveform ripple), so steady tones pass unchanged.
const TRANSIENT = { attack: [0, -24, 24], sustain: [0, -24, 24], output: [0, -24, 12] };
class Transient extends AudioWorkletProcessor {
  static get parameterDescriptors() { return kparams(TRANSIENT); }
  constructor() {
    super();
    this.fa = 0; this.sa = 0; this.fr = 0; this.sr = 0; this.gDb = 0;
    this.blk = new Float32Array(15); this.bi = 0; this.cur = 0; this.cnt = 0; this.hmax = 0;
    this.B = Math.max(8, Math.round(sampleRate / 1500)); // block length; 15 blocks + current ≈ 10 ms
    this.c = { slowA: coef(25), rel: coef(60), fastR: coef(30), slowR: coef(350), smooth: coef(1) };
  }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    const n = out[0].length, nch = out.length;
    const atk = p.attack[0], sus = p.sustain[0], o = dbToGain(p.output[0]);
    const C = this.c, blk = this.blk;
    for (let i = 0; i < n; i++) {
      let pk = 0;
      for (let c = 0; c < nch; c++) { const x = chan(inp, c); const v = x ? Math.abs(x[i]) : 0; if (v > pk) pk = v; }
      if (pk > this.cur) this.cur = pk;
      const det = this.cur > this.hmax ? this.cur : this.hmax;
      if (++this.cnt >= this.B) {
        blk[this.bi] = this.cur; this.bi = (this.bi + 1) % blk.length; this.cur = 0; this.cnt = 0;
        let m = 0; for (let k = 0; k < blk.length; k++) if (blk[k] > m) m = blk[k];
        this.hmax = m;
      }
      this.fa = det > this.fa ? det : det + (this.fa - det) * C.rel;
      this.sa = det > this.sa ? det + (this.sa - det) * C.slowA : det + (this.sa - det) * C.rel;
      this.fr = det > this.fr ? det : det + (this.fr - det) * C.fastR;
      this.sr = det > this.sr ? det : det + (this.sr - det) * C.slowR;
      // dB differences with a 0.5 dB dead band, full effect at 6.5 dB.
      const dA = 20 * Math.log10((this.fa + 1e-9) / (this.sa + 1e-9));
      const dS = 20 * Math.log10((this.sr + 1e-9) / (this.fr + 1e-9));
      const wA = Math.min(1, Math.max(0, (dA - 0.5) / 6)), wS = Math.min(1, Math.max(0, (dS - 0.5) / 6));
      const target = atk * wA + sus * wS;
      this.gDb = target + (this.gDb - target) * C.smooth;
      const g = dbToGain(this.gDb) * o;
      for (let c = 0; c < nch; c++) { const x = chan(inp, c); out[c][i] = x ? x[i] * g : 0; }
    }
    return true;
  }
}
registerProcessor('klang-transient', Transient);

// Bit crusher: sample-and-hold at `rate` Hz (phase locked to the timeline), then
// quantisation to a step of 2^(1-bits) (fractional bits allowed).
const CRUSH = { bits: [8, 1, 16], rate: [11025, 100, 48000], mix: [1, 0, 1] };
class BitCrusher extends AudioWorkletProcessor {
  static get parameterDescriptors() { return kparams(CRUSH); }
  constructor(opts) { super(); this.opts = opts?.processorOptions || {}; this.T = null; this.last = 0; this.held = [0, 0]; }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    const n = out[0].length, nch = out.length;
    const inc = p.rate[0] / sampleRate, mix = p.mix[0];
    const step = Math.pow(2, 1 - p.bits[0]);
    // A new sample is taken whenever floor(timelineFrame · rate/sr) changes: the same frames
    // in every render, whatever position it started from.
    if (this.T === null) { this.T = timelineFrame(this.opts); this.last = Math.floor((this.T - 1) * inc); }
    for (let i = 0; i < n; i++) {
      const k = Math.floor(this.T++ * inc);
      const take = k !== this.last || inc >= 1;
      this.last = k;
      for (let c = 0; c < nch; c++) {
        const x = chan(inp, c), v = x ? x[i] : 0;
        if (take) this.held[c] = Math.round(v / step) * step;
        out[c][i] = (1 - mix) * v + mix * (this.held[c] || 0);
      }
    }
    return true;
  }
}
registerProcessor('klang-bitcrusher', BitCrusher);

// Pitch shifter: two delay taps sweep through a `window`-ms delay range at the speed that
// resamples by 2^(semitones/12), each faded in/out with sin^2 so the fades sum to 1. When a
// tap restarts (at zero weight) its delay is nudged by up to 15 ms to the offset whose
// waveform best matches the other tap (normalised cross-correlation), so the crossfade
// doesn't cancel or warble. The sweep phase is locked to the timeline, and the first restart
// after every 200 ms timeline boundary skips the alignment: that breaks the chain of offsets
// (each depends on the previous one), so a render started mid-timeline converges to exactly
// the full render within 200 ms + two grain cycles. Good enough for previews, not mastering
// (the destructive `pitch` process uses Rubber Band).
const PITCH = { semitones: [0, -12, 12], window: [60, 20, 120], mix: [1, 0, 1] };
class PitchShift extends AudioWorkletProcessor {
  static get parameterDescriptors() { return kparams(PITCH); }
  constructor(opts) {
    super();
    this.opts = opts?.processorOptions || {};
    this.size = 1 << 16; this.mask = this.size - 1;
    this.buf = [new Float32Array(this.size), new Float32Array(this.size)];
    this.mono = new Float32Array(this.size);
    this.search = Math.round(0.015 * sampleRate); this.corrLen = Math.round(0.008 * sampleRate);
    this.w = 0; this.ph = null; this.off = [0, 0];
    this.T = 0; this.lastBucket = null; this.bucketLen = Math.round(0.2 * sampleRate);
  }
  // Offset (0…search samples) added to base delay `base` that best matches delay `other`.
  align(base, other) {
    const { mono, mask, w, corrLen } = this;
    const step = sampleRate > 60000 ? 4 : 2;
    let best = 0, bestScore = -Infinity;
    const ob = Math.round(other), bb = Math.round(base);
    let eo = 0;
    for (let m = 0; m < corrLen; m += 2) { const v = mono[(w - ob - m) & mask]; eo += v * v; }
    if (eo < 1e-10) return 0; // silence: nothing to match
    for (let o = 0; o <= this.search; o += step) {
      let dot = 0, e = 0;
      for (let m = 0; m < corrLen; m += 2) {
        const a = mono[(w - ob - m) & mask], c = mono[(w - bb - o - m) & mask];
        dot += a * c; e += c * c;
      }
      const score = dot / Math.sqrt(e + 1e-12);
      if (score > bestScore) { bestScore = score; best = o; }
    }
    return best;
  }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    const n = out[0].length, nch = out.length;
    const ratio = Math.pow(2, p.semitones[0] / 12), mix = p.mix[0];
    const W = Math.min(this.size - this.search - this.corrLen - 8, (p.window[0] / 1000) * sampleRate);
    const inc = (1 - ratio) / W;
    if (this.ph === null) { this.T = timelineFrame(this.opts); const t = this.T * inc; this.ph = t - Math.floor(t); }
    const { buf, mask, mono, off } = this;
    for (let i = 0; i < n; i++) {
      const w = this.w;
      let sum = 0;
      for (let c = 0; c < nch; c++) {
        const x = chan(inp, c), v = x ? x[i] : 0;
        (buf[c] || (buf[c] = new Float32Array(this.size)))[w] = v; sum += v;
      }
      mono[w] = sum;
      const f0 = this.ph, f1 = f0 >= 0.5 ? f0 - 0.5 : f0 + 0.5;
      const s0 = Math.sin(Math.PI * f0), g0 = s0 * s0, g1 = 1 - g0;
      const d0 = f0 * W + off[0], d1 = f1 * W + off[1];
      const i0 = Math.floor(d0), fr0 = d0 - i0, i1 = Math.floor(d1), fr1 = d1 - i1;
      for (let c = 0; c < nch; c++) {
        const b = buf[c];
        const a0 = b[(w - i0) & mask], b0 = b[(w - i0 - 1) & mask];
        const a1 = b[(w - i1) & mask], b1 = b[(w - i1 - 1) & mask];
        const wet = g0 * (a0 + (b0 - a0) * fr0) + g1 * (a1 + (b1 - a1) * fr1);
        out[c][i] = (1 - mix) * b[w] + mix * wet;
      }
      // Advance; a tap whose phase wraps is at zero weight, so re-align it now.
      let ph = this.ph + inc;
      const wrap0 = ph >= 1 || ph < 0;
      if (wrap0) ph -= Math.floor(ph);
      const wrap1 = inc !== 0 && (this.ph < 0.5) !== (ph < 0.5) && !wrap0;
      this.ph = ph;
      const T = this.T++;
      if (wrap0 || wrap1) {
        const k = wrap0 ? 0 : 1, j = 1 - k;
        const fk = k === 0 ? ph : (ph >= 0.5 ? ph - 0.5 : ph + 0.5), fj = j === 0 ? ph : (ph >= 0.5 ? ph - 0.5 : ph + 0.5);
        const bucket = Math.floor(T / this.bucketLen);
        const reset = bucket !== this.lastBucket;
        this.lastBucket = bucket;
        off[k] = reset ? 0 : this.align(fk * W, fj * W + off[j]); // align() reads up to this.w = newest sample
      }
      this.w = (w + 1) & mask;
    }
    return true;
  }
}
registerProcessor('klang-pitchshift', PitchShift);

// Up-to-3-band compressor (multiband, vocal enhancer): input k is band k; the bands are
// compressed independently (stereo-linked) and summed. Ratio 1 is an exact pass-through,
// and there is no automatic makeup gain, so `m*` is exactly the makeup applied.
const BANDCOMP = { attack: [10, 0, 1000], release: [150, 1, 3000], knee: [6, 0, 24] };
for (const b of [0, 1, 2]) Object.assign(BANDCOMP, { [`t${b}`]: [-24, -90, 0], [`r${b}`]: [1, 1, 30], [`m${b}`]: [0, -24, 24] });
class BandCompressor extends AudioWorkletProcessor {
  static get parameterDescriptors() { return kparams(BANDCOMP); }
  constructor() { super(); this.env = [0, 0, 0]; }
  process(inputs, outputs, p) {
    const out = outputs[0];
    const n = out[0].length, nch = out.length;
    for (let c = 0; c < nch; c++) out[c].fill(0);
    const a = coef(p.attack[0]), r = coef(p.release[0]), K = p.knee[0];
    for (let b = 0; b < 3; b++) {
      const inp = inputs[b];
      if (!inp || !inp.length) { this.env[b] *= Math.pow(r, n); continue; }
      const T = p[`t${b}`][0], slope = 1 / p[`r${b}`][0] - 1, mk = dbToGain(p[`m${b}`][0]);
      let env = this.env[b];
      for (let i = 0; i < n; i++) {
        let pk = 0;
        for (let c = 0; c < nch; c++) { const x = chan(inp, c); const v = x ? Math.abs(x[i]) : 0; if (v > pk) pk = v; }
        env = pk > env ? pk + (env - pk) * a : pk + (env - pk) * r;
        let g = mk;
        if (slope !== 0 && env > 1e-6) {
          const over = 20 * Math.log10(env) - T;
          const red = over <= -K / 2 ? 0 : over < K / 2 ? (slope * (over + K / 2) ** 2) / (2 * K) : slope * over;
          if (red !== 0) g *= dbToGain(red);
        }
        for (let c = 0; c < nch; c++) { const x = chan(inp, c); if (x) out[c][i] += x[i] * g; }
      }
      this.env[b] = env;
    }
    return true;
  }
}
registerProcessor('klang-bandcomp', BandCompressor);
