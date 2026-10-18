// Multitrack timeline: DOM track headers + one canvas for ruler, clips, selection, playhead.
import { dbToGain, projectEnd, automationAt, fadeAt, clipGainAt, FADE_SHAPES, EFFECTS, automatableParams } from './engine/graph.js';
import { el, fmtTime, clamp, theme as T, trackInk, withAlpha as hexA } from './ui.js';

const RULER_H = 30;
const HEADER_W = 212;
const MIN_PPS = 2, MAX_PPS = 4000;
const STEPS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];

export class Timeline {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.pps = 40;
    this.scrollX = 0;
    this.scrollY = 0;
    this.trackH = 92;
    this.drag = null;
    this.hover = null;
    this.dirty = true;

    this.headers = el('div', { class: 'tl-headers' });
    this.headerInner = el('div', { class: 'tl-headers-inner' });
    this.headers.append(el('div', { class: 'tl-corner' }, [
      el('button', { class: 'chip', title: 'Zoom out (−)', onclick: () => this.zoomBy(1 / 1.5) }, '−'),
      el('button', { class: 'chip', title: 'Zoom to fit (\\)', onclick: () => this.zoomFit() }, 'Fit'),
      el('button', { class: 'chip', title: 'Zoom in (+)', onclick: () => this.zoomBy(1.5) }, '+'),
      el('select', { class: 'chip zoom-pick', title: 'Zoom to a duration', 'aria-label': 'Zoom to a duration', onchange: (e) => { const d = +e.target.value; if (d) { const c = this.t(this.w / 2); this.pps = clamp((this.w - 40) / d, MIN_PPS, MAX_PPS); this.scrollX = Math.max(0, Math.min(c - d / 2, this.app.player.position)); this.dirty = true; } e.target.value = ''; } },
        [['', 'Zoom'], [5, '5 s'], [10, '10 s'], [30, '30 s'], [60, '1 min'], [300, '5 min'], [600, '10 min'], [1800, '30 min']].map(([v, l]) => el('option', { value: v }, l))),
      el('button', { class: 'chip', title: 'Track height', 'aria-label': 'Track height', onclick: () => { this.trackH = this.trackH === 92 ? 140 : this.trackH === 140 ? 64 : 92; this.renderHeaders(); this.dirty = true; } }, '↕'),
      (this.snapBtn = el('button', { class: 'chip on', title: 'Snap to edges, markers and playhead (hold Alt to bypass)', onclick: () => { app.snap = !app.snap; this.snapBtn.classList.toggle('on', app.snap); } }, 'Snap')),
    ]), this.headerInner);
    this.canvasWrap = el('div', { class: 'tl-canvas' });
    this.canvas = el('canvas');
    this.canvasWrap.append(this.canvas);
    this.empty = el('div', { class: 'tl-empty' });
    this.canvasWrap.append(this.empty);
    root.append(this.headers, this.canvasWrap);

    new ResizeObserver(() => this.resize()).observe(this.canvasWrap);
    this.bindEvents();
    const loop = () => { this.frame(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  get project() { return this.app.project; }
  x(t) { return (t - this.scrollX) * this.pps; }
  t(x) { return x / this.pps + this.scrollX; }
  trackY(i) { return RULER_H + i * this.trackH - this.scrollY; }
  trackAt(y) {
    const i = Math.floor((y - RULER_H + this.scrollY) / this.trackH);
    return i >= 0 && i < this.project.tracks.length ? { track: this.project.tracks[i], index: i } : { track: null, index: i };
  }

  resize() {
    const r = this.canvasWrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr);
    this.canvas.style.width = r.width + 'px'; this.canvas.style.height = r.height + 'px';
    this.ctx = this.canvas.getContext('2d');
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dirty = true;
    if (this.fitPending && this.w > 0) { this.fitPending = false; this.zoomFit(); }
  }

  // ── headers ───────────────────────────────────────────────────────────
  renderHeaders() {
    const p = this.project;
    const sel = this.app.selection;
    this.headerInner.replaceChildren(...p.tracks.map((t) => {
      const fxCount = t.effects.length;
      const meter = el('div', { class: 'tr-meter' }, el('i'));
      meter.dataset.track = t.id;
      const isBus = t.kind === 'bus';
      const h = el('div', { class: 'tr-head' + (sel.trackId === t.id ? ' selected' : '') + (isBus ? ' bus' : '') + (this.trackH < 80 ? ' compact' : ''), style: `--tc:${t.color};height:${this.trackH}px`, onmousedown: (e) => { if (e.target.closest('button,input,[contenteditable]')) return; this.app.select({ trackId: t.id }); } }, [
        el('div', { class: 'tr-row' }, [
          el('span', { class: 'tr-swatch' }),
          isBus ? el('span', { class: 'tr-kind' }, 'Bus') : null,
          el('span', { class: 'tr-name', title: 'Double-click to rename', ondblclick: (e) => this.app.renameInline(e.target, t.name, (name) => this.app.op('track.update', { trackId: t.id, name })) }, t.name),
          el('button', { class: 'tr-btn' + (t.mute ? ' on mute' : ''), title: 'Mute', onclick: () => this.app.op('track.update', { trackId: t.id, mute: !t.mute }) }, 'M'),
          isBus ? null : el('button', { class: 'tr-btn' + (t.solo ? ' on solo' : ''), title: 'Solo', onclick: () => this.app.op('track.update', { trackId: t.id, solo: !t.solo }) }, 'S'),
          (() => {
            const v = this.app.autoVisible, on = v.has(t.id);
            const has = Object.values(t.automation || {}).some((x) => x?.length);
            return el('button', { class: 'tr-btn auto-btn' + (on ? ' on auto' : '') + (has ? ' has' : ''), title: 'Show the automation lane. On the line: click adds a point, drag moves it, double-click deletes it.', 'aria-pressed': String(on), onclick: () => {
              on ? v.delete(t.id) : v.add(t.id);
              this.renderHeaders(); this.dirty = true;
            } }, 'A');
          })(),
        ]),
        el('div', { class: 'tr-row tr-faders' }, [
          this.app.miniSlider({ label: 'Vol', min: -60, max: 12, step: 0.1, value: t.gain, fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`, reset: 0, onlive: (v) => this.app.liveTrack(t.id, { gain: v }), oncommit: (v) => this.app.op('track.update', { trackId: t.id, gain: v }) }),
          this.app.miniSlider({ label: 'Pan', min: -1, max: 1, step: 0.01, value: t.pan, fmt: (v) => (Math.abs(v) < 0.005 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`), reset: 0, onlive: (v) => this.app.liveTrack(t.id, { pan: v }), oncommit: (v) => this.app.op('track.update', { trackId: t.id, pan: v }) }),
        ]),
        this.app.autoVisible.has(t.id) ? el('div', { class: 'tr-row tr-foot' }, [this.lanePicker(t)]) : el('div', { class: 'tr-row tr-foot' }, [
          el('button', { class: 'tr-fx' + (fxCount ? ' has' : ''), onclick: () => this.app.select({ trackId: t.id }, 'track') }, fxCount ? `${fxCount} effect${fxCount > 1 ? 's' : ''}` : 'Add effect'),
          meter,
        ]),
      ]);
      return h;
    }), el('div', { class: 'tr-adds' }, [
      el('button', { class: 'tr-add', onclick: () => this.app.op('track.add', {}) }, 'Add track'),
      el('button', { class: 'tr-add', title: 'A bus mixes several tracks through shared effects, e.g. one reverb for all voices', onclick: () => this.app.op('track.add', { kind: 'bus' }) }, 'Add bus'),
      el('button', { class: 'tr-add', title: 'Add several tracks at once, or remove tracks that have no clips', 'aria-label': 'More track actions', onclick: (e) => this.app.trackMenu(e.clientX, e.clientY) }, '…'),
    ]));
    this.headerInner.style.transform = `translateY(${-this.scrollY}px)`;
  }

  lanePicker(t) {
    const cur = this.param(t);
    const opts = [['volume', 'Volume'], ['pan', 'Pan']];
    for (const e of t.effects) for (const k of automatableParams(e.type)) opts.push([`fx:${e.id}:${k}`, `${EFFECTS[e.type].label}: ${k}`]);
    const used = (k) => (t.automation?.[k]?.length ? ' •' : '');
    return el('select', { class: 'lane-pick', 'aria-label': 'Automated parameter', onchange: (e) => { this.app.autoParam.set(t.id, e.target.value); this.dirty = true; } },
      opts.map(([k, l]) => el('option', { value: k, selected: k === cur }, l + used(k))));
  }

  updateMeters() {
    for (const m of this.headerInner.querySelectorAll('.tr-meter')) {
      const lv = this.app.player.trackLevel(m.dataset.track);
      const db = lv ? 20 * Math.log10(Math.max(lv.peak, 1e-6)) : -90;
      m.firstChild.style.width = `${clamp((db + 60) / 60, 0, 1) * 100}%`;
      m.classList.toggle('hot', db > -1);
    }
  }

  // ── geometry helpers ──────────────────────────────────────────────────
  clipView(c) {
    const o = this.drag?.preview?.get(c.id);
    return o ? { ...c, ...o } : c;
  }
  clipRect(c, ti) {
    const y = this.trackY(ti) + 4;
    return { x: this.x(c.start), y, w: c.duration * this.pps, h: this.trackH - 8 };
  }
  hit(mx, my) {
    if (my < RULER_H) return { zone: 'ruler' };
    const { track, index } = this.trackAt(my);
    if (!track) return { zone: 'empty', index };
    const ah = this.hitAutomation(mx, my, track, index);
    if (ah) return ah;
    // Topmost clip first (same order as drawing and playback).
    const stack = [...track.clips].sort((a, b) => (a.z || 0) - (b.z || 0) || a.start - b.start);
    for (let i = stack.length - 1; i >= 0; i--) {
      const c = this.clipView(stack[i]);
      const r = this.clipRect(c, index);
      if (mx < r.x - 4 || mx > r.x + r.w + 4 || my < r.y || my > r.y + r.h) continue;
      if (this.app.envClip === c.id && my > r.y + 14) {
        const env = c.envelope || [];
        for (let k = 0; k < env.length; k++) {
          const px = r.x + (env[k].time - c.offset) * this.pps;
          if (Math.abs(px - mx) < 6 && Math.abs(this.envY(env[k].value, r) - my) < 6) return { zone: 'envPoint', track, clip: stack[i], index, point: k, rect: r };
        }
        const v = automationAt(env, c.offset + (this.t(mx) - c.start), 0);
        if (Math.abs(this.envY(v, r) - my) < 6) return { zone: 'envLine', track, clip: stack[i], index, rect: r };
      }
      const edge = Math.min(8, r.w / 4);
      const fiX = r.x + c.fadeIn * this.pps, foX = r.x + r.w - c.fadeOut * this.pps;
      if (my < r.y + 14 && r.w > 90 && mx > r.x + r.w - 50 && mx < r.x + r.w - 12 && Math.abs(mx - foX) > 8) return { zone: 'clipGain', track, clip: stack[i], index };
      if (my < r.y + 14) {
        if (Math.abs(mx - fiX) < 7 && mx < r.x + r.w / 2) return { zone: 'fadeIn', track, clip: stack[i], index };
        if (Math.abs(mx - foX) < 7 && mx > r.x + r.w / 2) return { zone: 'fadeOut', track, clip: stack[i], index };
      }
      if (mx < r.x + edge) return { zone: 'trimL', track, clip: stack[i], index };
      if (mx > r.x + r.w - edge) return { zone: 'trimR', track, clip: stack[i], index };
      return { zone: 'clip', track, clip: stack[i], index };
    }
    return { zone: 'lane', track, index };
  }

  param(track) {
    const pm = this.app.autoParam.get(track.id) || 'volume';
    return pm.startsWith('fx:') && !track.effects.some((e) => e.id === pm.split(':')[1]) ? 'volume' : pm;
  }
  // Value range of an automation lane. Volume: -40…+12 dB bottom→top. Pan: left at the
  // top (like Audition). Effect params use their own range; Hz on a log scale.
  autoSpec(track, param) {
    if (param === 'volume') return { min: -40, max: 12, hardMin: -60, neutral: 0, snap: 0.6, step: 0.1, label: 'Volume', fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB` };
    if (param === 'pan') return { min: -1, max: 1, invert: true, neutral: 0, snap: 0.03, step: 0.01, label: 'Pan  L ↑  R ↓', fmt: (v) => (Math.abs(v) < 0.01 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`) };
    const [, id, name] = param.split(':');
    const fx = track.effects.find((e) => e.id === id);
    const sp = fx && EFFECTS[fx.type]?.params[name];
    if (!sp) return this.autoSpec(track, 'volume');
    const log = sp.unit === 'Hz', range = sp.maximum - sp.minimum;
    return {
      min: sp.minimum, max: sp.maximum, log, neutral: fx.params[name] ?? sp.default, snap: 0, step: log ? 1 : range > 50 ? 0.5 : range > 5 ? 0.1 : 0.01,
      label: `${EFFECTS[fx.type].label}: ${name}`,
      fmt: (v) => (log ? (v >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : `${Math.round(v)} Hz`) : `${+v.toFixed(2)}${sp.unit ? ' ' + sp.unit : ''}`),
    };
  }
  autoY(v, ti, param = 'volume') {
    const sp = this.autoSpec(this.project.tracks[ti], param);
    const y0 = this.trackY(ti) + 20, h = this.trackH - 28;
    const c = clamp(v, sp.min, sp.max);
    const n = sp.log ? Math.log(c / sp.min) / Math.log(sp.max / sp.min) : (c - sp.min) / (sp.max - sp.min);
    return y0 + (sp.invert ? n : 1 - n) * h;
  }
  autoV(y, ti, param = 'volume') {
    const sp = this.autoSpec(this.project.tracks[ti], param);
    const y0 = this.trackY(ti) + 20, h = this.trackH - 28;
    const n = clamp(sp.invert ? (y - y0) / h : 1 - (y - y0) / h, 0, 1);
    let v = sp.log ? sp.min * Math.pow(sp.max / sp.min, n) : sp.min + n * (sp.max - sp.min);
    if (sp.snap && Math.abs(v - sp.neutral) < sp.snap * (sp.max - sp.min) / 52) v = sp.neutral;
    if (param === 'volume' && n === 0) v = sp.hardMin;
    return Math.round(clamp(v, sp.hardMin ?? sp.min, sp.max) / sp.step) * sp.step;
  }
  envY(db, r) { return r.y + 14 + (r.h - 14) * (0.5 - clamp(db, -30, 12) / 60); }
  envV(y, r) { const v = (0.5 - (y - r.y - 14) / (r.h - 14)) * 60; return Math.abs(v) < 0.5 ? 0 : Math.round(clamp(v, -60, 12) * 10) / 10; }

  autoPoints(track) { return this.drag?.autoTrack === track.id ? this.drag.points : track.automation?.[this.param(track)] || []; }
  hitAutomation(mx, my, track, index) {
    if (!this.app.autoVisible.has(track.id)) return null;
    const pts = this.autoPoints(track), pm = this.param(track);
    for (let i = 0; i < pts.length; i++) {
      if (Math.abs(this.x(pts[i].time) - mx) < 6 && Math.abs(this.autoY(pts[i].value, index, pm) - my) < 6) return { zone: 'autoPoint', track, index, point: i };
    }
    const v = automationAt(pts, this.t(mx), this.autoSpec(track, pm).neutral);
    if (Math.abs(this.autoY(v, index, pm) - my) < 5) return { zone: 'autoLine', track, index };
    return null;
  }

  snapTargets(excludeIds) {
    const pts = [0, this.app.player.position];
    for (const t of this.project.tracks) for (const c of t.clips) if (!excludeIds.has(c.id)) pts.push(c.start, c.start + c.duration);
    for (const m of this.project.markers) { pts.push(m.time); if (m.duration) pts.push(m.time + m.duration); }
    const r = this.app.selection.range; if (r) pts.push(r.start, r.end);
    return pts;
  }
  snap(t, targets, e) {
    if (!this.app.snap || e.altKey) return { t, snapped: null };
    let best = null, bd = 8 / this.pps;
    for (const p of targets) { const d = Math.abs(p - t); if (d < bd) { bd = d; best = p; } }
    return best === null ? { t, snapped: null } : { t: best, snapped: best };
  }

  // ── events ────────────────────────────────────────────────────────────
  bindEvents() {
    const c = this.canvas;
    const pos = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [mx] = pos(e);
      if (e.ctrlKey || e.metaKey) {
        const t = this.t(mx);
        this.pps = clamp(this.pps * Math.exp(-e.deltaY * 0.01), MIN_PPS, MAX_PPS);
        this.scrollX = Math.max(0, t - mx / this.pps);
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        this.scrollX = Math.max(0, this.scrollX + (e.shiftKey ? e.deltaY : e.deltaX) / this.pps);
      } else {
        const maxY = Math.max(0, (this.project.tracks.length + 1) * this.trackH + RULER_H - this.h);
        this.scrollY = clamp(this.scrollY + e.deltaY, 0, maxY);
        this.headerInner.style.transform = `translateY(${-this.scrollY}px)`;
      }
      this.dirty = true;
    }, { passive: false });
    this.headers.addEventListener('wheel', (e) => {
      const maxY = Math.max(0, (this.project.tracks.length + 1) * this.trackH + RULER_H - this.h);
      this.scrollY = clamp(this.scrollY + e.deltaY, 0, maxY);
      this.headerInner.style.transform = `translateY(${-this.scrollY}px)`;
      this.dirty = true;
    }, { passive: true });

    c.addEventListener('pointermove', (e) => {
      if (this.drag || this.touchPan) return;
      const [mx, my] = pos(e);
      const h = this.hit(mx, my);
      this.hover = h;
      c.style.cursor = { envPoint: 'move', envLine: 'copy', clipGain: 'ns-resize', autoPoint: 'move', autoLine: 'copy', trimL: 'w-resize', trimR: 'e-resize', fadeIn: 'ew-resize', fadeOut: 'ew-resize', clip: 'grab', ruler: 'pointer', lane: 'text', empty: 'default' }[h.zone] || 'default';
      this.hoverX = mx;
      this.dirty = true;
    });
    c.addEventListener('pointerleave', () => { this.hover = null; this.hoverX = null; this.dirty = true; });

    // Touch: one finger on empty space pans, two fingers pinch-zoom; on clips it edits like a mouse.
    const touches = new Map();
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size === 2) {
          this.drag = null;
          const [a, b] = [...touches.values()];
          const r = c.getBoundingClientRect();
          this.touchPan = { pinch: Math.abs(a.x - b.x) || 1, pps: this.pps, center: this.t((a.x + b.x) / 2 - r.left) };
          return;
        }
      }
      if (e.button !== 0) return;
      const [mx, my] = pos(e);
      if (e.pointerType === 'touch') {
        const zone = this.hit(mx, my).zone;
        if (zone === 'lane' || zone === 'empty') { this.touchPan = { x: e.clientX, y: e.clientY, sx: this.scrollX, sy: this.scrollY, moved: false, mx }; return; }
      }
      const h = this.hit(mx, my);
      const t0 = this.t(mx);
      const app = this.app;
      e.preventDefault();

      if (h.zone === 'envPoint' || h.zone === 'envLine') {
        const points = (h.clip.envelope || []).map((p) => ({ ...p }));
        let idx = h.point;
        if (h.zone === 'envLine') {
          const time = h.clip.offset + (t0 - h.clip.start);
          points.push({ time, value: this.envV(my, h.rect) });
          points.sort((a, b) => a.time - b.time);
          idx = points.findIndex((p) => p.time === time);
        }
        this.drag = { kind: 'env', clip: h.clip, rect: h.rect, points, idx, x0: mx, y0: my, moved: h.zone === 'envLine' };
        this.dirty = true;
        return;
      }
      if (h.zone === 'autoPoint' || h.zone === 'autoLine') {
        const pm = this.param(h.track);
        let points = (h.track.automation?.[pm] || []).map((p) => ({ ...p }));
        let idx = h.point;
        if (h.zone === 'autoLine') {
          const time = Math.max(0, t0);
          points.push({ time, value: this.autoV(my, h.index, pm) });
          points.sort((a, b) => a.time - b.time);
          idx = points.findIndex((p) => p.time === time);
        }
        this.drag = { kind: 'auto', autoTrack: h.track.id, param: pm, trackIndex: h.index, points, idx, x0: mx, y0: my, moved: h.zone === 'autoLine' };
        this.dirty = true;
        return;
      }
      if (h.zone === 'ruler' || h.zone === 'lane' || h.zone === 'empty') {
        this.drag = { kind: 'range', x0: mx, t0: Math.max(0, t0), trackId: h.track?.id, moved: false };
        if (h.zone !== 'ruler' && !e.shiftKey) app.select({ trackId: h.track?.id || app.selection.trackId });
      } else {
        const clip = h.clip;
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          const ids = new Set(app.selection.clipIds);
          ids.has(clip.id) ? ids.delete(clip.id) : ids.add(clip.id);
          app.select({ clipIds: ids, trackId: h.track.id });
        } else if (!app.selection.clipIds.has(clip.id)) {
          app.select({ clipIds: new Set([clip.id]), trackId: h.track.id });
        }
        const ids = h.zone === 'clip' ? new Set(app.selection.clipIds) : new Set([clip.id]);
        const originals = new Map();
        for (const t of this.project.tracks) for (const cl of t.clips) if (ids.has(cl.id)) originals.set(cl.id, { ...cl, trackId: t.id });
        const asset = this.project.assets.find((a) => a.id === clip.assetId);
        this.drag = { kind: h.zone, clip, trackIndex: h.index, x0: mx, y0: my, t0, ids, originals, asset, targets: this.snapTargets(ids), copy: e.altKey && h.zone === 'clip', moved: false, preview: new Map() };
        c.style.cursor = h.zone === 'clip' ? 'grabbing' : c.style.cursor;
      }
      this.dirty = true;
    });

    window.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch' && touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const tp = this.touchPan;
      if (tp) {
        if (tp.pinch && touches.size === 2) {
          const [a, b] = [...touches.values()];
          const r = c.getBoundingClientRect();
          this.pps = clamp(tp.pps * (Math.abs(a.x - b.x) / tp.pinch), MIN_PPS, MAX_PPS);
          this.scrollX = Math.max(0, tp.center - ((a.x + b.x) / 2 - r.left) / this.pps);
        } else if (!tp.pinch) {
          if (Math.abs(e.clientX - tp.x) + Math.abs(e.clientY - tp.y) > 6) tp.moved = true;
          this.scrollX = Math.max(0, tp.sx - (e.clientX - tp.x) / this.pps);
          const maxY = Math.max(0, (this.project.tracks.length + 1) * this.trackH + RULER_H - this.h);
          this.scrollY = clamp(tp.sy - (e.clientY - tp.y), 0, maxY);
          this.headerInner.style.transform = `translateY(${-this.scrollY}px)`;
        }
        this.dirty = true;
        return;
      }
      const d = this.drag;
      if (!d) return;
      const [mx, my] = pos(e);
      if (Math.abs(mx - d.x0) > 3 || (d.y0 !== undefined && Math.abs(my - d.y0) > (d.kind === 'clipGain' ? 1 : 3))) d.moved = true;
      if (!d.moved) return;
      const t = this.t(mx);
      if (mx > this.w - 30) this.scrollX += 4 / this.pps * 4;
      if (mx < 30 && this.scrollX > 0) this.scrollX = Math.max(0, this.scrollX - 16 / this.pps);

      if (d.kind === 'env') {
        const pts = d.points, i = d.idx, c = d.clip;
        const lo = i > 0 ? pts[i - 1].time + 0.001 : c.offset, hi = i < pts.length - 1 ? pts[i + 1].time - 0.001 : c.offset + c.duration;
        pts[i] = { time: clamp(c.offset + (t - c.start), lo, hi), value: this.envV(my, d.rect) };
        d.clip = { ...c, envelope: pts };
        this.envPreview = d.clip;
        this.dirty = true;
        return;
      }
      if (d.kind === 'auto') {
        const pts = d.points, i = d.idx;
        const lo = i > 0 ? pts[i - 1].time + 0.001 : 0, hi = i < pts.length - 1 ? pts[i + 1].time - 0.001 : Infinity;
        pts[i] = { time: clamp(t, lo, hi), value: this.autoV(my, d.trackIndex, d.param) };
        this.dirty = true;
        return;
      }
      if (d.kind === 'range') {
        const a = Math.max(0, d.t0), b = Math.max(0, t);
        this.app.selection.range = { start: Math.min(a, b), end: Math.max(a, b) };
      } else if (d.kind === 'clip') {
        let delta = t - d.t0;
        const o = d.originals.get(d.clip.id);
        // Snap whichever edge of the grabbed clip lands nearest a target.
        const sStart = this.snap(o.start + delta, d.targets, e), sEnd = this.snap(o.start + o.duration + delta, d.targets, e);
        if (sStart.snapped !== null && (sEnd.snapped === null || Math.abs(sStart.t - (o.start + delta)) <= Math.abs(sEnd.t - (o.start + o.duration + delta)))) delta = sStart.t - o.start;
        else if (sEnd.snapped !== null) delta = sEnd.t - o.start - o.duration;
        let minStart = Infinity; for (const v of d.originals.values()) minStart = Math.min(minStart, v.start);
        delta = Math.max(delta, -minStart);
        this.snapLine = sStart.snapped ?? sEnd.snapped;
        const { index } = this.trackAt(my);
        const tIdx = clamp(index, 0, this.project.tracks.length - 1);
        d.preview.clear();
        for (const [id, v] of d.originals) {
          const p = { start: v.start + delta };
          if (d.ids.size === 1 && tIdx !== d.trackIndex) p.trackId = this.project.tracks[tIdx].id;
          d.preview.set(id, p);
        }
      } else if (d.kind === 'trimL') {
        const o = d.originals.get(d.clip.id);
        let { t: nt, snapped } = this.snap(t, d.targets, e);
        this.snapLine = snapped;
        nt = clamp(nt, Math.max(0, o.start - o.offset / (o.rate || 1)), o.start + o.duration - 0.01);
        const dd = nt - o.start;
        d.preview.set(o.id, { start: nt, offset: o.offset + dd * (o.rate || 1), duration: o.duration - dd, fadeIn: Math.min(o.fadeIn, o.duration - dd) });
      } else if (d.kind === 'trimR') {
        const o = d.originals.get(d.clip.id);
        let { t: nt, snapped } = this.snap(t, d.targets, e);
        this.snapLine = snapped;
        const maxEnd = o.loop ? Infinity : o.start + (d.asset ? (d.asset.duration - o.offset) / (o.rate || 1) : o.duration);
        nt = clamp(nt, o.start + 0.01, maxEnd);
        d.preview.set(o.id, { duration: nt - o.start, fadeOut: Math.min(o.fadeOut, nt - o.start) });
      } else if (d.kind === 'clipGain') {
        const o = d.originals.get(d.clip.id);
        d.preview.set(o.id, { gain: clamp(Math.round((o.gain + (d.y0 - my) * (e.shiftKey ? 0.05 : 0.25)) * 10) / 10, -60, 24) });
        this.gainLabel = { id: o.id };
      } else if (d.kind === 'fadeIn') {
        const o = d.originals.get(d.clip.id);
        d.preview.set(o.id, { fadeIn: clamp(t - o.start, 0, o.duration - o.fadeOut) });
      } else if (d.kind === 'fadeOut') {
        const o = d.originals.get(d.clip.id);
        d.preview.set(o.id, { fadeOut: clamp(o.start + o.duration - t, 0, o.duration - o.fadeIn) });
      }
      this.dirty = true;
    });

    window.addEventListener('pointerup', (e) => {
      touches.delete(e.pointerId);
      if (this.touchPan) {
        const tp = this.touchPan;
        if (!tp.pinch && !tp.moved) this.app.player.seek(Math.max(0, this.t(tp.mx)));
        if (!touches.size) this.touchPan = null;
        return;
      }
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      this.snapLine = null;
      this.canvas.style.cursor = 'default';
      if (d.kind === 'env') {
        if (!d.moved) return;
        this.app.op('clip.envelope', { clipId: d.clip.id, points: d.points.map((p) => ({ time: Math.round(p.time * 1e4) / 1e4, value: p.value })) }, 'Edited clip volume envelope').finally(() => { this.envPreview = null; this.dirty = true; });
        return;
      }
      if (d.kind === 'auto') {
        if (!d.moved) return;
        this.pendingAuto = d;
        this.app.op('automation.set', { trackId: d.autoTrack, param: d.param, points: d.points.map((p) => ({ time: Math.round(p.time * 1e4) / 1e4, value: p.value })) }, `Edited ${d.param} automation`).finally(() => { this.pendingAuto = null; this.dirty = true; });
        return;
      }
      if (d.kind === 'range') {
        if (!d.moved) { this.app.selection.range = null; this.app.player.seek(d.t0); if (!e.shiftKey) this.app.select({ trackId: d.trackId || this.app.selection.trackId }); }
        else this.app.emitSelection();
        this.dirty = true;
        return;
      }
      if (!d.moved) { this.dirty = true; return; }
      const ops = [];
      for (const [id, p] of d.preview) {
        const args = {};
        const o = d.originals.get(id);
        for (const k of Object.keys(p)) if (k === 'trackId' ? p[k] !== o.trackId : Math.abs(p[k] - o[k]) > 1e-9) args[k] = k === 'trackId' ? p[k] : Math.round(p[k] * 1e6) / 1e6;
        if (!Object.keys(args).length) continue;
        if (d.copy) ops.push({ op: 'clip.duplicate', args: { clipId: id, start: args.start ?? o.start, ...(args.trackId ? { trackId: args.trackId } : {}) } });
        else ops.push({ op: 'clip.update', args: { clipId: id, ...args } });
      }
      // Keep the preview until the server echo arrives so nothing jumps back.
      this.pending = d;
      if (ops.length) {
        this.gainLabel = null;
        const label = d.copy ? 'Copied clip' : { clipGain: 'Changed clip gain', clip: d.ids.size > 1 ? `Moved ${d.ids.size} clips` : 'Moved clip', trimL: 'Trimmed clip start', trimR: 'Trimmed clip end', fadeIn: 'Changed fade-in', fadeOut: 'Changed fade-out' }[d.kind];
        this.app.ops(ops, label).finally(() => { this.pending = null; this.dirty = true; });
      } else this.pending = null;
      this.dirty = true;
    });

    c.addEventListener('dblclick', (e) => {
      const [mx, my] = pos(e);
      const h = this.hit(mx, my);
      if (h.zone === 'envPoint') {
        this.app.op('clip.envelope', { clipId: h.clip.id, points: (h.clip.envelope || []).filter((_, i) => i !== h.point) }, 'Deleted envelope point');
        return;
      }
      if (h.zone === 'autoPoint') {
        const pm = this.param(h.track);
        const pts = (h.track.automation?.[pm] || []).filter((_, i) => i !== h.point);
        this.app.op('automation.set', { trackId: h.track.id, param: pm, points: pts }, 'Deleted automation point');
        return;
      }
      if (h.clip) this.app.openEditor(h.clip.id);
    });

    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const [mx, my] = pos(e);
      const h = this.hit(mx, my);
      if (h.clip) {
        if (!this.app.selection.clipIds.has(h.clip.id)) this.app.select({ clipIds: new Set([h.clip.id]), trackId: h.track.id });
        this.app.clipMenu(e.clientX, e.clientY, h.clip, this.t(mx));
      } else if (my > RULER_H) {
        this.app.laneMenu(e.clientX, e.clientY, h.track, this.t(mx));
      }
    });

    // Drag & drop: assets from the bin, or files from the OS.
    c.addEventListener('dragover', (e) => {
      e.preventDefault();
      const [mx, my] = pos(e);
      this.dropHint = { t: Math.max(0, this.t(mx)), index: this.trackAt(my).index };
      this.dirty = true;
    });
    c.addEventListener('dragleave', () => { this.dropHint = null; this.dirty = true; });
    c.addEventListener('drop', (e) => {
      e.preventDefault();
      const [mx, my] = pos(e);
      this.dropHint = null;
      const t = Math.max(0, this.t(mx));
      const { track } = this.trackAt(my);
      const assetId = e.dataTransfer.getData('application/x-klang-asset');
      if (assetId) this.app.placeAsset(assetId, track?.id, t);
      else if (e.dataTransfer.files.length) this.app.importFiles([...e.dataTransfer.files], { trackId: track?.id, start: t });
      this.dirty = true;
    });
  }

  zoomBy(f) {
    const center = this.t(this.w / 2);
    this.pps = clamp(this.pps * f, MIN_PPS, MAX_PPS);
    this.scrollX = Math.max(0, center - this.w / 2 / this.pps);
    this.dirty = true;
  }
  zoomFit() {
    if (!this.w) { this.fitPending = true; return; }
    const end = Math.max(5, projectEnd(this.project));
    this.pps = clamp((this.w - 40) / end, MIN_PPS, MAX_PPS);
    this.scrollX = 0;
    this.dirty = true;
  }
  reveal(t) {
    if (this.x(t) < 0 || this.x(t) > this.w - 20) { this.scrollX = Math.max(0, t - (this.w * 0.2) / this.pps); this.dirty = true; }
  }

  // ── drawing ───────────────────────────────────────────────────────────
  frame() {
    if (!this.ctx || !this.project) return;
    const playing = this.app.player.playing;
    if (playing) {
      const p = this.app.player.position;
      if (this.x(p) > this.w * 0.92 && !this.drag) { this.scrollX = p - (this.w * 0.08) / this.pps; }
      this.updateMeters();
    }
    if (!this.dirty && !playing && !this.app.hasRecentAgentEdits()) return;
    this.dirty = false;
    this.draw();
  }

  draw() {
    const g = this.ctx, W = this.w, H = this.h, p = this.project;
    const sel = this.app.selection;
    g.clearRect(0, 0, W, H);

    // lanes
    p.tracks.forEach((t, i) => {
      const y = this.trackY(i);
      if (y > H || y + this.trackH < RULER_H) return;
      g.fillStyle = sel.trackId === t.id ? T('cv-lane-sel') : i % 2 ? T('cv-lane-b') : T('cv-lane-a');
      g.fillRect(0, y, W, this.trackH);
      if (t.kind === 'bus') {
        g.save(); g.beginPath(); g.rect(0, y, W, this.trackH); g.clip();
        g.strokeStyle = T('cv-bus-stripe'); g.lineWidth = 6;
        for (let x = -this.trackH; x < W; x += 18) { g.beginPath(); g.moveTo(x, y + this.trackH); g.lineTo(x + this.trackH, y); g.stroke(); }
        const feeds = p.tracks.filter((x) => x.output === t.id || (x.sends || []).some((s) => s.busId === t.id)).map((x) => x.name);
        g.fillStyle = T('cv-bus-text'); g.font = '500 12px Instrument Sans';
        g.fillText(feeds.length ? `Bus · receives ${feeds.join(', ')}` : 'Bus · route tracks here with Output or a send (track inspector)', 12, y + this.trackH / 2 + 4);
        g.restore();
      }
      g.fillStyle = T('cv-lane-line');
      g.fillRect(0, y + this.trackH - 1, W, 1);
    });

    this.drawGrid(g, W, H);

    // range selection (behind clips)
    if (sel.range) {
      const x0 = this.x(sel.range.start), x1 = this.x(sel.range.end);
      g.fillStyle = T('amber', 0.10);
      g.fillRect(x0, RULER_H, x1 - x0, H);
    }

    // clips
    const d = this.drag || this.pending;
    const preview = d && !d.copy ? d.preview : null;
    const moved = [];
    p.tracks.forEach((t, i) => {
      // Lower clips first so the upper (higher z) one is drawn on top, as it is heard.
      const order = [...t.clips].sort((a, b) => (a.z || 0) - (b.z || 0) || a.start - b.start);
      for (const c0 of order) {
        const o = preview?.get(c0.id);
        if (o?.trackId && o.trackId !== t.id) { moved.push({ c: { ...c0, ...o }, t: p.tracks.find((x) => x.id === o.trackId) }); continue; }
        this.drawClip(g, o ? { ...c0, ...o } : c0, t, i);
      }
    });
    for (const { c, t } of moved) this.drawClip(g, c, t, p.tracks.indexOf(t));
    if (this.drag?.copy) {
      for (const [id, o] of this.drag.preview) {
        const v = this.drag.originals.get(id);
        const t = p.tracks.find((x) => x.id === (o.trackId || v.trackId));
        this.drawClip(g, { ...v, ...o, id: 'copy' }, t, p.tracks.indexOf(t), true);
      }
    }

    // markers
    for (const m of p.markers) {
      const x = this.x(m.time);
      if (m.duration) { g.fillStyle = T('agent', 0.08); g.fillRect(x, RULER_H, m.duration * this.pps, H); }
      g.strokeStyle = T('agent', 0.55); g.setLineDash([3, 4]);
      g.beginPath(); g.moveTo(x + 0.5, RULER_H); g.lineTo(x + 0.5, H); g.stroke(); g.setLineDash([]);
    }

    p.tracks.forEach((t, i) => { if (this.app.autoVisible.has(t.id)) this.drawAutomation(g, t, i, W); });

    if (this.dropHint) {
      const x = this.x(this.dropHint.t);
      const idx = clamp(this.dropHint.index, 0, p.tracks.length);
      const y = this.trackY(idx);
      g.fillStyle = T('amber', 0.18);
      g.fillRect(x, y + 4, 120, this.trackH - 8);
      g.fillStyle = T('amber'); g.fillRect(x, y + 4, 2, this.trackH - 8);
      if (idx >= p.tracks.length) { g.font = '500 12px Instrument Sans'; g.fillText('New track', x + 8, y + 24); }
    }

    if (this.snapLine !== null && this.snapLine !== undefined) {
      const x = this.x(this.snapLine);
      g.fillStyle = T('cv-auto-pan'); g.fillRect(x - 0.5, RULER_H, 1, H);
    }

    this.drawRuler(g, W);

    // playhead
    const ph = this.x(this.app.player.position);
    if (ph >= -2 && ph <= W + 2) {
      g.fillStyle = T('cv-ink');
      g.fillRect(Math.round(ph) - 0.5, RULER_H - 6, 1.5, H);
      g.beginPath(); g.moveTo(ph - 6, RULER_H - 12); g.lineTo(ph + 6, RULER_H - 12); g.lineTo(ph, RULER_H - 4); g.closePath(); g.fill();
    }
    if (this.hoverX != null && !this.drag && this.hover?.zone !== 'clip') {
      g.fillStyle = T('cv-ink', 0.18); g.fillRect(this.hoverX, RULER_H, 1, H);
    }

    const showEmpty = p.tracks.length === 0 || p.tracks.every((t) => t.clips.length === 0);
    this.empty.style.display = showEmpty ? '' : 'none';
    if (showEmpty) this.empty.textContent = p.assets.length ? 'Drag a file from the bin onto the timeline, or drop audio files here.' : 'Drop audio files here to start, or connect an agent and let it work.';
  }

  drawAutomation(g, t, i, W) {
    const pending = this.pendingAuto?.autoTrack === t.id ? this.pendingAuto.points : null;
    const pts = pending || this.autoPoints(t);
    const pm = this.param(t);
    const Y = (v) => this.autoY(v, i, pm);
    const y0 = this.trackY(i);
    if (y0 > this.h || y0 + this.trackH < RULER_H) return;
    g.save();
    g.beginPath(); g.rect(0, y0, W, this.trackH); g.clip();
    g.font = '600 10px Instrument Sans'; g.fillStyle = pm === 'pan' ? T('cv-auto-pan') : T('cv-auto-vol');
    const sp = this.autoSpec(t, pm);
    g.textAlign = 'right'; g.fillText(sp.label, W - 10, y0 + 26); g.textAlign = 'left';
    g.fillStyle = T('cv-auto-dim'); g.fillRect(0, y0 + 14, W, this.trackH - 14);
    g.strokeStyle = T('cv-auto-zero'); g.setLineDash([2, 4]);
    const zy = Y(this.autoSpec(t, pm).neutral); g.beginPath(); g.moveTo(0, zy); g.lineTo(W, zy); g.stroke(); g.setLineDash([]);
    const col = pm === 'pan' ? T('cv-auto-pan') : pm.startsWith('fx:') ? T('cv-auto-fx') : T('cv-auto-vol');
    g.strokeStyle = col; g.lineWidth = 1.5; g.beginPath();
    if (!pts.length) { g.moveTo(0, zy); g.lineTo(W, zy); }
    else {
      g.moveTo(0, Y(pts[0].value));
      for (const p of pts) g.lineTo(this.x(p.time), Y(p.value));
      g.lineTo(W, Y(pts[pts.length - 1].value));
    }
    g.stroke();
    g.fillStyle = col;
    for (const p of pts) { const x = this.x(p.time); if (x < -5 || x > W + 5) continue; g.beginPath(); g.arc(x, Y(p.value), 3.5, 0, Math.PI * 2); g.fill(); }
    if (this.drag?.kind === 'auto' && this.drag.autoTrack === t.id) {
      const p = this.drag.points[this.drag.idx];
      g.font = '600 11px Instrument Sans'; g.fillStyle = T('cv-ink');
      g.fillText(`${sp.fmt(p.value)}  ${fmtTime(p.time, 2)}`, this.x(p.time) + 8, Y(p.value) - 8);
    }
    g.restore();
  }

  drawGrid(g, W, H) {
    const step = STEPS.find((s) => s * this.pps >= 80) || 1200;
    const t0 = Math.floor(this.scrollX / step) * step;
    g.fillStyle = T('cv-grid');
    for (let t = t0; this.x(t) < W; t += step) g.fillRect(Math.round(this.x(t)), RULER_H, 1, H);
  }

  drawRuler(g, W) {
    g.fillStyle = T('cv-ruler');
    g.fillRect(0, 0, W, RULER_H);
    const sel = this.app.selection;
    const loop = this.app.player.loop;
    if (loop.on && loop.end > loop.start) {
      g.fillStyle = T('cv-auto-pan', 0.35);
      g.fillRect(this.x(loop.start), 0, (loop.end - loop.start) * this.pps, 6);
    }
    if (sel.range) {
      g.fillStyle = T('amber', 0.35);
      g.fillRect(this.x(sel.range.start), RULER_H - 8, (sel.range.end - sel.range.start) * this.pps, 8);
    }
    const step = STEPS.find((s) => s * this.pps >= 80) || 1200;
    const minor = step / (step >= 1 && step % 5 === 0 ? 5 : step === 2 || step === 0.5 ? 4 : 5);
    g.fillStyle = T('cv-tick-minor');
    for (let t = Math.floor(this.scrollX / minor) * minor; this.x(t) < W; t += minor) g.fillRect(Math.round(this.x(t)), RULER_H - 5, 1, 5);
    g.font = '500 11px Instrument Sans';
    g.fillStyle = T('cv-tick');
    for (let t = Math.floor(this.scrollX / step) * step; this.x(t) < W; t += step) {
      const x = Math.round(this.x(t));
      g.fillRect(x, RULER_H - 12, 1, 12);
      g.fillText(fmtTime(t, step < 1 ? (step < 0.01 ? 3 : step < 0.1 ? 2 : 1) : 0), x + 4, 13);
    }
    for (const m of this.project.markers) {
      const x = this.x(m.time);
      g.fillStyle = T('agent');
      g.beginPath(); g.moveTo(x, 16); g.lineTo(x + 7, 16); g.lineTo(x + 7, 24); g.lineTo(x, 28); g.closePath(); g.fill();
      if (m.label) { g.fillStyle = T('cv-marker-text'); g.font = '500 11px Instrument Sans'; g.fillText(m.label.slice(0, 40), x + 10, 26); }
    }
    g.fillStyle = T('cv-lane-line'); g.fillRect(0, RULER_H - 1, W, 1);
  }

  drawClip(g, c, track, ti, ghost = false) {
    const r = this.clipRect(c, ti);
    if (r.x > this.w || r.x + r.w < 0 || r.y > this.h || r.y + r.h < RULER_H) return;
    const sel = this.app.selection.clipIds.has(c.id);
    const color = track.color;
    const agentGlow = this.app.agentGlow(c.id);
    g.save();
    g.globalAlpha = ghost ? 0.35 : 1;
    g.beginPath(); g.roundRect(r.x, r.y, Math.max(r.w, 2), r.h, 5);
    if (T('cv-clip-base')) { g.fillStyle = T('cv-clip-base'); g.fill(); }
    g.fillStyle = hexA(color, sel ? 0.26 : 0.16); g.fill();
    g.clip();

    // waveform
    const asset = this.project.assets.find((a) => a.id === c.assetId);
    const peaks = this.app.peaksFor(c.assetId);
    const mid = r.y + 14 + (r.h - 14) / 2, amp = (r.h - 18) / 2;
    const vis0 = Math.max(r.x, 0), vis1 = Math.min(r.x + r.w, this.w);
    const gain = dbToGain(c.gain || 0);
    const buf = this.app.player.buffers.get(c.assetId);
    if (buf && peaks && this.pps > (peaks.sr / peaks.block) * 1.5) {
      // Deep zoom: draw real samples from the decoded buffer.
      const chs = Array.from({ length: buf.numberOfChannels }, (_, k) => buf.getChannelData(k));
      const sr = buf.sampleRate, spp = sr / this.pps;
      g.strokeStyle = trackInk(color, 0.95); g.fillStyle = trackInk(color, 0.95); g.lineWidth = 1.2;
      const rt = c.rate || 1;
      const sAt = (px) => (c.offset + ((px - r.x) / this.pps) * rt) * sr;
      if (spp < 1) {
        g.beginPath();
        const i0 = Math.max(0, Math.floor(sAt(vis0)) - 1), i1 = Math.min(chs[0].length - 1, Math.ceil(sAt(vis1)) + 1);
        for (let i = i0; i <= i1; i++) {
          let v = 0; for (const ch of chs) v += ch[i]; v /= chs.length;
          const t = c.start + (i / sr - c.offset) / rt;
          const x = r.x + ((i / sr - c.offset) / rt) * this.pps, y = mid - clamp(v * clipGainAt(c, t), -1, 1) * amp;
          i === i0 ? g.moveTo(x, y) : g.lineTo(x, y);
          if (1 / spp > 6) g.fillRect(x - 1.5, y - 1.5, 3, 3);
        }
        g.stroke();
      } else {
        for (let px = Math.floor(vis0); px < vis1; px++) {
          const i0 = Math.max(0, Math.floor(sAt(px))), i1 = Math.min(chs[0].length, Math.ceil(sAt(px + 1)));
          let mn = 0, mx = 0;
          for (const ch of chs) for (let i = i0; i < i1; i++) { if (ch[i] < mn) mn = ch[i]; if (ch[i] > mx) mx = ch[i]; }
          const env = clipGainAt(c, c.start + (px - r.x) / this.pps);
          const top = mid - Math.min(1, mx * env) * amp, bot = mid - Math.max(-1, mn * env) * amp;
          g.fillRect(px, top, 1, Math.max(1, bot - top));
        }
      }
    } else if (peaks && asset) {
      const { block, data, sr } = peaks;
      const blocksPerSec = sr / block;
      g.fillStyle = trackInk(color, 0.92);
      for (let px = Math.floor(vis0); px < vis1; px++) {
        const tl = (px - r.x) / this.pps, tr = (px + 1 - r.x) / this.pps;
        const rr = c.rate || 1;
        const wrap = (x) => (c.loop && c.loopLength ? x % c.loopLength : x);
        const b0 = Math.floor((c.offset + wrap(tl * rr)) * blocksPerSec), b1 = Math.max(b0 + 1, Math.ceil((c.offset + wrap(tl * rr) + (tr - tl) * rr) * blocksPerSec));
        let mn = 0, mx = 0;
        for (let b = b0; b < b1 && b * 2 + 1 < data.length; b++) { if (data[b * 2] < mn) mn = data[b * 2]; if (data[b * 2 + 1] > mx) mx = data[b * 2 + 1]; }
        const tm = c.start + (tl + tr) / 2;
        const env = clipGainAt(c, tm);
        const top = mid - Math.min(1, (mx / 127) * env) * amp, bot = mid - Math.max(-1, (mn / 127) * env) * amp;
        g.fillRect(px, top, 1, Math.max(1, bot - top));
      }
    } else {
      g.fillStyle = trackInk(color, 0.4);
      g.fillRect(vis0, mid - 0.5, vis1 - vis0, 1);
    }

    // fades
    const fiW = c.fadeIn * this.pps, foW = c.fadeOut * this.pps;
    g.fillStyle = T('cv-wash', 0.45);
    if (fiW > 0) { g.beginPath(); g.moveTo(r.x, r.y); g.lineTo(r.x + fiW, r.y + 14); g.lineTo(r.x, r.y + r.h); g.closePath(); g.fill(); }
    if (foW > 0) { g.beginPath(); g.moveTo(r.x + r.w, r.y); g.lineTo(r.x + r.w - foW, r.y + 14); g.lineTo(r.x + r.w, r.y + r.h); g.closePath(); g.fill(); }
    g.strokeStyle = T('cv-ink', 0.7); g.lineWidth = 1;
    const curve = (x0, w, shape, rising) => {
      const fn = FADE_SHAPES[shape] || FADE_SHAPES.linear, top = r.y + 14, bot = r.y + r.h;
      g.beginPath();
      for (let k = 0; k <= 20; k++) { const x = k / 20, v = fn(rising ? x : 1 - x); const px = x0 + x * w, py = bot - v * (bot - top); k ? g.lineTo(px, py) : g.moveTo(px, py); }
      g.stroke();
    };
    if (fiW > 0) curve(r.x, fiW, c.fadeInShape, true);
    if (foW > 0) curve(r.x + r.w - foW, foW, c.fadeOutShape, false);

    // title strip
    g.fillStyle = hexA(color, sel ? 0.55 : 0.32);
    g.fillRect(r.x, r.y, r.w, 14);
    if (r.w > 30) {
      g.fillStyle = T('cv-ink'); g.font = '600 10.5px Instrument Sans';
      const showKnob = (sel || this.hover?.clip?.id === c.id) && r.w > 90;
      const label = c.name + (c.rate && c.rate !== 1 ? `  ×${+c.rate.toFixed(3)}` : '') + (c.gain && !showKnob ? `  ${c.gain > 0 ? '+' : ''}${c.gain.toFixed(1)} dB` : '');
      g.fillText(label, Math.max(r.x, 0) + 6, r.y + 10.5, Math.max(10, r.w - 26));
    }
    // clip markers (move with the clip)
    for (const m of c.markers || []) {
      const x = r.x + ((m.time - c.offset) / (c.rate || 1)) * this.pps;
      if (x < r.x || x > r.x + r.w) continue;
      g.fillStyle = T('agent'); g.fillRect(x - 0.5, r.y + 14, 1.5, r.h - 14);
      g.beginPath(); g.moveTo(x, r.y + 14); g.lineTo(x + 6, r.y + 17); g.lineTo(x, r.y + 20); g.closePath(); g.fill();
      if (m.label && r.w > 60) { g.font = '600 10px Instrument Sans'; g.fillText(m.label.slice(0, 24), x + 8, r.y + 24); }
    }
    // looping clips: tick at each repeat
    if (c.loop && c.loopLength > 0) {
      g.strokeStyle = T('cv-ink', 0.35); g.setLineDash([2, 3]);
      for (let k = 1; k * c.loopLength < c.duration; k++) { const x = r.x + k * c.loopLength * this.pps; g.beginPath(); g.moveTo(x, r.y + 14); g.lineTo(x, r.y + r.h); g.stroke(); }
      g.setLineDash([]);
    }
    // clip volume envelope (thin line, dB scale around the clip's middle)
    if (this.envPreview?.id === c.id) c = this.envPreview;
    const editing = this.app.envClip === c.id;
    if (editing && !c.envelope?.length) c = { ...c, envelope: [] };
    if (editing) { g.fillStyle = T('cv-wash', 0.35); g.fillRect(r.x, r.y + 14, r.w, r.h - 14); }
    if (c.envelope?.length || editing) {
      g.strokeStyle = T('cv-ink', 0.75); g.lineWidth = 1.2; g.beginPath();
      const ey = (db) => r.y + 14 + (r.h - 14) * (0.5 - clamp(db, -30, 12) / 60);
      for (let px = Math.max(r.x, 0), k = 0; px <= Math.min(r.x + r.w, this.w); px += 3, k++) {
        const t = c.start + (px - r.x) / this.pps;
        const v = c.envelope.length ? automationAt(c.envelope, c.offset + (t - c.start), 0) : 0;
        k ? g.lineTo(px, ey(v)) : g.moveTo(px, ey(v));
      }
      g.stroke();
      g.fillStyle = T('cv-ink');
      for (const pt of c.envelope) { const px = r.x + (pt.time - c.offset) * this.pps; if (px >= r.x && px <= r.x + r.w) { g.beginPath(); g.arc(px, ey(pt.value), 2.5, 0, Math.PI * 2); g.fill(); } }
    }
    // clip gain handle (drag up/down; Shift for fine)
    if ((sel || this.hover?.clip?.id === c.id) && r.w > 90) {
      const gx = r.x + r.w - 31;
      g.fillStyle = T('cv-wash', 0.6); g.beginPath(); g.roundRect(gx - 19, r.y + 1.5, 38, 11, 3); g.fill();
      g.fillStyle = T('cv-ink'); g.font = '600 9.5px Instrument Sans'; g.textAlign = 'center';
      g.fillText(`${c.gain > 0 ? '+' : ''}${(c.gain || 0).toFixed(1)}`, gx, r.y + 10.5); g.textAlign = 'left';
    }
    // fade handles (shown on hover/selection)
    if (sel || this.hover?.clip?.id === c.id) {
      g.fillStyle = T('cv-ink');
      g.fillRect(r.x + fiW - 3, r.y + 1, 6, 6);
      g.fillRect(r.x + r.w - foW - 3, r.y + 1, 6, 6);
    }
    g.restore();

    // outline
    g.save();
    g.beginPath(); g.roundRect(r.x + 0.5, r.y + 0.5, Math.max(r.w - 1, 1), r.h - 1, 5);
    if (agentGlow > 0) {
      g.shadowColor = T('agent'); g.shadowBlur = 14 * agentGlow;
      g.strokeStyle = T('agent', 0.5 + 0.5 * agentGlow); g.lineWidth = 2;
    } else {
      g.strokeStyle = sel ? T('cv-ink') : trackInk(color, 0.55); g.lineWidth = sel ? 1.5 : 1;
    }
    g.stroke();
    g.restore();
  }
}

export { HEADER_W };
