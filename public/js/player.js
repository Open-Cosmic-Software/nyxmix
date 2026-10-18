// Browser playback through the shared graph, with live parameter updates and meters.
import { buildProjectGraph, structureKey, projectEnd, loadWorklets } from './engine/graph.js';
import { loadPluginModules } from './engine/plugins.js';
import { getToken } from './api.js';
import { api } from './api.js';

export class Player extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.buffers = new Map();
    this.loading = new Map();
    this.graph = null;
    this.playing = false;
    this.startPos = 0;
    this.startTime = 0;
    this.pos = 0;
    this.loop = { on: false, start: 0, end: 0 };
    this.project = null;
    this.pid = null;
    this.key = '';
    this.trackMeters = new Map();
    this.token = 0;
  }

  ensureContext() {
    const sr = this.project?.sampleRate || 48000;
    if (this.ctx && this.ctx.sampleRate !== sr) { this.ctx.close(); this.ctx = null; this.buffers.clear(); this.loading.clear(); }
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: sr, latencyHint: 'interactive' });
      this.loudnessNode = null;
      this.bus = this.ctx.createGain();
      const split = this.ctx.createChannelSplitter(2);
      this.meterL = this.ctx.createAnalyser(); this.meterR = this.ctx.createAnalyser();
      this.meterL.fftSize = this.meterR.fftSize = 2048;
      // Meters and the loudness meter see the stereo fold-down (matters for 5.1 sessions).
      this.fold = this.ctx.createGain();
      this.fold.channelCount = 2; this.fold.channelCountMode = 'explicit'; this.fold.channelInterpretation = 'speakers';
      this.bus.connect(this.fold);
      this.fold.connect(split); split.connect(this.meterL, 0); split.connect(this.meterR, 1);
      this.bus.connect(this.ctx.destination);
      this.scratch = new Float32Array(2048);
    }
    return this.ctx;
  }

  setProject(project, pid) {
    const prevPid = this.pid;
    this.project = project; this.pid = pid;
    if (prevPid && prevPid !== pid) { this.stop(); this.buffers.clear(); this.loading.clear(); }
    const k = structureKey(project);
    if (this.playing && this.graph) {
      if (k !== this.key) this.restart();
      else this.graph.update(project);
    }
    this.key = k;
  }

  // Assets longer than this stream during playback instead of being decoded into RAM.
  static STREAM_SECONDS = 20 * 60;
  isStreamed(assetId) { return (this.project?.assets.find((a) => a.id === assetId)?.duration || 0) > Player.STREAM_SECONDS; }

  // A media-element source that starts playing `offset` seconds into the asset at ctx time `at`.
  streamSource(clip, { at, offset, duration }) {
    const ctx = this.ctx;
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.src = api.audioUrl(this.pid, clip.assetId);
    el.currentTime = offset;
    const node = ctx.createMediaElementSource(el);
    const delay = Math.max(0, (at - ctx.currentTime) * 1000);
    const startTimer = setTimeout(() => el.play().catch(() => {}), delay);
    const stopTimer = setTimeout(() => el.pause(), delay + duration * 1000);
    node.stop = () => { clearTimeout(startTimer); clearTimeout(stopTimer); el.pause(); el.removeAttribute('src'); el.load(); };
    return node;
  }

  loadAsset(assetId) {
    if (this.isStreamed(assetId)) return Promise.resolve(null);
    if (this.buffers.has(assetId)) return Promise.resolve(this.buffers.get(assetId));
    if (this.loading.has(assetId)) return this.loading.get(assetId);
    const ctx = this.ensureContext();
    const p = api.audio(this.pid, assetId)
      .then((ab) => ctx.decodeAudioData(ab))
      .then((buf) => { this.buffers.set(assetId, buf); this.loading.delete(assetId); this.dispatchEvent(new Event('buffer')); return buf; })
      .catch((e) => { this.loading.delete(assetId); throw e; });
    this.loading.set(assetId, p);
    return p;
  }

  async preload() {
    const ids = new Set();
    for (const t of this.project.tracks) for (const c of t.clips) ids.add(c.assetId);
    for (const list of [this.project.master?.effects || [], ...this.project.tracks.map((t) => t.effects || [])]) for (const e of list) if (e.type === 'convolution' && e.params?.ir) ids.add(e.params.ir);
    await Promise.all([...ids].map((id) => this.loadAsset(id).catch(() => null)));
  }

  get position() {
    if (!this.playing) return this.pos;
    return this.startPos + (this.ctx.currentTime - this.startTime) * (this.speed || 1);
  }

  async play(from = this.pos) {
    // Every play/pause/stop bumps the token: a play() still waiting for audio to load
    // must not start playback after the user paused (or a newer play() took over).
    const token = ++this.token;
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') await ctx.resume();
    await Promise.all([this.preload(), loadWorklets(ctx, '/js/engine/dsp-worklet.js'), loadPluginModules(ctx, this.project, (id) => `/api/plugins/${id}.js${getToken() ? `?token=${encodeURIComponent(getToken())}` : ''}`)]);
    if (token !== this.token || ctx !== this.ctx) return;
    if (!this.loudnessNode) {
      this.loudnessNode = new AudioWorkletNode(ctx, 'klang-meter', { numberOfInputs: 1, numberOfOutputs: 0 });
      this.loudnessNode.port.onmessage = (e) => { this.loudness = e.data; };
      this.fold.connect(this.loudnessNode);
    }
    if (Math.abs(from - this.position) > 0.05 || !this.loudness) { this.loudnessNode.port.postMessage('reset'); this.loudness = null; }
    this.stopGraph();
    if (this.loop.on && this.loop.end > this.loop.start && (from < this.loop.start || from >= this.loop.end)) from = this.loop.start;
    const to = this.loop.on && this.loop.end > this.loop.start ? this.loop.end : Infinity;
    this.startPos = from;
    this.startTime = ctx.currentTime + 0.04;
    this.trackMeters.clear();
    this.graph = buildProjectGraph(ctx, this.project, this.buffers, {
      from, to, when: this.startTime, destination: this.bus, speed: this.speed || 1,
      streamSource: (clip, o) => (this.isStreamed(clip.assetId) ? this.streamSource(clip, o) : null),
      onTrack: (id, node) => {
        const a = ctx.createAnalyser(); a.fftSize = 1024;
        node.connect(a); this.trackMeters.set(id, a);
      },
    });
    this.key = structureKey(this.project);
    this.playing = true;
    this.dispatchEvent(new Event('state'));
    this.tick(token);
  }

  tick(token) {
    if (!this.playing || token !== this.token) return; // one animation loop per playback
    const p = this.position;
    if (this.loop.on && this.loop.end > this.loop.start && p >= this.loop.end) { this.play(this.loop.start); return; }
    if (!this.loop.on && !this.holdOpen && p > projectEnd(this.project) + 0.5) { this.pause(); this.pos = projectEnd(this.project); }
    requestAnimationFrame(() => this.tick(token));
  }

  restart() { if (this.playing) this.play(this.position); }

  stopGraph() { if (this.graph) { this.graph.stop(); this.graph = null; } }

  pause() {
    this.token++;
    if (!this.playing) return;
    this.pos = this.position;
    this.playing = false;
    this.stopGraph();
    this.dispatchEvent(new Event('state'));
  }

  stop() {
    this.token++;
    this.playing = false;
    this.stopGraph();
    this.pos = this.loop.on ? this.loop.start : 0;
    this.dispatchEvent(new Event('state'));
  }

  seek(t) {
    t = Math.max(0, t);
    if (this.playing) this.play(t); else { this.pos = t; this.dispatchEvent(new Event('state')); }
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  level(analyser) {
    if (!analyser) return { peak: 0, rms: 0 };
    const buf = this.scratch.length >= analyser.fftSize ? this.scratch.subarray(0, analyser.fftSize) : new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let peak = 0, sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > peak) peak = v; sum += v * v; }
    return { peak, rms: Math.sqrt(sum / buf.length) };
  }
  masterLevels() {
    if (!this.ctx || !this.playing) return null;
    return [this.level(this.meterL), this.level(this.meterR)];
  }
  trackLevel(id) { return this.playing ? this.level(this.trackMeters.get(id)) : null; }
}
