// Lossless capture: raw float samples from an AudioWorklet, saved as 32-bit WAV.
// Also: input monitoring and round-trip latency calibration with a loopback.
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.first = true; }
  process(inputs) {
    const ch = inputs[0];
    if (ch && ch.length) {
      if (this.first) { this.port.postMessage({ t: currentTime }); this.first = false; }
      this.port.postMessage(ch.map((c) => c.slice()));
    }
    return true;
  }
}
registerProcessor('klang-tap', Tap);`;

const SETTINGS_KEY = 'klang.audio';
export function audioSettings() {
  try { return { channels: 1, monitor: false, punch: true, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}) }; } catch { return { channels: 1, monitor: false, punch: true }; }
}
export function saveAudioSettings(s) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {} }

// A measured round trip belongs to one input/output pair: switching from the interface to
// Bluetooth headphones must not reuse the old number.
export const deviceKey = (s) => `${s.inputId || 'default'}|${s.outputId || 'default'}`;
export function measuredLatency(s) {
  const v = s.latencies?.[deviceKey(s)];
  if (typeof v === 'number') return v;
  // Older settings had one global value; it was measured on the default devices.
  if (typeof s.latency === 'number' && !s.inputId && !s.outputId) return s.latency;
  return undefined;
}
export function withMeasuredLatency(s, v) { return { ...s, latencies: { ...(s.latencies || {}), [deviceKey(s)]: v } }; }

// Best guess without a measurement: what the browser reports for output AND input.
// (Chrome reports input latency per track; the old estimate left it out, so takes landed late.)
export function estimateLatency(ctx, track) {
  const out = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
  let inp = 0;
  try { const l = track?.getSettings?.().latency; if (typeof l === 'number' && l >= 0 && l < 1) inp = l; } catch {}
  return { out, inp, total: out + inp };
}

async function ensureTap(player) {
  const ctx = player.ensureContext();
  if (ctx.state === 'suspended') await ctx.resume();
  if (!player.tapReady) {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    player.tapReady = true;
  }
  return ctx;
}

async function openInput(settings) {
  return navigator.mediaDevices.getUserMedia({ audio: {
    ...(settings.inputId ? { deviceId: { exact: settings.inputId } } : {}),
    echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: settings.channels || 1,
  } });
}

export class Recorder {
  constructor(player, settings = audioSettings()) { this.player = player; this.settings = settings; this.chunks = []; }

  async start() {
    const ctx = await ensureTap(this.player);
    this.stream = await openInput(this.settings);
    this.estimate = estimateLatency(ctx, this.stream.getAudioTracks()[0]);
    this.src = ctx.createMediaStreamSource(this.stream);
    const nch = Math.max(1, Math.min(2, this.settings.channels || 1));
    this.node = new AudioWorkletNode(ctx, 'klang-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: nch, channelCountMode: 'explicit' });
    this.node.port.onmessage = (e) => { if (e.data.t !== undefined) this.firstTime = e.data.t; else this.chunks.push(e.data); };
    this.src.connect(this.node);
    if (this.settings.monitor) {
      this.mon = ctx.createGain();
      this.src.connect(this.mon); this.mon.connect(ctx.destination);
    }
  }

  async stop() {
    const ctx = this.player.ctx;
    await new Promise((r) => setTimeout(r, 120));
    this.src.disconnect(); this.mon?.disconnect(); this.node.port.onmessage = null;
    this.stream.getTracks().forEach((t) => t.stop());
    const nch = Math.max(1, ...this.chunks.map((c) => c.length));
    const frames = this.chunks.reduce((n, c) => n + c[0].length, 0);
    const data = new Float32Array(frames * nch);
    let k = 0;
    for (const c of this.chunks) for (let i = 0; i < c[0].length; i++) for (let ch = 0; ch < nch; ch++) data[k++] = (c[ch] || c[0])[i];
    // Where the take lines up with the timeline: time between capture start and playback
    // start, plus the round trip through output and input (measured if calibrated).
    const measured = measuredLatency(this.settings);
    const roundTrip = measured ?? this.estimate.total;
    const nudge = (this.settings.nudgeMs || 0) / 1000;
    const latency = Math.max(0, (this.player.startTime - (this.firstTime ?? 0)) + roundTrip + nudge);
    return { blob: wav(data, nch, ctx.sampleRate), latency, sampleRate: ctx.sampleRate, compensation: { source: measured !== undefined ? 'measured' : 'estimated', roundTripMs: roundTrip * 1000, nudgeMs: nudge * 1000 } };
  }
}

/**
 * Round-trip latency with a loopback (speakers into the mic, or a cable from output to
 * input). Plays eight short noise bursts and finds each one in the recording by
 * cross-correlation, with sub-sample interpolation. Much more robust than a level
 * threshold: works at low volume, with room noise and with soft, smeared clicks.
 * Returns { latency (s), spreadMs, hits, confidence }.
 */
export function findBurst(sig, burst, from, to) {
  const n = burst.length;
  let e = 0; for (let k = 0; k < n; k++) e += burst[k] * burst[k];
  let best = -1, bestI = -1;
  const score = new Float32Array(Math.max(0, to - from));
  for (let i = from; i < to && i + n <= sig.length; i++) {
    let c = 0, w = 0;
    for (let k = 0; k < n; k++) { const x = sig[i + k]; c += x * burst[k]; w += x * x; }
    const v = w > 0 ? (c * c) / (w * e) : 0; // normalised correlation², 0…1, sign-safe for inverted wiring
    score[i - from] = v;
    if (v > best) { best = v; bestI = i; }
  }
  if (bestI < 0) return null;
  // parabolic interpolation around the peak for sub-sample precision
  const j = bestI - from, a = score[j - 1] ?? best, b = best, c = score[j + 1] ?? best;
  const den = a - 2 * b + c, frac = den ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
  return { index: bestI + frac, score: best };
}

export async function calibrateLatency(player, settings = audioSettings()) {
  const ctx = await ensureTap(player);
  const stream = await openInput({ ...settings, channels: 1 });
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'klang-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
  const chunks = []; let first;
  node.port.onmessage = (e) => { if (e.data.t !== undefined) first = e.data.t; else chunks.push(e.data[0]); };
  src.connect(node);
  await new Promise((r) => setTimeout(r, 300));
  const sr = ctx.sampleRate, N = Math.round(sr * 0.012); // 12 ms burst
  let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const burst = Float32Array.from({ length: N }, (_, i) => rnd() * Math.sin((Math.PI * i) / N) ** 2 * 0.8);
  const buf = ctx.createBuffer(1, N, sr); buf.getChannelData(0).set(burst);
  const COUNT = 8, spacing = 0.3, t0 = ctx.currentTime + 0.25, times = [];
  for (let i = 0; i < COUNT; i++) { const s = ctx.createBufferSource(); s.buffer = buf; s.connect(ctx.destination); const t = t0 + i * spacing; s.start(t); times.push(t); }
  await new Promise((r) => setTimeout(r, (0.25 + COUNT * spacing + 0.5) * 1000));
  src.disconnect(); node.port.onmessage = null; stream.getTracks().forEach((t) => t.stop());
  const sig = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0; for (const c of chunks) { sig.set(c, o); o += c.length; }
  const delays = [], scores = [];
  for (const t of times) {
    const from = Math.max(0, Math.floor((t - first) * sr)), to = Math.min(sig.length - N, from + Math.floor(spacing * sr * 0.9));
    const hit = findBurst(sig, burst, from, to);
    if (hit && hit.score > 0.06) { delays.push(hit.index / sr - (t - first)); scores.push(hit.score); }
  }
  if (delays.length < 5) throw new Error('Could not hear the test sounds clearly. Turn the speakers up a bit near the mic (or connect output to input), keep the room quiet, and try again.');
  delays.sort((a, b) => a - b);
  // drop the outer quarter on each side, then average the rest
  const cut = Math.floor(delays.length / 4), core = delays.slice(cut, delays.length - cut);
  const latency = core.reduce((a, b) => a + b, 0) / core.length;
  const spreadMs = (core[core.length - 1] - core[0]) * 1000;
  const confidence = scores.reduce((a, b) => a + b, 0) / scores.length;
  return { latency, spreadMs, hits: delays.length, of: COUNT, confidence };
}

function wav(interleaved, nch, sr) {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + interleaved.byteLength, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, nch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * nch * 4, true); v.setUint16(32, nch * 4, true); v.setUint16(34, 32, true);
  w(36, 'data'); v.setUint32(40, interleaved.byteLength, true);
  return new Blob([header, interleaved.buffer], { type: 'audio/wav' });
}
