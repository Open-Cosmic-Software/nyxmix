// Transcript panel: the timeline's speech as text. Click a word to jump there,
// select words (drag, shift-click, double-click, shift+arrows) and press Delete to
// cut them out of the audio, or strip all filler words at once.
import { el, fmtTime, toast, menu } from './ui.js';
import { getToken, actor, ApiError } from './api.js';

async function call(method, path, body) {
  const h = { 'X-Actor': actor() };
  const t = getToken();
  if (t) h.Authorization = `Bearer ${t}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, j.error?.code || 'http_' + res.status, j.error?.message || res.statusText);
  return j;
}

const LANGS = [['', 'Detect language'], ['en', 'English'], ['de', 'German'], ['fr', 'French'], ['es', 'Spanish'], ['it', 'Italian'], ['nl', 'Dutch'], ['pt', 'Portuguese'], ['pl', 'Polish']];
const LANG_NAMES = Object.fromEntries(LANGS.filter(([k]) => k));
const LOW = 0.5;

export class TranscriptView {
  constructor(app) {
    this.app = app;
    this.label = 'Transcript';
    this.data = null;        // timeline transcript from the server
    this.loadedKey = null;
    this.running = new Set(); // asset ids being transcribed
    this.sel = null;         // { a, b } word indices (inclusive, unordered)
    this.cursor = null;      // word index of the last click
    this.lastRange = null;   // the selection range object we pushed into the app
    this.language = '';
    this.nowIdx = -1;
    this.userScrolledAt = 0;
  }

  // Live notices about transcripts (from agents or our own jobs) refresh the panel.
  onLive(m) { if (m?.type === 'transcript') this.onNotice(m); }

  // ── data ────────────────────────────────────────────────────────────────
  base() { return `/api/projects/${this.app.pid}`; }

  async load(force) {
    const app = this.app;
    const key = `${app.pid}:${app.project.rev}`;
    if (!force && (this.loadedKey === key || this.loadingKey === key)) return;
    this.loadingKey = key;
    try {
      const data = await call('GET', `${this.base()}/transcript`);
      if (`${app.pid}:${app.project.rev}` !== key && !force) { this.loadingKey = null; return this.load(); }
      this.data = data;
      this.loadedKey = key;
      for (const j of data.running || []) this.running.add(j.assetId);
      if (!data.running?.length && this.running.size && !this.pendingStart) this.running.clear();
      this.sel = null; this.cursor = null; this.nowIdx = -1;
      this.paint();
    } catch (e) {
      if (e.status !== 404) this.app.fail(e);
    } finally { if (this.loadingKey === key) this.loadingKey = null; }
  }

  onNotice(m) {
    if (m.projectId && m.projectId !== this.app.pid) return;
    if (m.status === 'ready' || m.status === 'failed') this.running.delete(m.assetId);
    this.load(true);
  }

  get words() { return this.data?.words || []; }

  // ── render (called on every project / selection change; keep cheap) ────
  render(box) {
    const app = this.app;
    if (this.pid !== app.pid) { this.pid = app.pid; this.data = null; this.loadedKey = null; this.running.clear(); this.sel = null; }
    if (!this.root) this.build();
    if (!box.contains(this.root)) box.replaceChildren(this.root);
    this.load();
    this.syncFromAppRange();
    this.paintBar();
    this.paintSelection();
    this.startLoop();
  }

  build() {
    this.bar = el('div', { class: 'dock-bar tx-bar' });
    this.doc = el('div', { class: 'tx-doc', tabindex: '0', role: 'textbox', 'aria-readonly': 'true', 'aria-multiline': 'true', 'aria-label': 'Transcript. Select words and press Delete to cut them.' });
    this.empty = el('div', { class: 'tx-empty' });
    this.root = el('div', { class: 'tx' }, [this.bar, this.empty, this.doc]);

    const wordAt = (e) => { const w = e.target.closest?.('.w'); return w ? +w.dataset.i : null; };
    this.doc.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const i = wordAt(e);
      const time = e.target.closest?.('.tx-time');
      if (time) { e.preventDefault(); this.seek(+time.dataset.t); return; }
      if (i === null) return;
      e.preventDefault();
      this.doc.focus({ preventScroll: true });
      if (e.shiftKey && (this.cursor !== null || this.sel)) {
        this.sel = { a: this.sel?.a ?? this.cursor, b: i };
        this.commitSelection();
        return;
      }
      this.drag = { from: i, moved: false };
      const move = (ev) => {
        const j = wordAt(ev);
        if (j === null || (!this.drag.moved && j === this.drag.from)) return;
        this.drag.moved = true;
        this.sel = { a: this.drag.from, b: j };
        this.paintSelection();
      };
      const up = () => {
        removeEventListener('mouseup', up); this.doc.removeEventListener('mouseover', move);
        const d = this.drag; this.drag = null;
        if (d.moved) this.commitSelection();
        else {
          this.cursor = d.from;
          if (this.sel) { this.sel = null; this.commitSelection(); }
          this.seek(this.words[d.from].start);
        }
      };
      this.doc.addEventListener('mouseover', move);
      addEventListener('mouseup', up);
    });
    this.doc.addEventListener('dblclick', (e) => {
      const i = wordAt(e);
      if (i === null) return;
      this.sel = { a: i, b: i }; this.cursor = i;
      this.commitSelection();
    });
    this.doc.addEventListener('keydown', (e) => this.onKey(e));
    this.doc.addEventListener('wheel', () => (this.userScrolledAt = performance.now()), { passive: true });
  }

  // Text DOM: rebuilt only when the transcript itself changes (new rev / new words).
  paint() {
    const words = this.words;
    this.wordEls = [];
    if (!words.length) { this.doc.replaceChildren(); this.doc.hidden = true; this.paintEmpty(); this.paintBar(); return; }
    this.doc.hidden = false; this.empty.hidden = true;
    const p = this.app.project;
    const tracks = new Map(p.tracks.map((t) => [t.id, t]));
    const multi = new Set(words.map((w) => w.trackId)).size > 1;
    const frag = document.createDocumentFragment();
    let seg = null, body = null, prev = null;
    for (const w of words) {
      // New paragraph on a new source segment, a new speaker, or a long pause.
      if (!prev || w.seg !== prev.seg || w.trackId !== prev.trackId || w.start - prev.end > 1.5) {
        const t = tracks.get(w.trackId);
        body = el('div', { class: 'tx-words' });
        seg = el('div', { class: 'tx-seg' }, [
          el('div', { class: 'tx-meta' }, [
            el('button', { class: 'tx-time', 'data-t': String(w.start), tabindex: '-1', title: 'Jump here' }, fmtTime(w.start, 0)),
            multi && t ? el('span', { class: 'tx-track' + (prev && prev.trackId === w.trackId ? ' same' : ''), style: `--c:${t.color}`, title: t.name }, t.name) : null,
          ]),
          body,
        ]);
        frag.append(seg);
      } else body.append(' ');
      const cls = 'w' + (w.filler ? ' filler' : '') + (w.probability < LOW ? ' low' : '');
      const span = el('span', { class: cls, 'data-i': String(w.i), title: w.probability < LOW ? `Unsure (${Math.round(w.probability * 100)}%) · ${fmtTime(w.start, 2)}` : undefined }, w.word);
      this.wordEls.push(span);
      body.append(span);
      prev = w;
    }
    this.doc.replaceChildren(frag);
    this.starts = Float64Array.from(words, (w) => w.start);
    this.paintBar();
    this.paintSelection();
  }

  paintEmpty() {
    const app = this.app;
    const hasClips = app.project.tracks.some((t) => !t.mute && t.clips.length);
    this.empty.hidden = false;
    if (!this.data) { this.empty.replaceChildren(el('p', { class: 'muted' }, 'Loading transcript…')); return; }
    if (!hasClips) { this.empty.replaceChildren(el('p', { class: 'muted' }, 'Place audio on the timeline, then transcribe it here to edit speech like text.')); return; }
    const busy = this.running.size > 0;
    const lang = el('select', { class: 'input', 'aria-label': 'Spoken language', disabled: busy, onchange: (e) => (this.language = e.target.value) },
      LANGS.map(([v, l]) => el('option', { value: v, selected: v === this.language }, l)));
    this.empty.replaceChildren(
      el('div', { class: 'tx-intro' }, [
        el('h3', {}, 'Edit speech like text'),
        el('p', { class: 'muted' }, 'Transcribe the clips on the timeline, then select words and press Delete to cut them from the audio, or remove every “um” and “uh” in one step. Each cut is a normal, undoable ripple edit. Transcription runs on this server.'),
        el('div', { class: 'tx-intro-actions' }, [
          lang,
          el('button', { class: 'btn primary', disabled: busy, onclick: () => this.transcribeAll() }, busy ? 'Transcribing…' : 'Transcribe'),
          busy ? el('span', { class: 'muted small' }, 'Takes a fraction of the audio length. The first run downloads the speech model.') : null,
        ]),
      ]),
    );
  }

  paintBar() {
    if (!this.data || !this.words.length) { this.bar.hidden = true; if (this.data) this.paintEmpty(); return; }
    this.bar.hidden = false;
    const words = this.words;
    const fillers = words.filter((w) => w.filler).length;
    const sel = this.selected();
    const missing = this.data.untranscribedAssets || [];
    const busy = this.running.size > 0;
    const info = [LANG_NAMES[this.data.language] || this.data.language, `${words.length} words`].filter(Boolean).join(' · ');
    this.bar.replaceChildren(...[
      el('span', { class: 'muted small tx-info' }, [
        info,
        missing.length ? el('span', {}, [' · ', busy ? `transcribing ${this.running.size} more…` : el('button', { class: 'link', onclick: () => this.transcribeAll() }, `${missing.length} clip source${missing.length > 1 ? 's' : ''} not transcribed`)]) : null,
      ]),
      el('span', { class: 'tx-spacer' }),
      sel.length ? el('span', { class: 'small tx-selinfo' }, `${sel.length} word${sel.length > 1 ? 's' : ''} · ${(sel[sel.length - 1].end - sel[0].start).toFixed(2)} s`) : null,
      el('button', { class: 'btn', disabled: !sel.length, title: 'Delete or Backspace', onclick: () => this.cutSelection() }, 'Cut selection'),
      el('button', { class: 'btn', disabled: !fillers, onclick: () => this.removeFillers() }, `Remove filler words (${fillers})`),
      el('button', { class: 'icon-btn tx-more', title: 'More', 'aria-label': 'More transcript actions', onclick: (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        menu(r.left, r.bottom + 4, [
          { label: 'Copy transcript', action: () => this.copy(words) },
          '-',
          { label: 'Transcribe again (small model)', disabled: busy, action: () => this.transcribeAll({ force: true, model: 'small' }) },
          { label: 'Transcribe again (medium, slower, more accurate)', disabled: busy, action: () => this.transcribeAll({ force: true, model: 'medium' }) },
        ]);
      } }, '⋯'),
    ].filter(Boolean));
  }

  // ── selection ─────────────────────────────────────────────────────────
  selected() {
    if (!this.sel || !this.words.length) return [];
    const lo = Math.min(this.sel.a, this.sel.b), hi = Math.max(this.sel.a, this.sel.b);
    return this.words.slice(lo, hi + 1);
  }

  paintSelection() {
    if (!this.wordEls) return;
    const lo = this.sel ? Math.min(this.sel.a, this.sel.b) : -1, hi = this.sel ? Math.max(this.sel.a, this.sel.b) : -2;
    if (this.paintedSel && this.paintedSel[0] === lo && this.paintedSel[1] === hi && this.paintedSel[2] === this.cursor && this.paintedSel[3] === this.wordEls) return;
    const prev = this.paintedSel && this.paintedSel[3] === this.wordEls ? this.paintedSel : null;
    // Only touch the words whose state can have changed.
    const touch = new Set();
    if (prev) { for (let i = Math.max(0, prev[0]); i <= prev[1]; i++) touch.add(i); if (prev[2] !== null) touch.add(prev[2]); }
    else this.wordEls.forEach((_, i) => touch.add(i));
    for (let i = Math.max(0, lo); i <= hi; i++) touch.add(i);
    if (this.cursor !== null) touch.add(this.cursor);
    for (const i of touch) {
      const n = this.wordEls[i]; if (!n) continue;
      n.classList.toggle('sel', i >= lo && i <= hi);
      n.classList.toggle('join', i >= lo && i < hi && this.wordEls[i + 1]?.parentNode === n.parentNode);
      n.classList.toggle('cursor', i === this.cursor && hi < 0);
    }
    this.paintedSel = [lo, hi, this.cursor, this.wordEls];
  }

  commitSelection() {
    const app = this.app;
    const sel = this.selected();
    this.paintSelection();
    this.lastRange = sel.length ? { start: sel[0].start, end: Math.max(...sel.map((w) => w.end)) } : null;
    app.selection.range = this.lastRange;
    app.emitSelection();
  }

  // A range drawn on the timeline shows up as selected words here.
  syncFromAppRange() {
    const r = this.app.selection.range;
    if (r === this.lastRange || !this.words.length || this.drag) return;
    this.lastRange = r;
    if (!r) { this.sel = null; return; }
    const inside = this.words.filter((w) => (w.start + w.end) / 2 >= r.start && (w.start + w.end) / 2 <= r.end);
    this.sel = inside.length ? { a: inside[0].i, b: inside[inside.length - 1].i } : null;
  }

  onKey(e) {
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    const words = this.words;
    if (!words.length) return;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (k === 'Delete' || k === 'Backspace') { stop(); if (this.selected().length) this.cutSelection(); return; }
    if (k === 'Escape' && this.sel) { stop(); this.sel = null; this.commitSelection(); return; }
    if (mod && k.toLowerCase() === 'a') { stop(); this.sel = { a: 0, b: words.length - 1 }; this.commitSelection(); return; }
    if (mod && k.toLowerCase() === 'c' && this.sel) { stop(); this.copy(this.selected()); return; }
    if ((k === 'ArrowLeft' || k === 'ArrowRight') && !mod) {
      stop();
      const d = k === 'ArrowLeft' ? -1 : 1;
      if (e.shiftKey) {
        const a = this.sel?.a ?? this.cursor ?? this.nowIdxOr0();
        const b = Math.max(0, Math.min(words.length - 1, (this.sel ? this.sel.b + d : a)));
        this.sel = { a, b };
        this.commitSelection();
        this.wordEls[b]?.scrollIntoView({ block: 'nearest' });
      } else {
        const from = this.sel ? (d < 0 ? Math.min(this.sel.a, this.sel.b) : Math.max(this.sel.a, this.sel.b)) : this.cursor ?? this.nowIdxOr0() - d;
        const i = Math.max(0, Math.min(words.length - 1, from + (this.sel ? 0 : d)));
        this.cursor = i;
        if (this.sel) { this.sel = null; this.commitSelection(); } else this.paintSelection();
        this.seek(words[i].start);
        this.wordEls[i]?.scrollIntoView({ block: 'nearest' });
      }
    }
  }
  nowIdxOr0() { return Math.max(0, this.nowIdx); }

  seek(t) {
    this.app.player.seek(t);
    this.app.timeline.reveal(t);
    this.tick(true);
  }

  // ── edits ─────────────────────────────────────────────────────────────
  async cutSelection() {
    const sel = this.selected();
    if (!sel.length || this.cutting) return;
    this.cutting = true;
    try {
      const r = await call('POST', `${this.base()}/transcript/delete`, { words: sel.map(({ trackId, start, end }) => ({ trackId, start, end })) });
      this.afterCut(r, r.label);
    } catch (e) { this.app.fail(e); } finally { this.cutting = false; }
  }

  async removeFillers() {
    try {
      const r = await call('POST', `${this.base()}/transcript/filler`, { apply: true });
      if (!r.applied) { toast('No filler words found'); return; }
      this.afterCut(r, `${r.label} (${r.removedSeconds.toFixed(1)} s)`);
    } catch (e) { this.app.fail(e); }
  }

  afterCut(r, msg) {
    const app = this.app;
    this.sel = null; this.lastRange = null;
    app.selection.range = null;
    if (r.cut?.length) app.player.seek(r.cut[0].start);
    app.emitSelection();
    toast(`${msg}. Ctrl+Z undoes it.`, { kind: 'ok' });
    this.doc.focus({ preventScroll: true });
  }

  async transcribeAll({ force = false, model } = {}) {
    const app = this.app;
    this.pendingStart = true;
    try {
      const r = await call('POST', `${this.base()}/transcribe`, { wait: false, force, model, language: this.language || undefined });
      for (const j of r.jobs || []) this.running.add(j.assetId);
      if (!r.jobs?.length) { toast('Everything on the timeline is already transcribed'); await this.load(true); }
    } catch (e) { app.fail(e); }
    finally { this.pendingStart = false; }
    this.data ? this.paint() : this.paintEmpty();
  }

  copy(words) {
    const text = words.map((w) => w.word).join(' ');
    navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Copy failed', { kind: 'error' }));
  }

  // ── playhead follow (rAF, touches at most two words per frame) ─────────
  startLoop() {
    if (this.loop) return;
    const frame = () => {
      if (!this.root.isConnected || this.root.closest('[hidden]')) { this.loop = null; return; }
      this.tick();
      this.loop = requestAnimationFrame(frame);
    };
    this.loop = requestAnimationFrame(frame);
  }

  tick(force) {
    const starts = this.starts, words = this.words;
    if (!starts || !starts.length || !this.wordEls?.length) return;
    const pos = this.app.player.position;
    if (!force && pos === this.lastPos) return;
    this.lastPos = pos;
    let lo = 0, hi = starts.length - 1, i = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (starts[m] <= pos + 1e-4) { i = m; lo = m + 1; } else hi = m - 1; }
    // Between words (a pause) nothing is lit.
    if (i >= 0 && pos > words[i].end + 0.25) i = -1;
    if (i === this.nowIdx) return;
    this.wordEls[this.nowIdx]?.classList.remove('now');
    this.nowIdx = i;
    const n = this.wordEls[i];
    if (!n) return;
    n.classList.add('now');
    if (this.app.player.playing && performance.now() - this.userScrolledAt > 2500) {
      const d = this.doc.getBoundingClientRect(), r = n.getBoundingClientRect();
      if (r.top < d.top + 8 || r.bottom > d.bottom - 8) this.doc.scrollTo({ top: this.doc.scrollTop + r.top - d.top - d.height / 3, behavior: 'smooth' });
    }
  }
}
