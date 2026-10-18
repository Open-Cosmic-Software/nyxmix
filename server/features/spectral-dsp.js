// Spectral DSP for NyxMix: STFT/ISTFT, spectral attenuation, spectral healing,
// noise prints and noise reduction, plus a spectrogram renderer and a tiny PNG
// encoder. Pure JS, no dependencies.
//
// The STFT uses a periodic Hann window for analysis *and* synthesis with 75%
// overlap (hop = N/4). Σ w² over the four overlapping frames is exactly 1.5,
// so dividing by 1.5 gives perfect reconstruction. Processing streams frame by
// frame and writes the result back into the input array in place: a frame only
// reads samples at or after its own start, and samples are written back only
// once all four frames that cover them are done. Memory is O(N) per channel,
// no spectrogram matrix is ever held, whatever the file length.
import zlib from 'node:zlib';

// This file sits in server/features/, which the server auto-loads as feature
// modules, so it needs a (no-op) register export.
export async function register() {}

export const fftSizeFor = (sr) => (sr > 64000 ? 4096 : 2048);

// ── FFT ─────────────────────────────────────────────────────────────────
// Real FFT of size n via one complex radix-2 FFT of size n/2.
export class RealFFT {
  constructor(n) {
    if (n < 4 || (n & (n - 1))) throw new Error('FFT size must be a power of two >= 4');
    this.n = n;
    const m = (this.m = n >> 1);
    this.rev = new Uint32Array(m);
    const bits = Math.log2(m);
    for (let i = 0; i < m; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(m >> 1 || 1); this.sin = new Float64Array(m >> 1 || 1);
    for (let k = 0; k < m >> 1; k++) { this.cos[k] = Math.cos((2 * Math.PI * k) / m); this.sin[k] = Math.sin((2 * Math.PI * k) / m); }
    this.wr = new Float64Array(m + 1); this.wi = new Float64Array(m + 1);
    for (let k = 0; k <= m; k++) { this.wr[k] = Math.cos((2 * Math.PI * k) / n); this.wi[k] = -Math.sin((2 * Math.PI * k) / n); }
    this.zr = new Float64Array(m); this.zi = new Float64Array(m);
  }

  _fft(re, im, inverse) {
    const m = this.m, rev = this.rev, cs = this.cos, sn = this.sin;
    for (let i = 0; i < m; i++) {
      const j = rev[i];
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    const sgn = inverse ? 1 : -1;
    for (let size = 2; size <= m; size <<= 1) {
      const half = size >> 1, step = m / size;
      for (let i = 0; i < m; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cs[k], wi = sgn * sn[k];
          const a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  // x: length n → re/im: length n/2 + 1 (bins 0..n/2).
  forward(x, re, im) {
    const m = this.m, zr = this.zr, zi = this.zi, wr = this.wr, wi = this.wi;
    for (let i = 0; i < m; i++) { zr[i] = x[2 * i]; zi[i] = x[2 * i + 1]; }
    this._fft(zr, zi, false);
    for (let k = 0; k <= m; k++) {
      const k1 = k === m ? 0 : k, k2 = k === 0 ? 0 : m - k;
      const ar = zr[k1], ai = zi[k1], br = zr[k2], bi = -zi[k2];
      const er = (ar + br) * 0.5, ei = (ai + bi) * 0.5;
      const or = (ai - bi) * 0.5, oi = -(ar - br) * 0.5;
      re[k] = er + wr[k] * or - wi[k] * oi;
      im[k] = ei + wr[k] * oi + wi[k] * or;
    }
  }

  // re/im: length n/2 + 1 → x: length n (scaled so inverse(forward(x)) = x).
  inverse(re, im, x) {
    const m = this.m, zr = this.zr, zi = this.zi, wr = this.wr, wi = this.wi;
    for (let k = 0; k < m; k++) {
      const xr = re[k], xi = im[k], yr = re[m - k], yi = -im[m - k];
      const er = (xr + yr) * 0.5, ei = (xi + yi) * 0.5;
      const dr = (xr - yr) * 0.5, di = (xi - yi) * 0.5;
      // Zo = d · W^-k, W^-k = (wr, -wi)
      const or = dr * wr[k] + di * wi[k], oi = di * wr[k] - dr * wi[k];
      zr[k] = er - oi; zi[k] = ei + or;
    }
    this._fft(zr, zi, true);
    const s = 1 / m;
    for (let i = 0; i < m; i++) { x[2 * i] = zr[i] * s; x[2 * i + 1] = zi[i] * s; }
  }
}

const fftCache = new Map();
export const getFFT = (n) => { let f = fftCache.get(n); if (!f) fftCache.set(n, (f = new RealFFT(n))); return f; };
const hannCache = new Map();
export function hann(n) {
  let w = hannCache.get(n);
  if (!w) { w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); hannCache.set(n, w); }
  return w;
}

// ── STFT engine ─────────────────────────────────────────────────────────
// Processes x[a, b) in place. onFrame(re, im, t) may modify the spectrum of
// the frame starting at sample t; active(t) === false skips the FFT round trip
// (the frame passes through untouched). Samples outside [a, b) are read as
// context but never written.
export function stftProcess(x, { n, a = 0, b = x.length, active, onFrame }) {
  const len = x.length;
  a = Math.max(0, a); b = Math.min(len, b);
  if (b <= a) return 0;
  const h = n >> 2, w = hann(n), fft = getFFT(n);
  const frame = new Float64Array(n), acc = new Float64Array(n);
  const re = new Float64Array((n >> 1) + 1), im = new Float64Array((n >> 1) + 1);
  const norm = 1 / 1.5;
  let processed = 0;
  for (let t = a - (n - h); t < b; t += h) {
    const lo = Math.max(0, -t), hi = Math.min(n, len - t);
    if (active && !active(t)) {
      for (let i = lo; i < hi; i++) acc[i] += x[t + i] * w[i] * w[i];
    } else {
      frame.fill(0);
      for (let i = lo; i < hi; i++) frame[i] = x[t + i] * w[i];
      fft.forward(frame, re, im);
      onFrame(re, im, t);
      fft.inverse(re, im, frame);
      for (let i = 0; i < n; i++) acc[i] += frame[i] * w[i];
      processed++;
    }
    // Samples [t, t + h) are complete now.
    for (let i = 0; i < h; i++) { const s = t + i; if (s >= a && s < b) x[s] = acc[i] * norm; }
    acc.copyWithin(0, h); acc.fill(0, n - h);
  }
  return processed;
}

// Raised-cosine edge: 1 inside [lo, hi], fading to 0 over `f` outside.
function edge(v, lo, hi, f) {
  const d = v < lo ? lo - v : v > hi ? v - hi : 0;
  if (d === 0) return 1;
  if (!(f > 0) || d >= f) return 0;
  return 0.5 + 0.5 * Math.cos((Math.PI * d) / f);
}

// Per-bin frequency weight for a band with feathering measured in octaves
// (at least ~1.5 bins so narrow boxes still fade smoothly).
function bandWeights(n, sr, lowHz, highHz, featherOct) {
  const m = n >> 1, binHz = sr / n, wts = new Float64Array(m + 1);
  const fLo = Math.max(0, lowHz), fHi = Math.min(sr / 2, highHz);
  for (let k = 0; k <= m; k++) {
    const f = k * binHz;
    let wv;
    if (f >= fLo && f <= fHi) wv = 1;
    else if (f < fLo) {
      const dOct = Math.log2(fLo / Math.max(f, 1e-6)), dBins = (fLo - f) / binHz;
      wv = Math.max(edge(dOct, 0, 0, featherOct), edge(dBins, 0, 0, 1.5));
    } else {
      const dOct = Math.log2(f / Math.max(fHi, 1e-6)), dBins = (f - fHi) / binHz;
      wv = Math.max(edge(dOct, 0, 0, featherOct), edge(dBins, 0, 0, 1.5));
    }
    wts[k] = wv;
  }
  return wts;
}

const badArgs = (msg) => Object.assign(new Error(msg), { status: 400, code: 'invalid_args' });

// ── regions: box, lasso polygon, brush strokes ───────────────────────────
// A region is given in source seconds + Hz and rasterised lazily, one STFT
// frame (column) at a time: region.column(tc, row) fills the per-bin weight
// row (0…1, soft edges) for the frame centred at tc seconds. Nothing per
// frame × bin is ever stored, so memory is O(bins) whatever the region size.
//   box      { start, end, lowHz, highHz }            separable fast path
//   polygon  { polygon: [[t, hz], …] }                lasso, even-odd fill
//   strokes  { strokes: [{ points: [[t, hz], …], radiusMs, radiusSemitones, erase }] }
//                                                     brush, painted in order;
//                                                     erase strokes cut holes
// Frequency is warped as log2(f + c): a log (octave) axis above ~c Hz that
// turns linear below it, so soft edges never get narrower than ~1.5 bins
// and 0 Hz is a valid vertex. c is derived from the FFT bin width.
export const BRUSH_SOFTNESS = 0.35;   // soft rim of a brush stroke, fraction of its radius
export const regionShape = (p) => (p.polygon ? 'polygon' : p.strokes ? 'strokes' : 'box');
const warpC = (sr, n) => (1.5 * sr / n) / ((1 / 6) * Math.LN2);

function lowerBound(arr, v, lo = 0, hi = arr.length) {
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
  return lo;
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  let t = L > 0 ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px, ey = ay + t * dy - py;
  return Math.sqrt(ex * ex + ey * ey);
}

// Shift a region's times by dt seconds (worker: source time → local buffer time).
export function shiftRegion(p, dt) {
  if (p.polygon) return { ...p, polygon: p.polygon.map(([t, f]) => [t + dt, f]) };
  if (p.strokes) return { ...p, strokes: p.strokes.map((s) => ({ ...s, points: s.points.map(([t, f]) => [t + dt, f]) })) };
  return { ...p, start: p.start + dt, end: p.end + dt };
}

export function makeRegion(sr, n, p = {}) {
  const m = n >> 1, h = n >> 2, binHz = sr / n, nyq = sr / 2, c = warpC(sr, n);
  const featherOct = p.featherOct ?? 1 / 6, feather = p.feather ?? 0.01;
  const shape = regionShape(p);

  if (shape === 'box') {
    const { start, end, lowHz = 0, highHz = nyq } = p;
    if (!(end > start)) throw badArgs('end must be greater than start');
    if (!(highHz > lowHz)) throw badArgs('highHz must be greater than lowHz');
    const wf = bandWeights(n, sr, lowHz, highHz, featherOct);
    return {
      shape, t0: start - feather, t1: end + feather, lowHz, highHz,
      column(tc, out) {
        const w = edge(tc, start, end, feather);
        for (let k = 0; k <= m; k++) out[k] = w * wf[k];
        return w > 0;
      },
      // Per-bin time extent and peak weight (what heal works from).
      extents() {
        const aK = new Float64Array(m + 1).fill(Infinity), bK = new Float64Array(m + 1).fill(-Infinity);
        for (let k = 0; k <= m; k++) if (wf[k] > 0) { aK[k] = start; bK[k] = end; }
        return { aK, bK, wK: wf };
      },
    };
  }

  let region;
  if (shape === 'polygon') {
    const pts = p.polygon;
    if (!Array.isArray(pts) || pts.length < 3) throw badArgs('polygon needs at least 3 points [t, hz]');
    const fT = Math.max(feather, 0.002), fV = featherOct;
    const V = Float64Array.from({ length: m + 1 }, (_, k) => Math.log2(k * binHz + c) / fV);
    const P = pts.map(([t, f]) => [t / fT, Math.log2(Math.min(nyq, Math.max(0, f)) + c) / fV]);
    const E = P.length, ed = new Float64Array(E * 4);
    let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
    P.forEach(([u, v], i) => {
      const [u2, v2] = P[(i + 1) % E];
      ed.set([u, v, u2, v2], i * 4);
      umin = Math.min(umin, u); umax = Math.max(umax, u); vmin = Math.min(vmin, v); vmax = Math.max(vmax, v);
    });
    if (!(umax > umin) || !(vmax > vmin)) throw badArgs('polygon has no area');
    const k0 = lowerBound(V, vmin - 1), k1 = Math.min(m, lowerBound(V, vmax + 1));
    const near = [], cross = [];
    region = {
      shape, t0: (umin - 1) * fT, t1: (umax + 1) * fT,
      lowHz: Math.max(0, 2 ** (vmin * fV) - c), highHz: Math.min(nyq, 2 ** (vmax * fV) - c),
      column(tc, out) {
        out.fill(0);
        const u = tc / fT;
        if (u < umin - 1 || u > umax + 1) return false;
        near.length = 0; cross.length = 0;
        for (let i = 0, o = 0; i < E; i++, o += 4) {
          const ax = ed[o], bx = ed[o + 2];
          if (u >= Math.min(ax, bx) - 1 && u <= Math.max(ax, bx) + 1) near.push(o);
          if ((ax <= u) !== (bx <= u)) cross.push(ed[o + 1] + ((u - ax) / (bx - ax)) * (ed[o + 3] - ed[o + 1]));
        }
        if (!near.length) return false;
        cross.sort((x, y) => x - y);
        let j = 0, any = false;
        for (let k = k0; k <= k1; k++) {
          const v = V[k];
          while (j < cross.length && cross[j] <= v) j++;
          if (j & 1) { out[k] = 1; any = true; continue; }
          let d = Infinity;
          for (const o of near) { const dd = segDist(u, v, ed[o], ed[o + 1], ed[o + 2], ed[o + 3]); if (dd < d) d = dd; }
          if (d < 1) { out[k] = 0.5 + 0.5 * Math.cos(Math.PI * d); any = true; }
        }
        return any;
      },
    };
  } else {
    if (!Array.isArray(p.strokes) || !p.strokes.length) throw badArgs('strokes needs at least one stroke');
    const S = Float64Array.from({ length: m + 1 }, (_, k) => 12 * Math.log2(k * binHz + c));
    const R = 1 + BRUSH_SOFTNESS;
    let t0 = Infinity, t1 = -Infinity, sLo = Infinity, sHi = -Infinity;
    const strokes = p.strokes.map((s) => {
      if (!Array.isArray(s.points) || !s.points.length) throw badArgs('every stroke needs at least one point [t, hz]');
      // A brush narrower than half a hop could fall between two frame centres.
      const rT = Math.max((s.radiusMs ?? 20) / 1000, (0.6 * h) / sr), rS = Math.max(0.05, s.radiusSemitones ?? 2);
      const pts = s.points.map(([t, f]) => [t / rT, (12 * Math.log2(Math.min(nyq, Math.max(0, f)) + c)) / rS]);
      if (pts.length === 1) pts.push(pts[0]);
      const seg = new Float64Array((pts.length - 1) * 4);
      let umin = Infinity, umax = -Infinity;
      for (let i = 0; i < pts.length - 1; i++) seg.set([...pts[i], ...pts[i + 1]], i * 4);
      for (const [u, v] of pts) {
        umin = Math.min(umin, u); umax = Math.max(umax, u);
        if (!s.erase) { sLo = Math.min(sLo, (v - R) * rS); sHi = Math.max(sHi, (v + R) * rS); }
      }
      if (!s.erase) { t0 = Math.min(t0, (umin - R) * rT); t1 = Math.max(t1, (umax + R) * rT); }
      return { rT, rS, seg, umin, umax, erase: !!s.erase };
    });
    if (!(t1 > t0)) throw badArgs('strokes only erase; paint something first');
    const near = [];
    region = {
      shape, t0, t1, lowHz: Math.max(0, 2 ** (sLo / 12) - c), highHz: Math.min(nyq, 2 ** (sHi / 12) - c),
      column(tc, out) {
        out.fill(0);
        if (tc < t0 || tc > t1) return false;
        let any = false;
        for (const s of strokes) {
          const u = tc / s.rT;
          if (u < s.umin - R || u > s.umax + R) continue;
          near.length = 0;
          let vlo = Infinity, vhi = -Infinity;
          for (let o = 0; o < s.seg.length; o += 4) {
            const ax = s.seg[o], bx = s.seg[o + 2];
            if (u < Math.min(ax, bx) - R || u > Math.max(ax, bx) + R) continue;
            near.push(o);
            vlo = Math.min(vlo, s.seg[o + 1], s.seg[o + 3]); vhi = Math.max(vhi, s.seg[o + 1], s.seg[o + 3]);
          }
          if (!near.length) continue;
          const ka = lowerBound(S, (vlo - R) * s.rS), kb = Math.min(m, lowerBound(S, (vhi + R) * s.rS));
          for (let k = ka; k <= kb; k++) {
            const v = S[k] / s.rS;
            let d = Infinity;
            for (const o of near) { const dd = segDist(u, v, s.seg[o], s.seg[o + 1], s.seg[o + 2], s.seg[o + 3]); if (dd < d) d = dd; }
            const w = d <= 1 ? 1 : d < R ? 0.5 + 0.5 * Math.cos((Math.PI * (d - 1)) / BRUSH_SOFTNESS) : 0;
            if (s.erase) out[k] *= 1 - w;
            else if (w > out[k]) out[k] = w;
          }
        }
        for (let k = 0; k <= m && !any; k++) if (out[k] > 0) any = true;
        return any;
      },
    };
  }
  // Generic extents: scan the region at a quarter hop.
  region.extents = () => {
    const aK = new Float64Array(m + 1).fill(Infinity), bK = new Float64Array(m + 1).fill(-Infinity), wK = new Float64Array(m + 1);
    const row = new Float64Array(m + 1), step = h / 4 / sr;
    for (let tc = region.t0; tc <= region.t1 + step; tc += step) {
      if (!region.column(tc, row)) continue;
      for (let k = 0; k <= m; k++) {
        const w = row[k];
        if (w <= 0) continue;
        if (tc < aK[k]) aK[k] = tc;
        if (tc > bK[k]) bK[k] = tc;
        if (w > wK[k]) wK[k] = w;
      }
    }
    return { aK, bK, wK };
  };
  return region;
}

function checkInside(region, sr, frames) {
  if (region.t0 >= frames / sr || region.t1 <= 0) throw badArgs('Region is outside the audio');
}

// ── spectral edit: attenuate a region (box, lasso or brush) ──────────────
export function attenuateRegion(channels, sr, params = {}) {
  const frames = channels[0].length, gainDb = params.gainDb ?? -20;
  const n = fftSizeFor(sr), half = n / 2, m = n >> 1;
  const region = makeRegion(sr, n, params);
  checkInside(region, sr, frames);
  const a = Math.floor(region.t0 * sr) - half, b = Math.ceil(region.t1 * sr) + half;
  const row = new Float64Array(m + 1);
  let processed = 0;
  for (const x of channels) {
    processed += stftProcess(x, {
      n, a, b,
      // active(t) runs right before onFrame(…, t) and leaves the row in place.
      active: (t) => region.column((t + half) / sr, row),
      onFrame: (re, im) => {
        for (let k = 0; k <= m; k++) {
          const ww = row[k];
          if (ww === 0) continue;
          const g = Math.pow(10, (gainDb * ww) / 20);
          re[k] *= g; im[k] *= g;
        }
      },
    });
  }
  return { framesProcessed: processed, fftSize: n, shape: region.shape };
}

// ── spectral heal: rebuild a region from its surroundings ────────────────
// Per bin, the region covers [a_k, b_k] in time (for a box the same for all
// bins; for a lasso or brush each frequency has its own span). The expected
// magnitude is interpolated (in the log domain) between the RMS spectrum of
// the frames just before a_k and just after b_k at that bin. Bins clearly
// louder than expected (> +3 dB: cough, click, phone ring) are pulled down to
// it, keeping their phase; bins far below it (dropouts) are filled to it with
// random phase. Everything else is untouched, so tones running through the
// region survive. The frequency (and brush-rim) softness blends the result.
// With brush strokes this is Audition's spot healing brush.
export function healRegion(channels, sr, params = {}) {
  const { contextFrames = 4, seed = 1 } = params;
  const frames = channels[0].length;
  const n = fftSizeFor(sr), h = n >> 2, m = n >> 1, half = n >> 1, w = hann(n), fft = getFFT(n);
  const region = makeRegion(sr, n, params);
  checkInside(region, sr, frames);
  const { aK, bK, wK } = region.extents();
  const bins = [];
  for (let k = 0; k <= m; k++) if (wK[k] > 0 && bK[k] >= aK[k]) bins.push(k);
  if (!bins.length) throw badArgs('The region is empty');
  // Per bin, in samples: frames centred in (lo_k, hi_k) are healed.
  const lo = new Float64Array(m + 1), hi = new Float64Array(m + 1);
  let Lmin = Infinity, Hmax = -Infinity;
  for (const k of bins) { lo[k] = aK[k] * sr - half; hi[k] = bK[k] * sr + half; Lmin = Math.min(Lmin, lo[k]); Hmax = Math.max(Hmax, hi[k]); }
  const ctx = contextFrames * h, g = h >> 1;
  const buf = new Float64Array(n), re = new Float64Array(m + 1), im = new Float64Array(m + 1);
  let rnd = seed >>> 0 || 1;
  const rand = () => { rnd ^= rnd << 13; rnd >>>= 0; rnd ^= rnd >>> 17; rnd ^= rnd << 5; rnd >>>= 0; return rnd / 4294967296; };

  let processed = 0;
  channels.forEach((x) => {
    // Context spectra on a half-hop grid; each frame feeds the bins whose
    // before/after window it falls in.
    const pA = new Float64Array(m + 1), pB = new Float64Array(m + 1), nA = new Float64Array(m + 1), nB = new Float64Array(m + 1);
    const cA = new Float64Array(m + 1), cB = new Float64Array(m + 1);
    const cFirst = Math.floor((Lmin - ctx) / g) * g, cLast = Hmax + ctx + g;
    for (let cc = cFirst; cc <= cLast; cc += g) {
      const t = Math.round(cc) - half;
      if (t < 0 || t + n > frames) continue;
      let need = false;
      for (const k of bins) if ((cc <= lo[k] && cc > lo[k] - ctx) || (cc >= hi[k] && cc < hi[k] + ctx)) { need = true; break; }
      if (!need) continue;
      for (let i = 0; i < n; i++) buf[i] = x[t + i] * w[i];
      fft.forward(buf, re, im);
      for (const k of bins) {
        const p = re[k] * re[k] + im[k] * im[k];
        if (cc <= lo[k] && cc > lo[k] - ctx) { pA[k] += p; nA[k]++; cA[k] += cc; }
        else if (cc >= hi[k] && cc < hi[k] + ctx) { pB[k] += p; nB[k]++; cB[k] += cc; }
      }
    }
    // Mean power per bin, light smoothing over 3 bins, log magnitude.
    const mean = (pw, cnt) => Float64Array.from(pw, (v, k) => (cnt[k] ? v / cnt[k] : NaN));
    const mA = mean(pA, nA), mB = mean(pB, nB);
    const lA = new Float64Array(m + 1), lB = new Float64Array(m + 1), cenA = new Float64Array(m + 1), cenB = new Float64Array(m + 1);
    const ok = new Uint8Array(m + 1);
    const sm = (arr, k) => { let s = 0, ws = 0; for (const [j, wt] of [[k - 1, 1], [k, 2], [k + 1, 1]]) if (j >= 0 && j <= m && Number.isFinite(arr[j])) { s += wt * arr[j]; ws += wt; } return ws ? s / ws : NaN; };
    for (const k of bins) {
      let a = sm(mA, k), b = sm(mB, k), ca = nA[k] ? cA[k] / nA[k] : NaN, cb = nB[k] ? cB[k] / nB[k] : NaN;
      if (!Number.isFinite(a)) { a = b; ca = cb; }
      if (!Number.isFinite(b)) { b = a; cb = ca; }
      if (!Number.isFinite(a)) continue;
      ok[k] = 1;
      lA[k] = Math.log(Math.sqrt(a) + 1e-12); lB[k] = Math.log(Math.sqrt(b) + 1e-12);
      cenA[k] = ca; cenB[k] = cb;
    }
    if (!bins.some((k) => ok[k])) throw Object.assign(new Error('Not enough audio around the region to heal from'), { status: 422, code: 'no_context' });
    processed += stftProcess(x, {
      n, a: Math.floor(Lmin) - half, b: Math.ceil(Hmax) + half,
      active: (t) => t + half > Lmin && t + half < Hmax,
      onFrame: (re2, im2, t) => {
        const cc = t + half;
        for (const k of bins) {
          if (!ok[k] || cc <= lo[k] || cc >= hi[k]) continue;
          const ww = wK[k];
          const span = Math.max(1, cenB[k] - cenA[k]);
          const frac = Math.min(1, Math.max(0, (cc - cenA[k]) / span));
          const T = Math.exp(lA[k] * (1 - frac) + lB[k] * frac);
          const M = Math.hypot(re2[k], im2[k]);
          let target;
          if (M > 1.4 * T) target = T;
          else if (M < 0.1 * T) target = T;
          else continue;
          // Blend in the log domain by the soft-edge weight.
          const outMag = Math.exp(Math.log(M + 1e-12) * (1 - ww) + Math.log(target) * ww);
          if (M < 0.1 * T) {
            const ph = 2 * Math.PI * rand();
            re2[k] = outMag * Math.cos(ph); im2[k] = outMag * Math.sin(ph);
          } else {
            const gg = outMag / M;
            re2[k] *= gg; im2[k] *= gg;
          }
        }
      },
    });
  });
  return { framesProcessed: processed, fftSize: n, shape: region.shape, binsTouched: bins.length };
}

// ── pitch (fundamental frequency) ─────────────────────────────────────────
// YIN (de Cheveigné & Kawahara 2002) on a ~16 kHz decimated mono signal, one
// estimate per `hop` seconds. The difference function is computed from an
// FFT cross-correlation plus running energies, so cost is O(N log N) per
// frame. Each frame reports hz (null when unvoiced) and a confidence 1 − d'
// (aperiodicity). x covers source time [offset, offset + x.length / sr).
export function detectPitch(x, sr, { offset = 0, start = offset, end = offset + x.length / sr, hop = 0.01, minHz = 50, maxHz = 1000, threshold = 0.15, silenceDb = -55 } = {}) {
  if (!(maxHz > minHz) || minHz <= 0) throw badArgs('maxHz must be greater than minHz > 0');
  const D = Math.max(1, Math.floor(sr / 16000)), srD = sr / D;
  maxHz = Math.min(maxHz, srD / 4);
  // Windowed-sinc low-pass + decimation.
  let y;
  if (D === 1) y = Float64Array.from(x);
  else {
    const half = 8 * D, fc = 0.45 / D, taps = new Float64Array(2 * half + 1);
    let s = 0;
    for (let i = -half; i <= half; i++) {
      const v = (i === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * i) / (Math.PI * i)) * (0.54 + 0.46 * Math.cos((Math.PI * i) / half));
      taps[i + half] = v; s += v;
    }
    for (let i = 0; i < taps.length; i++) taps[i] /= s;
    y = new Float64Array(Math.floor(x.length / D));
    for (let j = 0; j < y.length; j++) {
      const c = j * D;
      let acc = 0;
      for (let i = -half; i <= half; i++) { const v = x[c + i]; if (v !== undefined) acc += taps[i + half] * v; }
      y[j] = acc;
    }
  }
  const tauMin = Math.max(2, Math.floor(srD / maxHz)), tauMax = Math.ceil(srD / minHz);
  const W = Math.max(Math.round(0.03 * srD), tauMax), L = W + tauMax + 2;
  let N = 4; while (N < L) N <<= 1;
  const fft = getFFT(N), M = N >> 1;
  const a = new Float64Array(N), b = new Float64Array(N), r = new Float64Array(N);
  const Ar = new Float64Array(M + 1), Ai = new Float64Array(M + 1), Br = new Float64Array(M + 1), Bi = new Float64Array(M + 1);
  const q = new Float64Array(L + 1), dp = new Float64Array(tauMax + 2);
  const gate = Math.pow(10, silenceDb / 10) * W;
  const times = [], hz = [], conf = [];
  const count = Math.max(0, Math.floor((end - start) / hop + 1e-9) + 1);
  for (let f = 0; f < count; f++) {
    const tc = start + f * hop;
    // YIN compares [s0, s0 + W) with [s0 + τ, s0 + τ + W): centre that pair on tc.
    const s0 = Math.round((tc - offset) * srD) - ((W + tauMin) >> 1);
    a.fill(0); b.fill(0);
    for (let i = 0; i < L; i++) { const v = y[s0 + i]; b[i] = v === undefined ? 0 : v; }
    for (let i = 0; i < W; i++) a[i] = b[i];
    q[0] = 0;
    for (let i = 0; i < L; i++) q[i + 1] = q[i] + b[i] * b[i];
    times.push(Math.round(tc * 1e4) / 1e4);
    const e0 = q[W];
    if (e0 < gate) { hz.push(null); conf.push(0); continue; }
    fft.forward(a, Ar, Ai); fft.forward(b, Br, Bi);
    for (let k = 0; k <= M; k++) { const pr = Ar[k] * Br[k] + Ai[k] * Bi[k], pi = Ar[k] * Bi[k] - Ai[k] * Br[k]; Ar[k] = pr; Ai[k] = pi; }
    fft.inverse(Ar, Ai, r);
    // Cumulative-mean-normalised difference d'(τ).
    dp[0] = 1;
    let cum = 0;
    for (let tau = 1; tau <= tauMax + 1 && tau + W <= L; tau++) {
      const d = Math.max(0, e0 + (q[tau + W] - q[tau]) - 2 * r[tau]);
      cum += d;
      dp[tau] = cum > 0 ? (d * tau) / cum : 1;
    }
    let best = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (dp[tau] < threshold) { while (tau + 1 <= tauMax && dp[tau + 1] < dp[tau]) tau++; best = tau; break; }
    }
    if (best < 0) { best = tauMin; for (let tau = tauMin; tau <= tauMax; tau++) if (dp[tau] < dp[best]) best = tau; }
    const dBest = dp[best];
    let tauF = best;
    if (best > 1 && best < tauMax) {
      const x0 = dp[best - 1], x1 = dp[best], x2 = dp[best + 1], den = x0 - 2 * x1 + x2;
      if (den > 0) tauF = best + Math.max(-0.5, Math.min(0.5, (0.5 * (x0 - x2)) / den));
    }
    const c = Math.max(0, Math.min(1, 1 - dBest));
    conf.push(Math.round(c * 1000) / 1000);
    hz.push(dBest < Math.max(threshold, 0.25) ? Math.round((srD / tauF) * 100) / 100 : null);
  }
  return { start, end, hop, minHz, maxHz, times, hz, confidence: conf };
}

// Summary of a pitch track. A running median over 5 voiced frames is taken
// first so single-frame octave slips do not set min/max.
export function summarizePitch(p) {
  const v = p.hz.filter((x) => x !== null);
  const sm = v.map((_, i) => { const w = v.slice(Math.max(0, i - 2), i + 3).sort((x, y) => x - y); return w[w.length >> 1]; });
  const sorted = sm.slice().sort((x, y) => x - y);
  const pct = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
  const r1 = (x) => (x === null ? null : Math.round(x * 10) / 10);
  const confV = p.confidence.filter((_, i) => p.hz[i] !== null);
  return {
    frames: p.hz.length, voicedFrames: v.length,
    voicedFraction: p.hz.length ? Math.round((v.length / p.hz.length) * 1000) / 1000 : 0,
    medianHz: r1(pct(0.5)), minHz: r1(sorted[0] ?? null), maxHz: r1(sorted[sorted.length - 1] ?? null),
    p10Hz: r1(pct(0.1)), p90Hz: r1(pct(0.9)),
    meanConfidence: confV.length ? Math.round((confV.reduce((s, x) => s + x, 0) / confV.length) * 1000) / 1000 : 0,
  };
}

// Track as [[t, hz|null, confidence], …], decimated to at most maxPoints
// (median of the voiced frames per bucket; unvoiced if fewer than half voiced).
export function pitchPoints(p, maxPoints = Infinity) {
  const N = p.hz.length;
  if (N <= maxPoints) return p.times.map((t, i) => [t, p.hz[i], p.confidence[i]]);
  const out = [], step = N / maxPoints;
  for (let b = 0; b < maxPoints; b++) {
    const i0 = Math.floor(b * step), i1 = Math.max(i0 + 1, Math.floor((b + 1) * step));
    const v = [], cs = [];
    for (let i = i0; i < i1; i++) { cs.push(p.confidence[i]); if (p.hz[i] !== null) v.push(p.hz[i]); }
    v.sort((x, y) => x - y);
    const t = (p.times[i0] + p.times[i1 - 1]) / 2;
    out.push([Math.round(t * 1e4) / 1e4, v.length * 2 >= i1 - i0 ? v[v.length >> 1] : null, Math.round((cs.reduce((s, x) => s + x, 0) / cs.length) * 1000) / 1000]);
  }
  return out;
}

// ── noise print ─────────────────────────────────────────────────────────
// Mean power per bin (per channel) over all full frames inside [start, end].
// `offset` = seconds of channels[0][0] in source time (for range reads).
export function learnNoiseProfile(channels, sr, { start = 0, end, offset = 0 } = {}) {
  const frames = channels[0].length;
  const n = fftSizeFor(sr), h = n >> 2, m = n >> 1, w = hann(n), fft = getFFT(n);
  const s0 = Math.max(0, Math.round((start - offset) * sr));
  const e0 = Math.min(frames, end === undefined ? frames : Math.round((end - offset) * sr));
  if (e0 - s0 < n) throw Object.assign(new Error(`The noise print needs at least ${(n / sr * 1000).toFixed(0)} ms of audio (got ${((e0 - s0) / sr * 1000).toFixed(0)} ms)`), { status: 400, code: 'too_short' });
  const buf = new Float64Array(n), re = new Float64Array(m + 1), im = new Float64Array(m + 1);
  const out = [];
  let count = 0, sumSq = 0;
  for (const x of channels) {
    const pw = new Float64Array(m + 1);
    count = 0;
    for (let t = s0; t + n <= e0; t += h) {
      for (let i = 0; i < n; i++) buf[i] = x[t + i] * w[i];
      fft.forward(buf, re, im);
      for (let k = 0; k <= m; k++) pw[k] += re[k] * re[k] + im[k] * im[k];
      count++;
    }
    for (let k = 0; k <= m; k++) pw[k] /= count;
    for (let i = s0; i < e0; i++) sumSq += x[i] * x[i];
    out.push(pw);
  }
  return {
    version: 1, sampleRate: sr, fftSize: n, frames: count, start: offset + s0 / sr, end: offset + e0 / sr,
    rmsDbfs: round2(10 * Math.log10(Math.max(1e-20, sumSq / ((e0 - s0) * channels.length)))),
    channels: out,
  };
}
const round2 = (v) => Math.round(v * 100) / 100;

// Human/agent-friendly description of a profile.
export function describeProfile(p) {
  const n = p.fftSize, m = n >> 1, binHz = p.sampleRate / n;
  const pw = new Float64Array(m + 1);
  for (const c of p.channels) for (let k = 0; k <= m; k++) pw[k] += c[k] / p.channels.length;
  const bands = [['below 100 Hz', 0, 100], ['100–500 Hz', 100, 500], ['500 Hz–2 kHz', 500, 2000], ['2–6 kHz', 2000, 6000], ['above 6 kHz', 6000, p.sampleRate / 2]];
  let total = 0;
  for (let k = 1; k <= m; k++) total += pw[k];
  const bandsRelativeDb = {};
  for (const [name, lo, hi] of bands) {
    let s = 0;
    for (let k = Math.max(1, Math.ceil(lo / binHz)); k <= Math.min(m, Math.floor(hi / binHz)); k++) s += pw[k];
    bandsRelativeDb[name] = round2(10 * Math.log10(Math.max(1e-20, s / Math.max(1e-20, total))));
  }
  // Tonal peaks (hum, whine): bins > 12 dB above the local median.
  const peaks = [];
  for (let k = 2; k < m - 2; k++) {
    if (!(pw[k] > pw[k - 1] && pw[k] >= pw[k + 1])) continue;
    const lo = Math.max(1, k - 24), hi = Math.min(m, k + 24);
    const around = Array.from(pw.subarray(lo, hi + 1)).sort((x, y) => x - y);
    const med = around[around.length >> 1];
    const rel = 10 * Math.log10(pw[k] / Math.max(1e-30, med));
    if (rel > 12) peaks.push({ hz: Math.round(k * binHz), aboveFloorDb: round2(rel) });
  }
  peaks.sort((x, y) => y.aboveFloorDb - x.aboveFloorDb);
  return {
    start: p.start, end: p.end, duration: round2(p.end - p.start), frames: p.frames, fftSize: n, sampleRate: p.sampleRate, channels: p.channels.length,
    rmsDbfs: p.rmsDbfs, bandsRelativeDb, tonalPeaks: peaks.slice(0, 8),
    character: peaks.length ? `Noise with tonal components at ${peaks.slice(0, 4).map((x) => x.hz + ' Hz').join(', ')}` : 'Broadband noise (no strong tones)',
  };
}

export function serializeProfile(p) {
  return { ...p, channels: p.channels.map((c) => Array.from(c, (v) => +v.toPrecision(6))) };
}
export function deserializeProfile(j) {
  return { ...j, channels: j.channels.map((c) => Float64Array.from(c)) };
}

// Map a profile onto a (possibly different) FFT size by interpolating per Hz.
function profileFor(profile, chIndex, n, sr) {
  const src = profile.channels.length === 1 ? profile.channels[0]
    : chIndex < profile.channels.length ? profile.channels[chIndex]
      : profile.channels.reduce((acc, c) => acc.map((v, k) => v + c[k] / profile.channels.length), new Float64Array(profile.channels[0].length));
  const m = n >> 1;
  if (profile.fftSize === n && profile.sampleRate === sr) return src;
  // Power per bin scales with Σw² (∝ n); rescale and resample by frequency.
  const scale = n / profile.fftSize, srcBinHz = profile.sampleRate / profile.fftSize, out = new Float64Array(m + 1);
  for (let k = 0; k <= m; k++) {
    const pos = Math.min(src.length - 1, (k * sr / n) / srcBinHz), i = Math.floor(pos), f = pos - i;
    out[k] = (src[i] * (1 - f) + src[Math.min(src.length - 1, i + 1)] * f) * scale;
  }
  return out;
}

// ── noise reduction with a print ─────────────────────────────────────────
// Wiener gain with a decision-directed a-priori SNR estimate (Ephraim–Malah),
// an over-subtraction factor from `sensitivity`, a hard floor at -reductionDb,
// frequency smoothing of the gain mask and a release smoother over time. The
// decision-directed estimate and the floor are what keep "musical noise" away.
//   reductionDb  0–60 (default 18): how far noise is pushed down.
//   sensitivity  0–10 (default 5): over-subtraction; each step ≈ +1 dB of
//                threshold above the print. Higher removes more, risks dulling.
//   smoothing    0–1 (default 0.5): mask smoothing in time and frequency.
export function reduceNoise(channels, sr, profile, { reductionDb = 18, sensitivity = 5, smoothing = 0.5 } = {}) {
  const n = fftSizeFor(sr), m = n >> 1;
  const alpha = 2 * Math.pow(10, (sensitivity - 5) / 10);
  const gMin = Math.pow(10, -reductionDb / 20);
  const beta = 0.9 + 0.09 * smoothing;            // DD smoothing
  const release = 0.6 * smoothing;               // gain may rise at once, falls smoothed
  const fw = Math.round(1 + 3 * smoothing);       // ±bins of frequency smoothing
  let processed = 0;
  channels.forEach((x, ci) => {
    const P = profileFor(profile, ci, n, sr);
    const Pn = Float64Array.from(P, (v) => Math.max(1e-20, v * alpha));
    const prevA2 = new Float64Array(m + 1), prevG = new Float64Array(m + 1).fill(1);
    const G = new Float64Array(m + 1), Gs = new Float64Array(m + 1), conf = new Float64Array(m + 1);
    let first = true;
    processed += stftProcess(x, {
      n,
      onFrame: (re, im) => {
        for (let k = 0; k <= m; k++) {
          const y2 = re[k] * re[k] + im[k] * im[k];
          const gamma = y2 / Pn[k];
          const ml = Math.max(gamma - 1, 0);
          const xi = first ? ml : beta * (prevA2[k] / Pn[k]) + (1 - beta) * ml;
          const g = xi / (1 + xi);
          G[k] = g;
          prevA2[k] = g * g * y2;
          // Confidence that this bin is clearly signal (a-posteriori SNR 8–14 dB):
          // such bins keep their own gain so smoothing never dulls real peaks.
          conf[k] = Math.min(1, Math.max(0, (10 * Math.log10(gamma + 1e-20) - 8) / 6));
        }
        first = false;
        // Frequency smoothing (triangular kernel), then release over time.
        for (let k = 0; k <= m; k++) {
          let s = 0, ws = 0;
          for (let d = -fw; d <= fw; d++) {
            const j = k + d;
            if (j < 0 || j > m) continue;
            const wv = fw + 1 - Math.abs(d);
            s += G[j] * wv; ws += wv;
          }
          let g = s / ws;
          const own = G[k] * conf[k];
          if (own > g) g = own;
          if (g < prevG[k]) g = release * prevG[k] + (1 - release) * g;
          prevG[k] = g;
          Gs[k] = g < gMin ? gMin : g;
        }
        for (let k = 0; k <= m; k++) { re[k] *= Gs[k]; im[k] *= Gs[k]; }
      },
    });
  });
  return { framesProcessed: processed, fftSize: n, overSubtraction: round2(alpha) };
}

// ── spectrogram picture ─────────────────────────────────────────────────
// Exact pixel mapping (edges):
//   column x covers source time [start + x·(end−start)/width, start + (x+1)·(end−start)/width)
//   row y (0 = top) covers frequency [maxHz·(minHz/maxHz)^((y+1)/height), maxHz·(minHz/maxHz)^(y/height))
// Each column averages the power of up to 6 STFT frames spread over its time
// span (so short clicks still show up when zoomed out) and over all channels.
// readFrames(fromFrame, count) → Float32Array[] (zero padded outside the file).
const INFERNO = [[0, 0, 0, 4], [0.13, 27, 12, 65], [0.25, 74, 12, 107], [0.38, 120, 28, 109], [0.5, 165, 44, 96], [0.63, 207, 68, 70], [0.75, 237, 105, 37], [0.88, 251, 155, 6], [1, 252, 255, 164]];
const LUT = (() => {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    let j = 0;
    while (j < INFERNO.length - 2 && v > INFERNO[j + 1][0]) j++;
    const [p0, r0, g0, b0] = INFERNO[j], [p1, r1, g1, b1] = INFERNO[j + 1];
    const f = (v - p0) / (p1 - p0);
    lut[i * 3] = Math.round(r0 + (r1 - r0) * f); lut[i * 3 + 1] = Math.round(g0 + (g1 - g0) * f); lut[i * 3 + 2] = Math.round(b0 + (b1 - b0) * f);
  }
  return lut;
})();

export function renderSpectrogram(readFrames, sr, totalFrames, { start, end, width, height, minHz, maxHz, minDb = -110, maxDb = -10 }) {
  const n = sr > 64000 ? 8192 : 4096, m = n >> 1, h = n >> 2, w = hann(n), fft = getFFT(n), binHz = sr / n;
  const buf = new Float64Array(n), re = new Float64Array(m + 1), im = new Float64Array(m + 1), pw = new Float64Array(m + 1);
  // Row → bin ranges.
  const rows = [];
  const ratio = minHz / maxHz;
  for (let y = 0; y < height; y++) {
    const fHi = maxHz * Math.pow(ratio, y / height), fLo = maxHz * Math.pow(ratio, (y + 1) / height);
    const bLo = fLo / binHz, bHi = fHi / binHz;
    if (bHi - bLo < 1.5) {
      const c = Math.sqrt(fLo * fHi) / binHz, i = Math.min(m - 1, Math.floor(c));
      rows.push({ interp: true, i, f: Math.min(1, c - i) });
    } else rows.push({ interp: false, lo: Math.max(0, Math.ceil(bLo)), hi: Math.min(m, Math.floor(bHi)) });
  }
  const ref = 20 * Math.log10(n / 4); // full-scale sine peak bin
  const img = Buffer.alloc(height * (1 + width * 3));
  const dt = (end - start) / width;
  for (let x = 0; x < width; x++) {
    const span = dt * sr;
    const K = Math.max(1, Math.min(6, Math.ceil(span / h)));
    const centers = Array.from({ length: K }, (_, j) => Math.round((start + (x + (j + 0.5) / K) * dt) * sr));
    const from = centers[0] - n / 2, count = centers[K - 1] - centers[0] + n;
    const chans = readFrames(from, count);
    pw.fill(0);
    for (const c of centers) {
      for (const ch of chans) {
        const off = c - n / 2 - from;
        for (let i = 0; i < n; i++) buf[i] = ch[off + i] * w[i];
        fft.forward(buf, re, im);
        for (let k = 0; k <= m; k++) pw[k] += re[k] * re[k] + im[k] * im[k];
      }
    }
    const norm = 1 / (K * chans.length);
    for (let y = 0; y < height; y++) {
      const r = rows[y];
      let p;
      if (r.interp) p = pw[r.i] * (1 - r.f) + pw[r.i + 1] * r.f;
      else { p = 0; for (let k = r.lo; k <= r.hi; k++) p += pw[k]; p /= Math.max(1, r.hi - r.lo + 1); }
      const dbv = 10 * Math.log10(p * norm + 1e-30) - ref;
      const v = Math.max(0, Math.min(1, (dbv - minDb) / (maxDb - minDb)));
      const li = Math.round(Math.pow(v, 1.15) * 255) * 3;
      const o = y * (1 + width * 3) + 1 + x * 3;
      img[o] = LUT[li]; img[o + 1] = LUT[li + 1]; img[o + 2] = LUT[li + 2];
    }
  }
  return encodePng(img, width, height);
}

// ── minimal PNG (RGB8, filter 0 per row; rows already prefixed) ──────────
const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePng(raw, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}
