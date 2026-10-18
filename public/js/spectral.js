// Spectral editor for the selected clip: NyxMix's own STFT spectrogram (log
// frequency) with four region tools (box, lasso, brush, spot heal), attenuate /
// heal, a pitch overlay, manual pitch correction (pitch tool: a cents curve on
// top of the detected pitch) and noise-print noise reduction. Regions are kept
// in source seconds + Hz, exactly what the API takes.
import { el, fmtTime, clamp, modal, toast } from './ui.js';
import { getToken, actor } from './api.js';

const MIN_HZ = 30;
const FREQ_TICKS = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const TIME_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];

const fmtHz = (f) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)} kHz` : `${Math.round(f)} Hz`);
const tickHz = (f) => (f >= 1000 ? `${f / 1000}k` : String(f));
const TOOLS = [
  { id: 'box', label: 'Box', key: 'B', hint: 'Drag a time and frequency rectangle' },
  { id: 'lasso', label: 'Lasso', key: 'L', hint: 'Draw a freehand outline; it closes when you let go' },
  { id: 'brush', label: 'Brush', key: 'P', hint: 'Paint a region; hold Shift to erase' },
  { id: 'spot', label: 'Spot heal', key: 'H', hint: 'Paint over a click or noise; it is healed when you let go' },
  { id: 'pitch', label: 'Pitch', key: 'T', hint: 'Drag the pitch curve up or down to correct it; Shift = fine' },
];
const TOOL_KEYS = { b: 'box', l: 'lasso', p: 'brush', h: 'spot', t: 'pitch' };
const PC_RAMP = 0.03;          // s, cross-fade of a correction into and out of a voiced span
const PC_MIN_RUN = 0.08;       // s, shortest note the snap keeps on its own
const fmtCents = (c) => `${c > 0 ? '+' : c < 0 ? '−' : '±'}${Math.abs(Math.round(c))} cent${Math.abs(Math.round(c)) === 1 ? '' : 's'}`;
const voiced = (fr) => fr[1] !== null && fr[2] >= 0.5;
// Mean without the outer 10 % on each side: the centre of a note with vibrato
// (over a partial vibrato cycle a median jumps towards a peak, a mean does not)
// that ignores glitches.
const centre = (a) => { const s = [...a].sort((x, y) => x - y), k = Math.floor(s.length * 0.1), m = s.slice(k, s.length - k); return m.length ? m.reduce((x, y) => x + y, 0) / m.length : 0; };

// Correction curve helpers. A curve is [{ time, cents }] sorted by time, linear
// in between and 0 outside (the server's semantics).
export function curveAt(pts, t) {
  if (!pts.length || t < pts[0].time || t > pts[pts.length - 1].time) return 0;
  let i = 0;
  while (pts[i].time < t) i++;
  if (pts[i].time === t) return pts[i].cents;
  const a = pts[i - 1], b = pts[i];
  return a.cents + ((t - a.time) / (b.time - a.time)) * (b.cents - a.cents);
}
// Adds a trapezoid of `cents` over [t0, t1] (ramps centred on the edges) to a
// curve; both are piecewise linear, so evaluating at the union of breakpoints is exact.
export function addBump(pts, t0, t1, cents, ramp = PC_RAMP) {
  if (!cents || !(t1 > t0)) return pts;
  const r = Math.min(ramp, t1 - t0) / 2;
  const bump = [{ time: t0 - r, cents: 0 }, { time: t0 + r, cents }, { time: t1 - r, cents }, { time: t1 + r, cents: 0 }];
  const times = [...new Set([...pts.map((p) => p.time), ...bump.map((p) => p.time)])].sort((a, b) => a - b);
  return simplifyCurve(times.map((time) => ({ time, cents: clamp(curveAt(pts, time) + curveAt(bump, time), -1200, 1200) })));
}
// Drops points that a straight line through their neighbours already gives, and zero padding.
export function simplifyCurve(pts) {
  let out = pts.filter((p, i) => {
    if (i === 0 || i === pts.length - 1) return true;
    const a = pts[i - 1], b = pts[i + 1];
    const lin = b.time === a.time ? a.cents : a.cents + ((p.time - a.time) / (b.time - a.time)) * (b.cents - a.cents);
    return Math.abs(lin - p.cents) > 0.05;
  });
  while (out.length > 1 && Math.abs(out[0].cents) < 0.05 && Math.abs(out[1].cents) < 0.05) out.shift();
  while (out.length > 1 && Math.abs(out.at(-1).cents) < 0.05 && Math.abs(out.at(-2).cents) < 0.05) out.pop();
  if (out.every((p) => Math.abs(p.cents) < 0.05)) out = [];
  return out;
}
const AMBER = '92,200,240';
const PITCH_KEY = 'klang.spectral.pitch';
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
const fmtDb = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v))} dB`;

async function request(method, url, body) {
  const headers = { 'X-Actor': actor() };
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw Object.assign(new Error(j.error?.message || res.statusText), { status: res.status, code: j.error?.code });
  }
  return res;
}

export class SpectralView {
  constructor(app) {
    this.app = app;
    this.label = 'Spectral view';
    this.gainDb = -20;
    this.sel = null;          // box: { t0, t1, f0, f1 } source seconds / Hz
    this.lasso = null;        // lasso: [[t, hz], …] closed outline
    this.strokes = [];        // brush: [{ points: [[t, hz], …], radiusMs, radiusSemitones, erase }]
    this.draft = null;        // stroke or outline being drawn right now
    this.tool = 'box';
    this.brushPx = 12;        // brush radius on screen
    this.showPitch = store.get(PITCH_KEY) === '1';
    this.pitch = null;        // { key, track } for the visible window
    this.busy = null;         // label while a job runs
    this.print = undefined;   // noise print summary (null = none)
    this.denoise = { reductionDb: 18, sensitivity: 5, smoothing: 0.5 };
    this.pc = [];             // pitch correction curve: [{ time (source s), cents }]
    this.pcPreview = null;    // curve while a drag is in progress
    this.pcSpan = null;       // { t0, t1 } source seconds: the span Snap works on
    this.pcDrag = null;       // { runs, cents } of the drag in progress
  }

  // ── geometry ──────────────────────────────────────────────────────────
  get nyq() { return (this.app.project?.sampleRate || 48000) / 2; }
  get src() { const c = this.clip; return { s0: c.offset, s1: c.offset + c.duration }; }
  xToSrc(x) { const { s0, s1 } = this.src; return s0 + (x / this.W) * (s1 - s0); }
  srcToX(t) { const { s0, s1 } = this.src; return ((t - s0) / (s1 - s0)) * this.W; }
  yToHz(y) { return this.nyq * Math.pow(MIN_HZ / this.nyq, y / this.H); }
  hzToY(f) { return f <= MIN_HZ ? this.H : (this.H * Math.log(f / this.nyq)) / Math.log(MIN_HZ / this.nyq); }
  srcToTimeline(t) { return this.clip.start + (t - this.clip.offset); }
  ptToSrc(x, y) { return [this.xToSrc(x), y >= this.H - 0.5 ? 0 : this.yToHz(y)]; }
  // Brush radius in API units for the current zoom (a circle on screen).
  brushRadius() {
    const { s0, s1 } = this.src;
    return { radiusMs: Math.max(1, (this.brushPx / this.W) * (s1 - s0) * 1000), radiusSemitones: (this.brushPx / this.H) * 12 * Math.log2(this.nyq / MIN_HZ) };
  }
  // Screen radii (x, y) of a stroke's brush.
  strokeRadiusPx(st) {
    const { s0, s1 } = this.src;
    return [(st.radiusMs / 1000 / (s1 - s0)) * this.W, (st.radiusSemitones / (12 * Math.log2(this.nyq / MIN_HZ))) * this.H];
  }

  // ── DOM (built once, reused on every render) ──────────────────────────
  build() {
    const btn = (label, onclick, extra = {}) => el('button', { class: 'btn', type: 'button', onclick, ...extra }, label);
    this.info = el('span', { class: 'muted small sp-info' });
    this.printLine = el('span', { class: 'small sp-print', 'aria-live': 'polite' });
    this.img = el('img', { class: 'sp-img', alt: '' });
    this.canvas = el('canvas', { class: 'sp-overlay', tabindex: '0', role: 'img', 'aria-label': 'Spectrogram. Select a region with the box, lasso or brush tool (keys B, L, P), or spot heal with H. T is the pitch tool: drag the pitch curve up or down, or select a span on the time axis and use the arrow keys (Shift = 1 cent). Click to move the playhead, Escape clears the region, Delete turns it down fully.' });
    this.mask = document.createElement('canvas');
    this.loading = el('div', { class: 'sp-loading muted small' }, 'Rendering spectrogram…');
    this.view = el('div', { class: 'sp-view' }, [this.img, this.canvas, this.loading]);
    this.faxis = el('div', { class: 'sp-faxis', title: 'Drag to select a frequency band across the whole clip' });
    this.taxis = el('div', { class: 'sp-taxis', title: 'Drag to select a time span across all frequencies' });
    this.readout = el('span', { class: 'sp-readout' });
    this.cursor = el('span', { class: 'sp-cursor muted small' });
    this.attBtn = btn('', () => this.edit('attenuate'), { title: 'Turn the selected region down by the chosen amount' });
    this.healBtn = btn('Heal', () => this.edit('heal'), { title: 'Rebuild the selected region from the audio around it (coughs, clicks, rings)' });
    this.learnBtn = btn('Learn noise print', () => this.learn(), { title: 'Capture the noise in the selected time span (room tone only)' });
    this.reduceBtn = btn('Reduce noise…', () => this.reduceDialog(), { title: 'Remove the learned noise from the whole clip source' });
    this.repairBtn = el('button', { class: 'chip', type: 'button', onclick: () => this.app.processDialog(this.clip.assetId) }, 'Repair…');
    this.gainSlider = this.app.slider({
      label: 'Gain', min: -60, max: 0, step: 1, value: this.gainDb, reset: -20, fmt: fmtDb,
      onlive: (v) => { this.gainDb = v; this.updateButtons(); },
      oncommit: (v) => { this.gainDb = v; this.updateButtons(); },
    });
    this.gainSlider.classList.add('sp-gain');
    this.toolBtns = Object.fromEntries(TOOLS.map((t) => [t.id, el('button', { class: 'sp-tool', type: 'button', 'aria-pressed': 'false', title: `${t.hint} (${t.key})`, onclick: () => this.setTool(t.id) }, [t.label, el('kbd', {}, t.key)])]));
    this.toolBar = el('div', { class: 'sp-toolbar', role: 'group', 'aria-label': 'Selection tool' }, Object.values(this.toolBtns));
    this.sizeSlider = this.app.slider({
      label: 'Size', min: 3, max: 60, step: 1, value: this.brushPx, reset: 12, fmt: (v) => `${Math.round(v)} px`,
      onlive: (v) => { this.brushPx = v; this.dirty = true; }, oncommit: (v) => { this.brushPx = v; this.dirty = true; },
    });
    this.sizeSlider.classList.add('sp-size');
    this.pitchBtn = el('button', { class: 'chip sp-pitch-btn' + (this.showPitch ? ' on' : ''), type: 'button', 'aria-pressed': String(this.showPitch), title: 'Show the pitch (fundamental frequency) of the clip as a curve', onclick: () => this.togglePitch() }, 'Pitch');
    this.pcMax = el('span', { class: 'small sp-pc-max', 'aria-live': 'polite' });
    this.pcSnapBtn = btn('Snap to nearest semitone', () => this.pcSnap(), { title: 'Move each voiced note in the selected span (or the whole clip) to the nearest semitone, keeping its vibrato' });
    this.pcResetBtn = btn('Reset', () => this.pcReset(), { title: 'Discard the correction curve' });
    this.pcApplyBtn = btn('Apply pitch curve', () => this.pcApply(), { class: 'btn primary', title: 'Resynthesise the corrected span (formants are kept); clips using this source switch to the result' });
    this.editGroup = el('div', { class: 'sp-group', role: 'group', 'aria-label': 'Spectral edit' }, [this.gainSlider, this.attBtn, this.healBtn]);
    this.noiseGroup = el('div', { class: 'sp-group', role: 'group', 'aria-label': 'Noise reduction' }, [this.learnBtn, this.reduceBtn]);
    this.pcGroup = el('div', { class: 'sp-group sp-pc', role: 'group', 'aria-label': 'Pitch correction', hidden: true }, [this.pcMax, this.pcSnapBtn, this.pcResetBtn, this.pcApplyBtn]);
    this.root = el('div', { class: 'sp' }, [
      el('div', { class: 'sp-bar' }, [this.toolBar, this.sizeSlider, this.info, el('span', { class: 'spacer' }), this.printLine, this.pitchBtn, this.repairBtn]),
      el('div', { class: 'sp-main' }, [this.faxis, this.view, el('div', { class: 'sp-corner muted' }, 'Hz'), this.taxis]),
      el('div', { class: 'sp-tools' }, [
        el('div', { class: 'sp-sel' }, [this.readout, this.cursor]),
        this.editGroup, this.noiseGroup, this.pcGroup,
      ]),
    ]);
    this.bindPointer(this.canvas, 'rect');
    this.bindPointer(this.faxis, 'freq');
    this.bindPointer(this.taxis, 'time');
    this.root.addEventListener('keydown', (e) => this.onKey(e));
    this.canvas.addEventListener('pointermove', (e) => this.hover(e));
    this.canvas.addEventListener('pointerleave', () => { this.cursor.textContent = ''; this.hoverPt = null; this.dirty = true; });
    this.setTool(this.tool);
    new ResizeObserver(() => this.layout()).observe(this.view);
  }

  render(box) {
    const ref = this.app.dockClipRef();
    if (!ref) {
      this.clip = null;
      box.replaceChildren(el('p', { class: 'muted dock-empty' }, 'Select a clip to edit its frequency content: drag a region to turn it down or heal it, or learn a noise print from room tone.'));
      return;
    }
    if (!this.root) this.build();
    if (!box.contains(this.root)) box.replaceChildren(this.root);
    const c = ref.clip;
    if (this.clip?.id !== c.id) { this.sel = null; this.lasso = null; this.strokes = []; this.draft = null; this.maskDirty = true; }
    const assetChanged = this.clip?.assetId !== c.assetId;
    // The correction curve belongs to one source: a new clip or a new asset (e.g. the
    // applied result arriving through live sync) starts from a flat curve.
    if (this.clip?.id !== c.id || assetChanged) { this.pc = []; this.pcPreview = null; this.pcDrag = null; if (this.clip?.id !== c.id) this.pcSpan = null; }
    this.clip = c;
    if (assetChanged) this.loadPrint();
    this.info.textContent = `${c.name} · source ${fmtTime(c.offset, 2)}–${fmtTime(c.offset + c.duration, 2)} · log frequency, brighter = louder`;
    this.layout();
    this.updateButtons();
    this.startLoop();
    if (this.showPitch) this.loadPitch();
  }

  layout() {
    if (!this.clip || !this.view.isConnected) return;
    const r = this.view.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    this.W = r.width; this.H = r.height;
    const dpr = devicePixelRatio || 1;
    const cw = Math.round(this.W * dpr), ch = Math.round(this.H * dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; this.mask.width = cw; this.mask.height = ch; this.maskDirty = true; }
    this.drawAxes();
    this.dirty = true;
    // Spectrogram image for exactly this source window and pixel size.
    const c = this.clip;
    const w = Math.min(4000, cw), h = Math.min(2000, ch);
    const key = `${this.app.pid}:${c.assetId}:${c.offset}:${c.duration}:${w}x${h}:${this.nyq}`;
    if (key === this.imgKey) return;
    clearTimeout(this.fetchTimer);
    this.fetchTimer = setTimeout(() => this.fetchImage(key, w, h), this.imgKey ? 150 : 0);
  }

  async fetchImage(key, w, h) {
    this.imgKey = key;
    const c = this.clip;
    const q = new URLSearchParams({ start: c.offset, end: c.offset + c.duration, width: w, height: h, minHz: MIN_HZ, maxHz: this.nyq });
    this.loading.hidden = false;
    try {
      const res = await request('GET', `/api/projects/${this.app.pid}/assets/${c.assetId}/spectrogram?${q}`);
      const blob = await res.blob();
      if (key !== this.imgKey) return;
      const url = URL.createObjectURL(blob);
      await new Promise((ok) => { this.img.onload = ok; this.img.onerror = ok; this.img.src = url; });
      if (this.imgUrl) URL.revokeObjectURL(this.imgUrl);
      this.imgUrl = url;
      this.img.alt = `Spectrogram of ${c.name}`;
    } catch (e) {
      if (key === this.imgKey) { this.imgKey = null; this.loading.textContent = `Could not render the spectrogram: ${e.message}`; return; }
    }
    if (key === this.imgKey) this.loading.hidden = true;
  }

  drawAxes() {
    const ticks = FREQ_TICKS.filter((f) => f > MIN_HZ * 1.1 && f < this.nyq * 0.95);
    this.faxis.replaceChildren(
      ...ticks.map((f) => el('span', { class: 'sp-ftick', style: `top:${this.hzToY(f).toFixed(1)}px` }, tickHz(f))),
    );
    const dur = this.clip.duration;
    const step = TIME_STEPS.find((s) => (s / dur) * this.W >= 90) || TIME_STEPS[TIME_STEPS.length - 1];
    const t0 = this.clip.start, labels = [];
    const dec = step < 0.1 ? 2 : step < 1 ? 1 : 0;
    for (let t = Math.ceil(t0 / step - 1e-9) * step; t <= t0 + dur + 1e-9; t += step) {
      const x = ((t - t0) / dur) * this.W;
      if (x > this.W - 30) break;
      labels.push(el('span', { class: 'sp-ttick', style: `left:${x.toFixed(1)}px` }, fmtTime(t, dec)));
    }
    this.taxis.replaceChildren(...labels);
    this.ticks = { freq: ticks, time: labels.map((l) => parseFloat(l.style.left)) };
  }

  // ── overlay: grid, selection, playhead ────────────────────────────────
  startLoop() {
    if (this.looping) return;
    this.looping = true;
    const tick = () => {
      if (!this.canvas?.isConnected || !this.clip) { this.looping = false; return; }
      const pos = this.app.player.position;
      if (pos !== this.lastPos || this.dirty) { this.lastPos = pos; this.dirty = false; this.drawOverlay(pos); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  drawOverlay(pos) {
    const g = this.canvas.getContext('2d'), dpr = devicePixelRatio || 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, this.W, this.H);
    g.fillStyle = 'rgba(255,255,255,0.07)';
    for (const f of this.ticks?.freq || []) g.fillRect(0, Math.round(this.hzToY(f)), this.W, 1);
    for (const x of this.ticks?.time || []) g.fillRect(Math.round(x), 0, 1, this.H);
    if (this.showPitch) this.drawPitch(g);
    const s = this.tool === 'box' ? this.sel : null;
    if (s) {
      const x0 = this.srcToX(s.t0), x1 = this.srcToX(s.t1);
      const y0 = clamp(this.hzToY(s.f1), 0, this.H), y1 = clamp(this.hzToY(s.f0), 0, this.H);
      g.fillStyle = 'rgba(12,14,20,0.38)';
      g.fillRect(0, 0, this.W, y0); g.fillRect(0, y1, this.W, this.H - y1);
      g.fillRect(0, y0, x0, y1 - y0); g.fillRect(x1, y0, this.W - x1, y1 - y0);
      g.fillStyle = `rgba(${AMBER},0.10)`;
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
      g.strokeStyle = '#5cc8f0'; g.lineWidth = 1.5;
      g.strokeRect(Math.round(x0) + 0.75, Math.round(y0) + 0.75, Math.max(1, Math.round(x1 - x0) - 1.5), Math.max(1, Math.round(y1 - y0) - 1.5));
    }
    if (this.tool === 'lasso') this.drawLasso(g);
    if (this.tool === 'brush' || this.tool === 'spot') this.drawMask(g);
    const src = this.clip.offset + (pos - this.clip.start);
    if (src >= this.clip.offset && src <= this.clip.offset + this.clip.duration) {
      g.fillStyle = '#f4f1e8';
      g.fillRect(Math.round(this.srcToX(src)) - 0.5, 0, 1.5, this.H);
    }
  }

  drawLasso(g) {
    const pts = this.draft?.outline || this.lasso;
    if (!pts || pts.length < 2) return;
    const path = new Path2D();
    pts.forEach(([t, f], i) => { const x = this.srcToX(t), y = clamp(this.hzToY(f), 0, this.H); i ? path.lineTo(x, y) : path.moveTo(x, y); });
    if (this.lasso && !this.draft) {
      path.closePath();
      const dim = new Path2D();
      dim.rect(0, 0, this.W, this.H); dim.addPath(path);
      g.fillStyle = 'rgba(12,14,20,0.38)'; g.fill(dim, 'evenodd');
      g.fillStyle = `rgba(${AMBER},0.16)`; g.fill(path, 'evenodd');
      g.setLineDash([]);
    } else g.setLineDash([4, 3]);
    g.strokeStyle = '#5cc8f0'; g.lineWidth = 1.5; g.lineJoin = 'round';
    g.stroke(path);
    g.setLineDash([]);
  }

  // Painted strokes are rasterised once into an offscreen canvas (erase =
  // destination-out) and composited as a translucent amber layer.
  renderMask() {
    const m = this.mask, mg = m.getContext('2d'), dpr = devicePixelRatio || 1;
    mg.setTransform(1, 0, 0, 1, 0, 0);
    mg.clearRect(0, 0, m.width, m.height);
    const all = this.draft?.stroke ? [...(this.tool === 'spot' ? [] : this.strokes), this.draft.stroke] : this.tool === 'spot' ? (this.spotPending ? [this.spotPending] : []) : this.strokes;
    for (const st of all) {
      const [rx, ry] = this.strokeRadiusPx(st);
      mg.globalCompositeOperation = st.erase ? 'destination-out' : 'source-over';
      mg.setTransform(dpr * rx, 0, 0, dpr * ry, 0, 0);
      mg.strokeStyle = mg.fillStyle = `rgb(${AMBER})`;
      mg.lineWidth = 2; mg.lineCap = 'round'; mg.lineJoin = 'round';
      const p = st.points.map(([t, f]) => [this.srcToX(t) / rx, clamp(this.hzToY(f), 0, this.H) / ry]);
      mg.beginPath();
      if (p.length === 1) { mg.arc(p[0][0], p[0][1], 1, 0, Math.PI * 2); mg.fill(); continue; }
      p.forEach(([x, y], i) => (i ? mg.lineTo(x, y) : mg.moveTo(x, y)));
      mg.stroke();
    }
    mg.globalCompositeOperation = 'source-over';
    this.maskDirty = false;
  }

  drawMask(g) {
    if (this.maskDirty) this.renderMask();
    g.save();
    g.globalAlpha = 0.42;
    g.drawImage(this.mask, 0, 0, this.W, this.H);
    g.restore();
    const hp = this.hoverPt;
    if (hp && !this.busy) {
      g.beginPath();
      g.ellipse(hp.x, hp.y, this.brushPx, this.brushPx, 0, 0, Math.PI * 2);
      g.strokeStyle = hp.erase ? 'rgba(244,241,232,0.85)' : '#5cc8f0';
      g.lineWidth = 1.25;
      g.setLineDash(hp.erase ? [3, 3] : []);
      g.stroke();
      g.setLineDash([]);
    }
  }

  // Voiced pitch as polyline segments (split at gaps and octave jumps). With a
  // curve, each frame is shifted by it and only the frames it moves are kept.
  pitchSegs(curve) {
    const segs = [];
    let cur = null, prevHz = 0;
    for (const fr of this.pitch.track) {
      const [t, hz] = fr;
      const c = curve ? curveAt(curve, t) : 0;
      if (!voiced(fr) || (curve && Math.abs(c) < 0.5)) { cur = null; continue; }
      const f = hz * Math.pow(2, c / 1200);
      if (!cur || Math.abs(Math.log2(f / prevHz)) > 0.25) segs.push((cur = []));
      cur.push([this.srcToX(t), this.hzToY(f)]); prevHz = f;
    }
    return segs;
  }

  strokeSegs(g, segs, color) {
    for (const [w, c] of [[4, 'rgba(8,10,14,0.55)'], [1.75, color]]) {
      g.lineWidth = w; g.strokeStyle = c;
      for (const sg of segs) {
        g.beginPath();
        if (sg.length === 1) { g.moveTo(sg[0][0] - 1, sg[0][1]); g.lineTo(sg[0][0] + 1, sg[0][1]); }
        else sg.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.stroke();
      }
    }
  }

  drawPitch(g) {
    const tr = this.pitch?.track;
    if (!tr?.length) return;
    const editing = this.tool === 'pitch';
    g.save();
    g.lineJoin = 'round'; g.lineCap = 'round';
    if (editing) {
      // Span for Snap, then the span being dragged.
      const band = (t0, t1, a) => { const x0 = this.srcToX(t0), x1 = this.srcToX(t1); g.fillStyle = `rgba(${AMBER},${a})`; g.fillRect(x0, 0, x1 - x0, this.H); g.fillStyle = `rgba(${AMBER},0.6)`; g.fillRect(Math.round(x0), 0, 1, this.H); g.fillRect(Math.round(x1) - 1, 0, 1, this.H); };
      if (this.pcSpan) band(this.pcSpan.t0, this.pcSpan.t1, 0.07);
      for (const r of this.pcDrag?.runs || []) band(r.t0, r.t1, 0.12);
      // Frames that are not editable: low-confidence pitch as faint dots, unvoiced
      // stretches as a muted strip along the bottom edge.
      const hop = this.pitch.hop || 0.01;
      g.fillStyle = 'rgba(244,241,232,0.28)';
      for (const fr of tr) {
        if (voiced(fr)) continue;
        const x = this.srcToX(fr[0]);
        if (fr[1] !== null) g.fillRect(x - 1, this.hzToY(fr[1]) - 1, 2, 2);
        else g.fillRect(x - (hop / (this.src.s1 - this.src.s0)) * this.W / 2, this.H - 3, Math.max(1, (hop / (this.src.s1 - this.src.s0)) * this.W), 3);
      }
    }
    this.strokeSegs(g, this.pitchSegs(null), '#7fd8c6');
    const curve = this.pcPreview || this.pc;
    if (curve.length) this.strokeSegs(g, this.pitchSegs(curve), '#5cc8f0');
    g.restore();
  }

  // ── pointer: box / lasso / brush / spot heal, axes, click-to-seek ──────
  bindPointer(node, mode) {
    node.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.clip || this.busy) return;
      const vr = this.view.getBoundingClientRect();
      const px = (ev) => ({ x: clamp(ev.clientX - vr.left, 0, this.W), y: clamp(ev.clientY - vr.top, 0, this.H) });
      const a = px(e);
      // In the pitch tool the time axis picks the span for Snap / arrow keys.
      const spanPick = mode === 'time' && this.tool === 'pitch';
      if (mode !== 'rect' && this.tool !== 'box' && !spanPick) this.setTool('box');
      const kind = spanPick ? 'pcspan' : mode !== 'rect' ? mode : this.tool;
      let moved = false, last = a;
      node.setPointerCapture(e.pointerId);
      if (kind === 'pitch' || kind === 'pcspan') return this.pitchPointer(node, e, kind, px);
      if (kind === 'brush' || kind === 'spot') {
        this.draft = { stroke: { points: [this.ptToSrc(a.x, a.y)], ...this.brushRadius(), ...(kind === 'brush' && e.shiftKey ? { erase: true } : {}) } };
        this.maskDirty = this.dirty = true;
      } else if (kind === 'lasso') this.draft = { outline: [this.ptToSrc(a.x, a.y)] };
      const move = (ev) => {
        const b = px(ev);
        if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) return;
        moved = true;
        if (kind === 'brush' || kind === 'spot' || kind === 'lasso') {
          if (Math.hypot(b.x - last.x, b.y - last.y) < 2.5) return;
          last = b;
          (this.draft.stroke?.points || this.draft.outline).push(this.ptToSrc(b.x, b.y));
          this.hoverPt = { ...b, erase: !!this.draft.stroke?.erase };
          this.maskDirty = this.dirty = true;
          if (kind === 'lasso') this.updateReadout();
          return;
        }
        const { s0, s1 } = this.src;
        const t = kind === 'freq' ? [s0, s1] : [this.xToSrc(Math.min(a.x, b.x)), this.xToSrc(Math.max(a.x, b.x))];
        const f = kind === 'time' ? [0, this.nyq] : [this.yToHz(Math.max(a.y, b.y)), this.yToHz(Math.min(a.y, b.y))];
        if (kind !== 'time' && f[0] <= MIN_HZ * 1.01) f[0] = 0;
        this.setSel({ t0: t[0], t1: t[1], f0: f[0], f1: f[1] }, true);
      };
      const up = (ev) => {
        node.removeEventListener('pointermove', move);
        node.removeEventListener('pointerup', up);
        node.removeEventListener('pointercancel', up);
        const cancelled = ev.type === 'pointercancel';
        if (kind === 'brush') {
          const st = this.draft.stroke;
          this.draft = null;
          if (!cancelled) this.strokes.push(st);
          if (!this.strokes.some((x) => !x.erase)) this.strokes = [];
          this.maskDirty = this.dirty = true;
          this.updateButtons();
        } else if (kind === 'spot') {
          const st = this.draft.stroke;
          this.draft = null;
          this.maskDirty = this.dirty = true;
          if (!cancelled) this.spotHeal(st);
        } else if (kind === 'lasso') {
          const pts = this.draft.outline;
          this.draft = null;
          if (!moved && !cancelled) { this.lasso = null; this.app.player.seek(this.srcToTimeline(this.xToSrc(px(ev).x))); }
          else this.lasso = !cancelled && this.outlineArea(pts) > 30 ? pts : null;
          this.dirty = true;
          this.updateButtons();
        } else if (!moved && kind !== 'freq') {
          this.setSel(null);
          this.app.player.seek(this.srcToTimeline(this.xToSrc(px(ev).x)));
        } else if (this.sel && (this.sel.t1 - this.sel.t0 < 0.005 || this.sel.f1 - this.sel.f0 < 1)) this.setSel(null);
        else this.updateButtons();
      };
      node.addEventListener('pointermove', move);
      node.addEventListener('pointerup', up);
      node.addEventListener('pointercancel', up);
    });
  }

  // Pitch tool drag: vertical distance → cents on the log-frequency axis (Shift =
  // a tenth), horizontal extent → the time span; a mostly vertical drag moves the
  // whole voiced note under the pointer. Unvoiced frames are never shifted.
  pitchPointer(node, e, kind, px) {
    const a = px(e);
    const centsPerPx = (1200 * Math.log2(this.nyq / MIN_HZ)) / this.H;
    let moved = false, lastY = e.clientY, cents = 0;
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) return;
      moved = true;
      const b = px(ev);
      const t0 = this.xToSrc(Math.min(a.x, b.x)), t1 = this.xToSrc(Math.max(a.x, b.x));
      if (kind === 'pcspan') { this.pcSpan = { t0, t1 }; this.dirty = true; this.updateReadout(); return; }
      cents = clamp(cents + (lastY - ev.clientY) * centsPerPx * (ev.shiftKey ? 0.1 : 1), -1200, 1200);
      lastY = ev.clientY;
      const runs = Math.abs(b.x - a.x) < 6 ? this.voicedRuns(...this.runAround(a.x)) : this.voicedRuns(t0, t1);
      const c = Math.round(cents * 10) / 10;
      this.pcDrag = { runs, cents: c };
      this.pcPreview = runs.reduce((pts, r) => addBump(pts, r.t0, r.t1, c), this.pc);
      this.dirty = true;
      this.updateReadout();
    };
    const up = (ev) => {
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', up);
      const cancelled = ev.type === 'pointercancel';
      if (kind === 'pcspan') {
        if (!moved || !this.pcSpan || this.srcToX(this.pcSpan.t1) - this.srcToX(this.pcSpan.t0) < 3) this.pcSpan = null;
        if (!moved && !cancelled) this.app.player.seek(this.srcToTimeline(this.xToSrc(px(ev).x)));
      } else if (!moved) {
        if (!cancelled) this.app.player.seek(this.srcToTimeline(this.xToSrc(px(ev).x)));
      } else if (!cancelled && this.pcPreview) this.pc = this.pcPreview;
      this.pcDrag = null; this.pcPreview = null;
      this.dirty = true;
      this.updateButtons();
    };
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
  }

  // [t0, t1] of the voiced run under (or within 4 px of) screen x, or an empty span.
  runAround(x) {
    const tr = this.pitch?.track || [];
    const tol = (4 / this.W) * (this.src.s1 - this.src.s0), t = this.xToSrc(x);
    let i = -1, best = Infinity;
    tr.forEach((fr, j) => { const d = Math.abs(fr[0] - t); if (voiced(fr) && d <= tol && d < best) { best = d; i = j; } });
    if (i < 0) return [t, t];
    let j0 = i, j1 = i;
    while (j0 > 0 && voiced(tr[j0 - 1])) j0--;
    while (j1 < tr.length - 1 && voiced(tr[j1 + 1])) j1++;
    return [tr[j0][0], tr[j1][0]];
  }

  // Contiguous voiced stretches inside [t0, t1], each widened by half a frame:
  // [{ t0, t1, frames: [[t, hz, conf], …] }].
  voicedRuns(t0, t1) {
    const tr = this.pitch?.track || [], h = (this.pitch?.hop || 0.01) / 2, runs = [];
    let cur = null;
    for (const fr of tr) {
      if (fr[0] < t0 - 1e-6 || fr[0] > t1 + 1e-6 || !voiced(fr)) { cur = null; continue; }
      if (!cur) runs.push((cur = { frames: [] }));
      cur.frames.push(fr);
    }
    for (const r of runs) { r.t0 = Math.max(0, r.frames[0][0] - h); r.t1 = r.frames.at(-1)[0] + h; }
    return runs;
  }

  // Screen-space area of an outline in px² (shoelace), to ignore scribbles.
  outlineArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const [t1, f1] = pts[i], [t2, f2] = pts[(i + 1) % pts.length];
      a += this.srcToX(t1) * this.hzToY(f2) - this.srcToX(t2) * this.hzToY(f1);
    }
    return Math.abs(a) / 2;
  }

  setTool(id) {
    this.tool = id;
    for (const [k, b] of Object.entries(this.toolBtns || {})) { b.setAttribute('aria-pressed', String(k === id)); b.classList.toggle('on', k === id); }
    if (this.sizeSlider) this.sizeSlider.hidden = !(id === 'brush' || id === 'spot');
    if (this.canvas) this.canvas.dataset.tool = id;
    if (this.pcGroup) { this.pcGroup.hidden = id !== 'pitch'; this.editGroup.hidden = this.noiseGroup.hidden = id === 'pitch'; }
    // The pitch tool works on the overlay, so it turns it on.
    if (id === 'pitch' && !this.showPitch && this.pitchBtn) this.togglePitch();
    this.maskDirty = this.dirty = true;
    this.updateButtons();
  }

  // The region of the active tool in API form, or null.
  region() {
    if (this.tool === 'box' && this.sel) {
      const s = this.sel;
      return { start: s.t0, end: s.t1, lowHz: s.f0, highHz: Math.min(s.f1, this.nyq) };
    }
    if (this.tool === 'lasso' && this.lasso) return { polygon: this.lasso.map(([t, f]) => [+t.toFixed(5), +f.toFixed(2)]) };
    if (this.tool === 'brush' && this.strokes.some((x) => !x.erase)) return { strokes: this.strokes.map((x) => this.strokeBody(x)) };
    return null;
  }
  strokeBody(x) {
    return { points: x.points.map(([t, f]) => [+t.toFixed(5), +f.toFixed(2)]), radiusMs: +x.radiusMs.toFixed(2), radiusSemitones: +x.radiusSemitones.toFixed(3), ...(x.erase ? { erase: true } : {}) };
  }
  clearRegion() {
    const had = !!this.region() || !!this.draft;
    if (this.tool === 'box') this.sel = null;
    if (this.tool === 'lasso') this.lasso = null;
    if (this.tool === 'brush') this.strokes = [];
    this.draft = null;
    this.maskDirty = this.dirty = true;
    this.updateButtons();
    return had;
  }

  onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input,textarea,select,[contenteditable="true"]') || !this.clip) return;
    const k = e.key.toLowerCase();
    const tool = TOOL_KEYS[k];
    const eat = () => { e.preventDefault(); e.stopPropagation(); };
    if (tool) { eat(); this.setTool(tool); }
    else if (this.tool === 'pitch' && (k === 'arrowup' || k === 'arrowdown') && this.pcSpan && !this.busy && e.target === this.canvas) {
      // Keyboard nudge of the voiced notes in the selected span: 10 cents (Shift = 1).
      eat();
      const c = (k === 'arrowup' ? 1 : -1) * (e.shiftKey ? 1 : 10);
      this.pc = this.voicedRuns(this.pcSpan.t0, this.pcSpan.t1).reduce((pts, r) => addBump(pts, r.t0, r.t1, c), this.pc);
      this.dirty = true;
      this.updateButtons();
    } else if (this.tool === 'pitch' && k === 'escape') { if (this.pcSpan) { eat(); this.pcSpan = null; this.dirty = true; this.updateButtons(); } }
    else if (k === 'escape') { if (this.clearRegion()) eat(); }
    else if (k === 'delete' || k === 'backspace') {
      // Inside the spectral view Delete never removes the clip; it turns the region down fully.
      eat();
      if (this.region() && !this.busy) this.edit('attenuate', -60);
    } else if (k === 'shift' && this.hoverPt) { this.hoverPt.erase = this.tool === 'brush'; this.dirty = true; }
  }

  hover(e) {
    if (!this.clip || !this.W) return;
    const r = this.view.getBoundingClientRect();
    const x = clamp(e.clientX - r.left, 0, this.W), y = clamp(e.clientY - r.top, 0, this.H);
    this.cursor.textContent = `${fmtTime(this.srcToTimeline(this.xToSrc(x)), 3)} · ${fmtHz(this.yToHz(y))}`;
    if (this.tool === 'brush' || this.tool === 'spot') { this.hoverPt = { x, y, erase: this.tool === 'brush' && e.shiftKey }; this.dirty = true; }
  }

  setSel(sel, dragging) {
    this.sel = sel;
    this.dirty = true;
    if (!dragging) this.updateButtons(); else this.updateReadout();
  }

  updateReadout() {
    const hint = {
      box: 'Drag to select a region. Drag an axis to select a band or a time span.',
      lasso: 'Draw an outline around the sound; it closes when you let go.',
      brush: 'Paint over the sound. Hold Shift to erase. Then attenuate or heal.',
      spot: 'Paint over a click, cough or squeak; it is healed when you let go.',
      pitch: 'Drag the pitch curve up or down; drag sideways to cover a span, Shift for fine steps. Drag the time axis to pick a span for snapping.',
    }[this.tool];
    if (this.tool === 'pitch') {
      const d = this.pcDrag, s = this.pcSpan;
      const span = (t0, t1) => `${fmtTime(this.srcToTimeline(t0), 3)} – ${fmtTime(this.srcToTimeline(t1), 3)}`;
      let text = hint;
      if (d) text = d.runs.length ? `${fmtCents(d.cents)} · ${span(d.runs[0].t0, d.runs.at(-1).t1)}${d.runs.length > 1 ? ` · ${d.runs.length} voiced stretches` : ''}` : 'No voiced pitch here; unvoiced frames cannot be shifted.';
      else if (!this.pitch?.track) text = 'Measuring pitch…';
      else if (s) text = `Span ${span(s.t0, s.t1)} (${(s.t1 - s.t0).toFixed(3)} s) · Up / Down nudges it by 10 cents, Shift by 1`;
      this.readout.classList.toggle('muted', !d && !s);
      this.readout.textContent = text;
      return;
    }
    if (this.tool !== 'box') {
      const r = this.tool === 'spot' ? null : this.region();
      const b = r && this.bounds(r);
      this.readout.classList.toggle('muted', !b);
      this.readout.textContent = b
        ? `${this.tool === 'lasso' ? 'Lasso' : `Brush, ${r.strokes.length} stroke${r.strokes.length > 1 ? 's' : ''}`} · ${fmtTime(this.srcToTimeline(b.t0), 3)} – ${fmtTime(this.srcToTimeline(b.t1), 3)} · ${fmtHz(b.f0)} – ${fmtHz(b.f1)}`
        : hint;
      return;
    }
    const s = this.sel;
    if (!s) { this.readout.textContent = hint; this.readout.classList.add('muted'); return; }
    this.readout.classList.remove('muted');
    const fullBand = s.f0 <= 0 && s.f1 >= this.nyq - 1;
    this.readout.textContent = `${fmtTime(this.srcToTimeline(s.t0), 3)} – ${fmtTime(this.srcToTimeline(s.t1), 3)} (${(s.t1 - s.t0).toFixed(3)} s) · ${fullBand ? 'all frequencies' : `${fmtHz(s.f0)} – ${fmtHz(s.f1)}`}`;
  }

  // Time/frequency bounds of an API region (for the readout).
  bounds(r) {
    if (r.start !== undefined) return { t0: r.start, t1: r.end, f0: r.lowHz, f1: r.highHz };
    const pts = r.polygon || r.strokes.filter((x) => !x.erase).flatMap((x) => x.points);
    return { t0: Math.min(...pts.map((p) => p[0])), t1: Math.max(...pts.map((p) => p[0])), f0: Math.min(...pts.map((p) => p[1])), f1: Math.max(...pts.map((p) => p[1])) };
  }

  updateButtons() {
    if (!this.root) return;
    this.updateReadout();
    const busy = !!this.busy, r = this.region();
    const s = this.tool === 'box' ? this.sel : null;
    this.attBtn.textContent = `Attenuate ${fmtDb(this.gainDb)}`;
    this.attBtn.disabled = busy || !r;
    this.healBtn.disabled = busy || !r;
    this.learnBtn.disabled = busy || !s || s.t1 - s.t0 < 0.05;
    this.learnBtn.title = this.tool === 'box' ? 'Capture the noise in the selected time span (room tone only)' : 'Switch to the box tool and select a stretch of room tone';
    this.reduceBtn.disabled = busy || (!this.print && !(s && s.t1 - s.t0 >= 0.05));
    this.repairBtn.disabled = busy;
    this.gainSlider.querySelector('input').disabled = busy;
    this.root.classList.toggle('busy', busy);
    const hasCurve = this.pc.length > 0;
    this.pcApplyBtn.disabled = this.pcResetBtn.disabled = busy || !hasCurve;
    this.pcSnapBtn.disabled = busy || !this.pitch?.track?.some(voiced);
    this.pcSnapBtn.textContent = this.pcSpan ? 'Snap span to nearest semitone' : 'Snap to nearest semitone';
    const peak = this.pc.reduce((m, p) => (Math.abs(p.cents) > Math.abs(m) ? p.cents : m), 0);
    this.pcMax.textContent = hasCurve ? `Max shift ${fmtCents(peak)}` : 'No correction yet';
    this.pcMax.classList.toggle('muted', !hasCurve);
    this.renderPrintLine();
  }

  renderPrintLine() {
    if (this.busy) { this.printLine.className = 'small sp-print working'; this.printLine.textContent = `${this.busy}…`; return; }
    const p = this.print;
    this.printLine.className = 'small sp-print' + (p ? ' has' : ' muted');
    if (p === undefined) { this.printLine.textContent = ''; return; }
    if (!p) { this.printLine.textContent = 'No noise print yet'; this.printLine.title = 'Select a stretch of room tone and choose Learn noise print'; return; }
    const own = p.storedOn === this.clip.assetId;
    this.printLine.textContent = `Noise print: ${p.start.toFixed(2)}–${p.end.toFixed(2)} s${own ? '' : ' of the original'} · ${p.rmsDbfs} dBFS${p.tonalPeaks?.length ? ` · tones at ${p.tonalPeaks.slice(0, 2).map((x) => fmtHz(x.hz)).join(', ')}` : ' · broadband'}`;
    this.printLine.title = p.character;
  }

  async loadPrint() {
    const aid = this.clip.assetId;
    this.print = undefined;
    try {
      const r = await (await request('GET', `/api/projects/${this.app.pid}/assets/${aid}/noiseprint`)).json();
      if (this.clip?.assetId === aid) { this.print = r.noisePrint; this.updateButtons(); }
    } catch { /* status line stays empty */ }
  }

  // ── actions ───────────────────────────────────────────────────────────
  async run(label, fn) {
    if (this.busy) return;
    this.busy = label;
    this.updateButtons();
    try { return await fn(); }
    catch (e) { this.app.fail(e); }
    finally {
      this.busy = null; this.updateButtons();
      // Buttons are disabled while busy, which drops focus to <body>; give it back
      // to the spectrogram so the tool shortcuts keep working.
      if (this.canvas?.isConnected && (document.activeElement === document.body || this.root.contains(document.activeElement))) this.canvas.focus({ preventScroll: true });
    }
  }

  edit(action, gainDb = this.gainDb) {
    const r = this.region(), aid = this.clip.assetId;
    if (!r) return;
    const body = { action, ...r, ...(action === 'attenuate' ? { gainDb } : {}) };
    return this.run(action === 'heal' ? 'Healing' : `Attenuating ${fmtDb(gainDb)}`, async () => {
      await request('POST', `/api/projects/${this.app.pid}/assets/${aid}/spectral`, body);
    });
  }

  // Spot healing brush: the stroke stays visible while the heal runs.
  spotHeal(stroke) {
    const aid = this.clip.assetId;
    this.spotPending = stroke;
    this.maskDirty = this.dirty = true;
    return this.run('Spot healing', async () => {
      await request('POST', `/api/projects/${this.app.pid}/assets/${aid}/spectral`, { action: 'heal', strokes: [this.strokeBody(stroke)] });
    }).finally(() => { this.spotPending = null; this.maskDirty = this.dirty = true; });
  }

  // ── pitch overlay ───────────────────────────────────────────────────────
  togglePitch() {
    this.showPitch = !this.showPitch;
    store.set(PITCH_KEY, this.showPitch ? '1' : '0');
    this.pitchBtn.setAttribute('aria-pressed', String(this.showPitch));
    this.pitchBtn.classList.toggle('on', this.showPitch);
    if (this.showPitch) this.loadPitch();
    else if (this.tool === 'pitch') this.setTool('box');
    this.dirty = true;
  }

  // ── manual pitch correction ─────────────────────────────────────────────
  pcReset() {
    this.pc = []; this.pcPreview = null; this.pcDrag = null;
    this.dirty = true;
    this.updateButtons();
  }

  // Each voiced note in the span (or the whole clip) gets one offset that puts its
  // centre pitch, with the current curve, on the nearest semitone (A = 440 Hz).
  // Notes are found by a ~200 ms running mean of the pitch, so vibrato stays.
  pcSnap() {
    const { s0, s1 } = this.src, s = this.pcSpan || { t0: s0, t1: s1 };
    const hop = this.pitch?.hop || 0.01, half = Math.max(1, Math.round(0.1 / hop));
    let pts = this.pc, notes = 0;
    for (const run of this.voicedRuns(s.t0, s.t1)) {
      const fr = run.frames, c = fr.map(([t, hz]) => 1200 * Math.log2(hz / 440) + curveAt(this.pc, t));
      // Note per frame with hysteresis: a new note only starts once the smoothed pitch
      // is 70 cents away from the current one, so vibrato near a boundary stays one note.
      let note = null;
      const q = c.map((_, i) => {
        const m = centre(c.slice(Math.max(0, i - half), i + half + 1));
        if (note === null || Math.abs(m - note * 100) > 70) note = Math.round(m / 100);
        return note;
      });
      // Groups of frames on the same note; groups shorter than PC_MIN_RUN join the one before.
      const groups = [];
      q.forEach((n, i) => { const g = groups.at(-1); if (g && g.n === n) g.i1 = i; else groups.push({ n, i0: i, i1: i }); });
      const merged = [];
      for (const g of groups) {
        const prev = merged.at(-1), short = (g.i1 - g.i0 + 1) * hop < PC_MIN_RUN;
        if (prev && short) prev.i1 = g.i1;
        else if (prev && (prev.i1 - prev.i0 + 1) * hop < PC_MIN_RUN) Object.assign(prev, { n: g.n, i1: g.i1 });
        else merged.push({ ...g });
      }
      for (const g of merged) {
        const m = centre(c.slice(g.i0, g.i1 + 1));
        const off = Math.round((Math.round(m / 100) * 100 - m) * 10) / 10;
        if (Math.abs(off) < 0.5) continue;
        const t0 = g.i0 === 0 ? run.t0 : (fr[g.i0 - 1][0] + fr[g.i0][0]) / 2;
        const t1 = g.i1 === fr.length - 1 ? run.t1 : (fr[g.i1][0] + fr[g.i1 + 1][0]) / 2;
        pts = addBump(pts, t0, t1, off);
        notes++;
      }
    }
    this.pc = pts;
    this.dirty = true;
    this.updateButtons();
    toast(notes ? `Snapped ${notes} note${notes > 1 ? 's' : ''} to the nearest semitone${this.pcSpan ? ' in the span' : ''}` : 'Already on the nearest semitones', { kind: notes ? 'ok' : 'info' });
  }

  pcApply() {
    const aid = this.clip.assetId;
    if (!this.pc.length) return;
    // Curve in source seconds with 0-cent anchors just outside the edited span.
    const pts = this.pc.map((p) => ({ time: Math.max(0, +p.time.toFixed(4)), cents: +clamp(p.cents, -1200, 1200).toFixed(1) }));
    if (pts[0].cents !== 0) pts.unshift({ time: Math.max(0, +(pts[0].time - 0.02).toFixed(4)), cents: 0 });
    if (pts.at(-1).cents !== 0) pts.push({ time: +(pts.at(-1).time + 0.02).toFixed(4), cents: 0 });
    const points = pts.filter((p, i) => i === 0 || p.time > pts[i - 1].time);
    return this.run('Correcting pitch', async () => {
      await request('POST', `/api/projects/${this.app.pid}/assets/${aid}/pitch-curve`, { points });
      // The new asset arrives through live sync; until then keep nothing stale on screen.
      if (this.clip?.assetId === aid) this.pc = [];
      toast('Pitch curve applied', { kind: 'ok' });
    });
  }

  async loadPitch() {
    const c = this.clip;
    if (!c) return;
    const key = `${this.app.pid}:${c.assetId}:${c.offset}:${c.duration}`;
    if (this.pitch?.key === key || this.pitchLoading === key) return;
    this.pitchLoading = key;
    this.pitchBtn.classList.add('loading');
    try {
      const q = new URLSearchParams({ start: c.offset, end: c.offset + c.duration, maxPoints: Math.max(200, Math.round((this.W || 1000) * 1.5)) });
      const r = await (await request('GET', `/api/projects/${this.app.pid}/assets/${c.assetId}/pitch?${q}`)).json();
      if (this.pitchLoading !== key) return;
      this.pitch = { key, track: r.track, summary: r.summary, hop: r.pointHop };
      this.updateButtons();
      const sm = r.summary;
      this.pitchBtn.title = sm.medianHz ? `Pitch: median ${fmtHz(sm.medianHz)}, ${fmtHz(sm.p10Hz)}–${fmtHz(sm.p90Hz)}, ${Math.round(sm.voicedFraction * 100)}% voiced` : 'No pitched sound found in this clip';
      this.dirty = true;
    } catch (e) {
      if (this.pitchLoading === key) toast(`Could not measure pitch: ${e.message}`, { kind: 'error' });
    } finally {
      if (this.pitchLoading === key) { this.pitchLoading = null; this.pitchBtn.classList.remove('loading'); }
    }
  }

  learn() {
    const s = this.sel, aid = this.clip.assetId;
    if (!s) return;
    return this.run('Learning noise print', async () => {
      const r = await (await request('POST', `/api/projects/${this.app.pid}/assets/${aid}/noiseprint`, { start: s.t0, end: s.t1 })).json();
      if (this.clip?.assetId === aid) this.print = r.noisePrint;
      toast(`Noise print learned: ${r.noisePrint.character.toLowerCase()}`, { kind: 'ok' });
    });
  }

  reduceDialog() {
    const aid = this.clip.assetId, s = this.tool === 'box' ? this.sel : null;
    const learnFirst = s && s.t1 - s.t0 >= 0.05 && !this.print;
    const v = this.denoise;
    const slider = (label, key, min, max, step, fmt) => this.app.slider({ label, min, max, step, value: v[key], reset: { reductionDb: 18, sensitivity: 5, smoothing: 0.5 }[key], fmt, onlive: (x) => (v[key] = x), oncommit: (x) => (v[key] = x) });
    const p = this.print;
    const note = learnFirst
      ? `No noise print yet. It will be learned from the selected span (${fmtTime(this.srcToTimeline(s.t0), 2)}–${fmtTime(this.srcToTimeline(s.t1), 2)}) first — make sure it holds only noise.`
      : `Using the noise print from ${p.start.toFixed(2)}–${p.end.toFixed(2)} s (${p.character.toLowerCase()}). The whole source of this clip is processed; clips using it switch to the result.`;
    modal('Reduce noise with print', [
      el('p', { class: 'muted small sp-note' }, note),
      slider('Reduction', 'reductionDb', 0, 40, 1, (x) => `${Math.round(x)} dB`),
      slider('Sensitivity', 'sensitivity', 0, 10, 0.5, (x) => x.toFixed(1)),
      slider('Smoothing', 'smoothing', 0, 1, 0.05, (x) => x.toFixed(2)),
      el('p', { class: 'muted small sp-note' }, 'Reduction sets how far the noise goes down. Higher sensitivity treats more of the signal as noise. Smoothing evens out the gain over time and frequency to avoid watery artefacts.'),
    ], {
      actions: [{ label: 'Cancel' }, { label: 'Reduce noise', primary: true, action: () => {
        this.app.interacting = false;
        const body = { ...v, ...(learnFirst ? { start: s.t0, end: s.t1 } : {}) };
        this.run('Reducing noise', async () => {
          const r = await (await request('POST', `/api/projects/${this.app.pid}/assets/${aid}/denoise-print`, body)).json();
          const m = r.measured?.noisePrintRangeDbfs;
          if (m) toast(`Noise in the print range: ${m.before} → ${m.after} dBFS`, { kind: 'ok' });
        });
      } }],
    });
  }
}
