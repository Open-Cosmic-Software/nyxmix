// Video panel: the session's reference picture, kept in sync with the timeline playhead
// (Audition's video panel). Muted — sound comes from the timeline. Can float over the editor.
import { getToken, actor } from './api.js';
import { el, fmtTime, clamp, toast } from './ui.js';

const DRIFT_OK = 0.04;     // seconds the picture may lag or lead before we correct
const DRIFT_SEEK = 0.5;    // beyond this a hard seek is cheaper than catching up
const STRIP_H = 56;

const authHeaders = (extra = {}) => {
  const h = { 'X-Actor': actor(), ...extra };
  const t = getToken();
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
};
const withToken = (url) => (getToken() ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(getToken())}` : url);

async function call(method, url, body, headers) {
  const res = await fetch(url, { method, headers: authHeaders(headers), body });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw Object.assign(new Error(j.error?.message || res.statusText), { status: res.status, code: j.error?.code });
  }
  return res.status === 204 ? null : res.json();
}

export class VideoView {
  constructor(app) {
    this.app = app;
    this.label = 'Video';
    this.meta = undefined;   // undefined = not loaded, null = no video
    this.pid = null;
    this.floating = false;
    this.busy = null;
    this.video = el('video', { class: 'vid-el', muted: true, playsInline: true, preload: 'auto', disablePictureInPicture: true });
    this.video.muted = true;
    this.video.addEventListener('loadeddata', () => (this.stripDirty = true));
    this.gap = el('div', { class: 'vid-gap', hidden: true }, 'No picture here');
    this.stage = el('div', { class: 'vid-stage' }, [this.video, this.gap]);
    this.strip = el('canvas', { class: 'vid-strip', height: STRIP_H, title: 'Filmstrip on the timeline. Click to move the playhead.' });
    this.strip.addEventListener('click', (e) => this.stripClick(e));
    this.stripImg = new Image();
    this.stripImg.onload = () => (this.stripDirty = true);
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
    app.player?.addEventListener?.('state', () => (this.resync = true));
  }

  shown() { return !!this.box?.isConnected && this.app.dockOpen && this.app.dockTab === 'video'; }
  rerender() { if (this.shown()) this.render(this.box); }

  // ── data ───────────────────────────────────────────────────────────────
  base() { return `/api/projects/${this.app.pid}/video`; }
  async ensure() {
    if (!this.app.pid || this.pid === this.app.pid) return;
    this.pid = this.app.pid;
    try { this.setMeta(await call('GET', `${this.base()}?optional=1`)); } catch (e) { if (e.status === 404) this.setMeta(null); else this.app.fail(e); }
  }
  setMeta(v) {
    const changed = (v?.videoId || null) !== (this.meta?.videoId || null);
    this.meta = v || null;
    if (changed) {
      if (v) {
        this.video.src = withToken(`${this.base()}/proxy?v=${v.videoId}`);
        this.index = null;
        call('GET', `${this.base()}/filmstrip.json`).then((ix) => { this.index = ix; this.stripDirty = true; }).catch(() => {});
        this.stripImg.src = withToken(`${this.base()}/filmstrip.jpg?v=${v.videoId}`);
      } else {
        this.video.removeAttribute('src'); this.video.load();
        this.index = null;
        if (this.floating) this.dockBack();
      }
    }
    this.resync = true; this.stripDirty = true;
    this.rerender();
    this.updateOffsetField();
  }
  onLive(m) {
    if (m.type === 'hello') { this.pid = null; this.ensure(); }
    if (m.type === 'video') this.setMeta(m.video);
  }

  async setOffset(off) {
    off = Math.max(0, Math.round(off * 1000) / 1000);
    if (!this.meta) return;
    this.meta = { ...this.meta, offset: off };
    this.updateOffsetField(); this.resync = true; this.stripDirty = true;
    clearTimeout(this.offTimer);
    this.offTimer = setTimeout(() => call('PATCH', this.base(), JSON.stringify({ offset: off }), { 'Content-Type': 'application/json' }).catch((e) => this.app.fail(e)), 250);
  }

  async importFile(file, place) {
    if (!file) return;
    this.busy = `Uploading “${file.name}” (${(file.size / 1e6).toFixed(1)} MB) and preparing the picture…`;
    this.rerender();
    try {
      const r = await call('POST', `${this.base()}?name=${encodeURIComponent(file.name)}${place ? '&place=1' : ''}`, file, { 'Content-Type': file.type || 'application/octet-stream' });
      this.busy = null;
      this.setMeta(r);
      toast(r.audioAssetId ? (r.placed ? 'Video ready. Its sound is on the new “Video sound” track.' : 'Video ready. Its sound is in the bin.') : 'Video ready (it has no sound track).', { kind: 'ok' });
      if (r.note) toast(r.note, { kind: 'error', ms: 9000 });
    } catch (e) {
      this.busy = null;
      this.rerender();
      this.app.fail(e);
    }
  }

  async remove() {
    if (!confirm('Remove the video from this session? Its sound stays in the bin.')) return;
    try { await call('DELETE', this.base()); this.setMeta(null); } catch (e) { this.app.fail(e); }
  }

  // ── sync ───────────────────────────────────────────────────────────────
  loop() {
    requestAnimationFrame(this.loop);
    const v = this.meta, vid = this.video, player = this.app.player;
    if (!v || !player || !vid.src || !vid.isConnected) { if (vid.src && !vid.paused) vid.pause(); return; }
    const target = player.position - v.offset;
    const inside = target >= 0 && target <= v.duration;
    this.gap.hidden = inside;
    if (vid.readyState >= 1) {
      if (player.playing && inside) {
        if (vid.paused || this.resync) {
          vid.currentTime = target; vid.playbackRate = 1;
          if (vid.paused) vid.play().catch(() => {});
        } else if (!vid.seeking) {
          const drift = vid.currentTime - target;
          if (Math.abs(drift) > DRIFT_SEEK) { vid.currentTime = target; vid.playbackRate = 1; }
          else if (Math.abs(drift) > DRIFT_OK) vid.playbackRate = clamp(1 - drift * 1.5, 0.8, 1.2); // nudge, no visible jump
          else if (vid.playbackRate !== 1 && Math.abs(drift) < DRIFT_OK / 3) vid.playbackRate = 1;
        }
      } else {
        if (!vid.paused) vid.pause();
        const t = clamp(target, 0, v.duration);
        if ((this.resync || Math.abs(vid.currentTime - t) > 0.5 / (v.fps || 25)) && !vid.seeking) vid.currentTime = t;
      }
      this.resync = false;
    }
    if (this.timecodeEl) this.timecodeEl.textContent = inside ? `Picture ${fmtTime(target, 2)}` : 'Outside the video';
    this.drawStrip();
  }

  // ── filmstrip aligned to the timeline ──────────────────────────────────
  stripGeometry() {
    const tl = this.app.timeline;
    const tc = tl?.canvas?.getBoundingClientRect?.(), sc = this.strip.getBoundingClientRect();
    return { tl, dx: tc ? tc.left - sc.left : 0, w: sc.width };
  }
  drawStrip() {
    if (!this.strip.isConnected || !this.meta) return;
    const { tl, dx, w } = this.stripGeometry();
    if (!tl) return;
    const pos = this.app.player.position;
    const key = `${tl.scrollX}|${tl.pps}|${dx}|${w}|${pos.toFixed(3)}|${this.meta.offset}`;
    if (!this.stripDirty && key === this.stripKey) return;
    this.stripKey = key; this.stripDirty = false;
    const dpr = window.devicePixelRatio || 1;
    if (this.strip.width !== Math.round(w * dpr)) { this.strip.width = Math.round(w * dpr); this.strip.height = STRIP_H * dpr; }
    const g = this.strip.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, STRIP_H);
    const v = this.meta, X = (t) => dx + tl.x(t);
    const x0 = X(v.offset), x1 = X(v.offset + v.duration);
    g.fillStyle = '#10131b'; g.fillRect(Math.max(0, x0), 0, Math.min(w, x1) - Math.max(0, x0), STRIP_H);
    const ix = this.index, img = this.stripImg;
    if (ix && img.complete && img.naturalWidth) {
      const th = STRIP_H - 8, tw = (ix.tileWidth / ix.tileHeight) * th;
      // Tile the lane with the nearest thumbnail for each slot so it reads like a film strip at any zoom.
      g.save(); g.beginPath(); g.rect(Math.max(0, x0), 0, Math.min(w, x1) - Math.max(0, x0), STRIP_H); g.clip();
      const startX = x0 + Math.max(0, Math.floor((0 - x0) / tw)) * tw;
      for (let x = startX; x < Math.min(w, x1); x += tw) {
        const t = (x + tw / 2 - x0) / tl.pps;
        const i = clamp(Math.floor(t / ix.interval), 0, ix.count - 1);
        const sx = (i % ix.cols) * ix.tileWidth, sy = Math.floor(i / ix.cols) * ix.tileHeight;
        g.drawImage(img, sx, sy, ix.tileWidth, ix.tileHeight, x, 4, tw - 1, th);
      }
      g.restore();
    }
    g.fillStyle = 'rgba(92,200,240,0.9)';
    if (x0 >= 0 && x0 <= w) g.fillRect(Math.round(x0) - 1, 0, 2, STRIP_H);
    const ph = X(pos);
    if (ph >= 0 && ph <= w) { g.fillStyle = '#f4f1e8'; g.fillRect(Math.round(ph) - 0.5, 0, 1.5, STRIP_H); }
  }
  stripClick(e) {
    const { tl, dx } = this.stripGeometry();
    const r = this.strip.getBoundingClientRect();
    const t = tl.scrollX + (e.clientX - r.left - dx) / tl.pps;
    this.app.player.seek(Math.max(0, t));
  }

  // ── floating window ────────────────────────────────────────────────────
  float() {
    if (this.floating) return;
    this.floating = true;
    const head = el('div', { class: 'vid-float-head' }, [
      el('span', { class: 'vid-float-title' }, this.meta?.name || 'Video'),
      el('button', { class: 'icon-btn', title: 'Put back in the panel', 'aria-label': 'Put back in the panel', onclick: () => this.dockBack() }, '×'),
    ]);
    this.win = el('div', { class: 'vid-float', role: 'dialog', 'aria-label': 'Video' }, [head, this.stage]);
    const saved = (() => { try { return JSON.parse(localStorage.getItem('klang.videoFloat') || 'null'); } catch { return null; } })();
    Object.assign(this.win.style, saved ? { left: `${saved.x}px`, top: `${saved.y}px`, width: `${saved.w}px` } : { right: '24px', top: '96px' });
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = this.win.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
      head.setPointerCapture(e.pointerId);
      const move = (ev) => {
        this.win.style.right = 'auto';
        this.win.style.left = `${clamp(ev.clientX - ox, 0, innerWidth - 80)}px`;
        this.win.style.top = `${clamp(ev.clientY - oy, 0, innerHeight - 40)}px`;
      };
      const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); this.savePos(); };
      head.addEventListener('pointermove', move); head.addEventListener('pointerup', up);
    });
    new ResizeObserver(() => this.savePos()).observe(this.win);
    document.body.append(this.win);
    this.resync = true;
    this.rerender();
  }
  savePos() {
    if (!this.win?.isConnected) return;
    const r = this.win.getBoundingClientRect();
    try { localStorage.setItem('klang.videoFloat', JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width) })); } catch {}
  }
  dockBack() {
    this.floating = false;
    this.win?.remove(); this.win = null;
    this.resync = true;
    this.rerender();
  }

  // ── panel ──────────────────────────────────────────────────────────────
  updateOffsetField() {
    if (this.offsetInput && this.meta && document.activeElement !== this.offsetInput) this.offsetInput.value = this.meta.offset.toFixed(3);
  }

  render(box) {
    this.box = box;
    this.ensure();
    if (this.busy) { box.replaceChildren(el('p', { class: 'muted dock-empty vid-busy' }, [el('span', { class: 'vid-spinner' }), this.busy])); return; }
    if (this.meta === undefined) { box.replaceChildren(el('p', { class: 'muted dock-empty' }, 'Loading…')); return; }
    if (!this.meta) { box.replaceChildren(this.emptyView()); return; }
    const v = this.meta, frame = 1 / (v.fps || 25);
    this.offsetInput = el('input', { class: 'input num vid-offset', type: 'number', step: 0.001, min: 0, value: v.offset.toFixed(3), 'aria-label': 'Video offset in seconds', onchange: (e) => { const n = +e.target.value; if (Number.isFinite(n)) this.setOffset(n); } });
    const nudge = (d, label, title) => el('button', { class: 'btn small vid-nudge', title, onclick: () => this.setOffset(this.meta.offset + d) }, label);
    this.timecodeEl = el('span', { class: 'vid-tc' });
    const side = el('div', { class: 'vid-side' }, [
      el('div', { class: 'vid-name' }, v.name),
      el('div', { class: 'muted small' }, `${v.width}×${v.height} · ${v.fps} fps · ${fmtTime(v.duration, 2)}`),
      v.note ? el('div', { class: 'small error' }, v.note) : null,
      this.timecodeEl,
      el('h5', {}, 'Starts on the timeline at'),
      el('div', { class: 'row' }, [this.offsetInput, el('span', { class: 'muted small' }, 's')]),
      el('div', { class: 'row wrap vid-nudges' }, [
        nudge(-1, '−1 s', 'Video 1 second earlier'), nudge(-frame, '−1 frame', 'Video one frame earlier'),
        nudge(frame, '+1 frame', 'Video one frame later'), nudge(1, '+1 s', 'Video 1 second later'),
      ]),
      el('div', { class: 'row wrap vid-actions' }, [
        el('button', { class: 'btn small', title: 'Start the video at the playhead', onclick: () => this.setOffset(this.app.player.position) }, 'Start at playhead'),
        this.floating
          ? el('button', { class: 'btn small', onclick: () => this.dockBack() }, 'Put back in panel')
          : el('button', { class: 'btn small', title: 'Float the picture over the editor', onclick: () => this.float() }, 'Pop out'),
        el('button', { class: 'btn small danger subtle', onclick: () => this.remove() }, 'Remove video'),
      ]),
    ]);
    const viewer = this.floating
      ? el('div', { class: 'vid-stage vid-placeholder muted' }, 'The picture is in the floating window.')
      : this.stage;
    box.replaceChildren(el('div', { class: 'vid-panel' }, [el('div', { class: 'vid-main' }, [viewer, side]), this.strip]));
    this.stripDirty = true; this.resync = true;
  }

  emptyView() {
    const place = el('input', { type: 'checkbox', checked: true });
    const input = el('input', { type: 'file', accept: 'video/*,.mkv,.mov,.mp4,.webm,.avi,.mxf', hidden: true, onchange: (e) => this.importFile(e.target.files[0], place.checked) });
    const drop = el('div', { class: 'vid-drop' }, [
      el('div', {}, [el('strong', {}, 'Cut audio to picture'), el('div', { class: 'muted small' }, 'Add a video to see it in sync with the timeline. Its sound lands in the bin like any import.')]),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn primary', onclick: () => input.click() }, 'Import video'),
        el('label', { class: 'row small muted vid-place' }, [place, 'Put its sound on a new track']),
        input,
      ]),
    ]);
    drop.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('over'); this.importFile(e.dataTransfer.files[0], place.checked); });
    return drop;
  }
}
