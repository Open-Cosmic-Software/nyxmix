import { api, connectLive, getToken, setToken, getName, setName, actor, ApiError } from './api.js';
import { Player } from './player.js';
import { Timeline } from './timeline.js';
import { EFFECTS, effectDefaults, projectEnd, structureKey } from './engine/graph.js';
import { el, fmtTime, parseTime, relTime, clamp, menu, modal, toast, faderToDb, dbToFader, theme, themeButton, themeSegmented } from './ui.js';
import { SpectralView } from './spectral.js';
import { TranscriptView } from './transcript.js';
import { PRESETS } from './engine/presets.js';
import { registerPlugin } from './engine/plugins.js';
import { MixerView } from './mixer.js';
import { MarkersView } from './markers.js';
import { VideoView } from './video.js';
import { openLv2Dialog } from './lv2.js';

const AGENT_GLOW_MS = 4000;

class App {
  constructor(root) {
    this.root = root;
    this.player = new Player();
    this.selection = { clipIds: new Set(), trackId: null, range: null };
    this.snap = true;
    this.peaks = new Map();
    this.glow = new Map();
    this.autoVisible = new Set();
    this.autoParam = new Map();
    this.jobs = new Map();
    this.inspectorTab = 'selection';
    this.processes = null;
    addEventListener('hashchange', () => this.route());
    addEventListener('keydown', (e) => this.onKey(e));
    addEventListener('klang:theme', () => {
      if (!this.project || !this.timeline) return;
      this.timeline.dirty = true;
      this.renderInspector();
      this.renderDock();
    });
    this.route();
  }

  // ── routing ────────────────────────────────────────────────────────────
  route() {
    const m = location.hash.match(/^#\/p\/(prj_[a-f0-9]+)/);
    this.disconnect?.();
    this.player.stop();
    // A proposal preview or a half-finished slider drag belongs to the session we are leaving.
    this.preview = null; document.body.classList.remove('previewing');
    this.interacting = false; this.deferredRender = false;
    if (m) this.openProject(m[1]); else this.home();
  }

  async home() {
    this.project = null;
    document.title = 'NyxMix';
    const list = el('div', { class: 'home-list' }, el('p', { class: 'muted' }, 'Loading sessions…'));
    const name = el('input', { class: 'input', placeholder: 'Session name, e.g. Episode 12', 'aria-label': 'Session name' });
    const rate = el('select', { class: 'input', 'aria-label': 'Sample rate' }, [44100, 48000, 96000].map((r) => el('option', { value: r, selected: r === 48000 }, `${r / 1000} kHz`)));
    const create = async () => {
      const p = await api.createProject(name.value.trim() || 'Untitled session', +rate.value).catch((e) => this.fail(e));
      if (p) location.hash = `#/p/${p.id}`;
    };
    name.addEventListener('keydown', (e) => e.key === 'Enter' && create());
    this.root.replaceChildren(el('main', { class: 'home' }, [
      el('header', { class: 'home-head' }, [
        el('h1', { class: 'brand big' }, [logo(), el('span', {}, 'NyxMix')]),
        el('p', { class: 'lede' }, 'A multitrack audio editor that people and AI agents use together. Everything you can do here, an agent can do through the open API — and you watch it happen live.'),
      ]),
      el('section', { class: 'home-new' }, [el('h2', {}, 'New session'), el('div', { class: 'row' }, [name, rate, el('button', { class: 'btn primary', onclick: create }, 'Create session')]),
        el('p', { class: 'small muted' }, ['Or ', el('label', { class: 'link-like' }, ['open a .nyxmix archive', el('input', { type: 'file', accept: '.nyxmix,.klang,application/x-tar', hidden: true, onchange: async (e) => {
          const f = e.target.files[0]; if (!f) return;
          toast(`Opening ${f.name}…`, { id: 'imp', ms: 0 });
          try { const r = await api.importArchive(f); const sk = r.plugins?.skipped || []; toast(sk.length ? `Opened “${r.name}”, but ${sk.length} plugin${sk.length === 1 ? '' : 's'} could not be installed: ${sk.map((x) => `${x.id} (${x.reason})`).join('; ')}` : `Opened “${r.name}”${r.plugins?.installed?.length ? ` and installed ${r.plugins.installed.join(', ')}` : ''}`, { id: 'imp', kind: sk.length ? 'error' : 'ok', ms: sk.length ? 12000 : undefined }); location.hash = `#/p/${r.id}`; } catch (err) { toast(err.message, { id: 'imp', kind: 'error', ms: 8000 }); }
        } })]), '.'])]),
      el('section', {}, [el('h2', {}, 'Sessions'), list]),
      el('section', { class: 'home-agent' }, [el('h2', {}, 'Connect an agent'), agentInfo()]),
      el('footer', { class: 'home-foot' }, [el('span', {}, 'Appearance'), themeSegmented()]),
    ]));
    name.focus();
    try {
      const projects = await api.projects();
      list.replaceChildren(...(projects.length ? projects.map((p) => el('a', { class: 'home-item', href: `#/p/${p.id}` }, [
        el('strong', {}, p.name),
        el('span', { class: 'muted' }, `${p.tracks} track${p.tracks === 1 ? '' : 's'}, ${p.assets} file${p.assets === 1 ? '' : 's'}, ${p.sampleRate / 1000} kHz`),
        el('span', { class: 'muted' }, `edited ${relTime(p.updatedAt)}`),
        el('button', { class: 'link small home-save', title: 'Save this session as a .nyxmix file', onclick: (e) => { e.preventDefault(); e.stopPropagation(); const a = el('a', { href: api.fileUrl(`/api/projects/${p.id}/archive`), download: '' }); document.body.append(a); a.click(); a.remove(); } }, 'Save .nyxmix'),
      ])) : [el('p', { class: 'muted' }, 'No sessions yet. Create one above, or let an agent create one.')]));
    } catch (e) {
      if (e.status === 401) list.replaceChildren(tokenForm(() => this.home()));
      else this.fail(e);
    }
  }

  async openProject(id) {
    try {
      this.project = await api.project(id);
    } catch (e) {
      if (e.status === 401) { this.root.replaceChildren(el('div', { class: 'home' }, tokenForm(() => this.route()))); return; }
      this.fail(e); location.hash = ''; return;
    }
    this.pid = id;
    try { (await api.plugins()).plugins.forEach(registerPlugin); } catch {}
    this.selection = { clipIds: new Set(), trackId: this.project.tracks[0]?.id || null, range: null };
    this.player.setProject(this.project, id);
    this.buildShell();
    this.renderAll();
    requestAnimationFrame(() => this.timeline.zoomFit());
    this.loadActivity();
    this.loadProposals();
    this.disconnect = connectLive(id, (m) => this.onLive(m), (s) => { this.liveDot.className = `live-dot ${s}`; this.liveDot.title = s === 'live' ? 'Live: edits from agents and other people appear instantly' : 'Reconnecting…'; });
  }

  // ── layout ─────────────────────────────────────────────────────────────
  buildShell() {
    const p = this.project;
    document.title = `${p.name} — NyxMix`;
    this.timecode = el('output', { class: 'timecode', title: 'Playhead (click to type a time)', onclick: () => this.gotoPrompt() }, '0:00.000');
    this.selInfo = el('div', { class: 'sel-info' });
    this.playBtn = el('button', { class: 'tbtn play', 'aria-label': 'Play (Space)', title: 'Play / pause (Space)', onclick: () => this.player.toggle() }, icon('play'));
    this.loopBtn = el('button', { class: 'tbtn', 'aria-label': 'Loop', title: 'Loop the selected range (L)', onclick: () => this.toggleLoop() }, icon('loop'));
    this.recBtn = el('button', { class: 'tbtn rec', 'aria-label': 'Record', title: 'Record onto the selected track (R)', onclick: () => this.toggleRecord() }, icon('rec'));
    this.meter = el('canvas', { class: 'master-meter', width: 180, height: 22, title: 'Master output' });
    this.liveDot = el('span', { class: 'live-dot' });
    this.undoBtn = el('button', { class: 'tbtn', title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo', onclick: () => this.undo() }, icon('undo'));
    this.redoBtn = el('button', { class: 'tbtn', title: 'Redo (Ctrl+Shift+Z)', 'aria-label': 'Redo', onclick: () => this.redo() }, icon('redo'));
    this.nameEl = el('span', { class: 'proj-name', title: 'Double-click to rename', ondblclick: (e) => this.renameInline(e.target, this.project.name, (name) => this.op('project.rename', { name })) }, p.name);

    const top = el('header', { class: 'top' }, [
      el('a', { class: 'brand', href: '#', title: 'All sessions' }, [logo(), el('span', {}, 'NyxMix')]),
      el('h1', { class: 'visually-hidden' }, `${p.name} — NyxMix`),
      this.nameEl,
      el('div', { class: 'transport' }, [
        el('button', { class: 'tbtn', title: 'Go to start (Home)', 'aria-label': 'Go to start', onclick: () => this.player.seek(0) }, icon('start')),
        this.playBtn,
        el('button', { class: 'tbtn', title: 'Stop', 'aria-label': 'Stop', onclick: () => this.player.stop() }, icon('stop')),
        this.loopBtn, this.recBtn,
        (this.speedSel = el('select', { class: 'speed', title: 'Playback speed for listening (pitch follows, like tape). Exports are unaffected.', 'aria-label': 'Playback speed', onchange: (e) => { this.player.speed = +e.target.value; if (this.player.playing) this.player.play(this.player.position); } }, [0.5, 0.75, 1, 1.1, 1.2, 1.25, 1.5, 2].map((v) => el('option', { value: v, selected: v === (this.player.speed || 1) }, `${v}×`)))),
        el('button', { class: 'tbtn', title: 'Audio devices, monitoring, punch-in and latency', 'aria-label': 'Audio settings', onclick: () => this.audioSettingsDialog() }, icon('settings')),
      ]),
      el('div', { class: 'clock' }, [this.timecode, this.selInfo]),
      this.meter,
      (this.lufsEl = el('button', { class: 'lufs-live', title: 'Loudness while playing (EBU R128): momentary, short-term and integrated since playback started. Click to reset.', onclick: () => { this.player.loudnessNode?.port.postMessage('reset'); this.player.loudness = null; } })),
      (this.presenceEl = el('div', { class: 'presence', 'aria-live': 'polite' })),
      el('div', { class: 'spacer' }),
      this.undoBtn, this.redoBtn, themeButton(),
      el('button', { class: 'btn', title: 'Export the mix as an audio file', onclick: () => this.exportDialog() }, 'Export'),
      el('a', { class: 'btn', href: api.fileUrl(`/api/projects/${this.pid}/archive`), download: '', title: 'Save the whole session as a .nyxmix file (all audio, edits, transcripts, versions and the custom plugins it uses) to back it up or open it on another NyxMix server' }, 'Save .nyxmix'),
      el('button', { class: 'btn agent', onclick: () => this.agentDialog() }, [this.liveDot, 'Agents']),
    ]);

    this.binEl = el('div', { class: 'bin-list' });
    const fileInput = el('input', { type: 'file', accept: 'audio/*,video/*,.wav,.flac,.mp3,.m4a,.aac,.ogg,.opus,.aiff,.aif', multiple: true, hidden: true, onchange: (e) => { this.importFiles([...e.target.files]); e.target.value = ''; } });
    const left = el('aside', { class: 'left panel', 'aria-label': 'Files' }, [
      el('div', { class: 'panel-head' }, [el('h2', {}, 'Files'), el('button', { class: 'chip', onclick: () => fileInput.click() }, 'Import'), el('button', { class: 'chip', onclick: () => this.importUrlDialog() }, 'From URL'), el('button', { class: 'chip', onclick: () => this.generateDialog() }, 'Generate'), fileInput]),
      this.binEl,
    ]);
    left.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); left.classList.add('drop'); } });
    left.addEventListener('dragleave', () => left.classList.remove('drop'));
    left.addEventListener('drop', (e) => { e.preventDefault(); left.classList.remove('drop'); if (e.dataTransfer.files.length) this.importFiles([...e.dataTransfer.files]); });

    const center = el('main', { class: 'center' });
    this.inspector = el('div', { class: 'inspector' });
    this.tabs = el('div', { class: 'tabs', role: 'tablist' });
    this.activityEl = el('ol', { class: 'activity', tabindex: 0, 'aria-label': 'Session log' });
    const right = el('aside', { class: 'right panel', 'aria-label': 'Inspector and session log' }, [
      this.tabs, this.inspector,
      (this.proposalsEl = el('div', { class: 'proposals' })),
      el('div', { class: 'panel-head activity-head' }, [el('h2', {}, 'Session log'), el('button', { class: 'chip', onclick: () => this.versionsDialog() }, 'Versions')]),
      this.activityEl,
    ]);
    this.dock = el('section', { class: 'dock' });

    this.root.replaceChildren(el('div', { class: 'shell' }, [top, left, center, right, this.dock]));
    this.timeline = new Timeline(this, center);

    this.player.addEventListener('state', () => this.updateTransport());
    this.player.addEventListener('buffer', () => (this.timeline.dirty = true));
    const tick = () => {
      if (!this.project) return;
      this.timecode.textContent = fmtTime(this.player.position);
      this.drawMeter();
      this.drawLoudness();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  renderAll() {
    this.nameEl.textContent = this.project.name;
    this.timeline.renderHeaders();
    this.timeline.dirty = true;
    this.renderBin();
    this.renderInspector();
    this.renderDock();
    this.updateTransport();
  }

  updateTransport() {
    const playing = this.player.playing;
    this.playBtn.replaceChildren(icon(playing ? 'pause' : 'play'));
    this.playBtn.classList.toggle('on', playing);
    this.loopBtn.classList.toggle('on', this.player.loop.on);
    this.recBtn.classList.toggle('on', !!this.recording);
    const r = this.selection.range;
    this.selInfo.textContent = r ? `${fmtTime(r.start)} – ${fmtTime(r.end)}  (${(r.end - r.start).toFixed(3)} s)` : `${fmtTime(projectEnd(this.project), 1)} total`;
    this.timeline.dirty = true;
  }

  drawMeter() {
    const c = this.meter, g = c.getContext('2d');
    const lv = this.player.masterLevels();
    g.clearRect(0, 0, c.width, c.height);
    const now = performance.now();
    this.peakHold ||= [{ v: -90, t: 0 }, { v: -90, t: 0 }];
    for (let ch = 0; ch < 2; ch++) {
      const y = ch * 12, h = 9;
      g.fillStyle = theme('well'); g.fillRect(0, y, c.width, h);
      const db = lv ? 20 * Math.log10(Math.max(lv[ch].peak, 1e-6)) : -90;
      const rmsDb = lv ? 20 * Math.log10(Math.max(lv[ch].rms, 1e-6)) : -90;
      const X = (d) => clamp((d + 60) / 60, 0, 1) * c.width;
      const grad = g.createLinearGradient(0, 0, c.width, 0);
      grad.addColorStop(0, theme('meter-lo')); grad.addColorStop(0.75, theme('meter-mid')); grad.addColorStop(0.9, theme('meter-hi')); grad.addColorStop(1, theme('meter-clip'));
      g.fillStyle = grad; g.globalAlpha = 0.45; g.fillRect(0, y, X(db), h);
      g.globalAlpha = 1; g.fillRect(0, y + 2, X(rmsDb), h - 4);
      const hold = this.peakHold[ch];
      if (db > hold.v || now - hold.t > 1500) { hold.v = db; hold.t = now; }
      g.fillStyle = hold.v > -0.1 ? theme('meter-clip') : theme('cv-ink'); g.fillRect(X(hold.v) - 1, y, 2, h);
    }
  }

  drawLoudness() {
    const L = this.player.loudness;
    const f = (v) => (v === null || v === undefined || v < -70 ? '–' : v.toFixed(1));
    const key = L ? `${f(L.m)}|${f(L.s)}|${f(L.i)}` : '';
    if (key === this.lufsKey) return;
    this.lufsKey = key;
    this.lufsEl.replaceChildren(
      el('span', {}, [el('b', {}, L ? f(L.i) : '–'), ' LUFS']),
      el('small', {}, `M ${L ? f(L.m) : '–'}  S ${L ? f(L.s) : '–'}`),
    );
  }

  // Agents currently working: anyone non-human with an edit in the last 20 s.
  renderPresence() {
    const now = Date.now();
    const active = new Map();
    for (const e of this.activity || []) {
      if (e.actor?.startsWith('human:')) continue;
      const age = now - new Date(e.ts).getTime();
      if (age < 20000 && !active.has(e.actor)) active.set(e.actor, e);
    }
    this.presenceEl.replaceChildren(...[...active.values()].map((e) => el('span', { class: 'presence-chip', title: e.label }, [el('i'), `${actorLabel(e.actor)} is editing`])));
    clearTimeout(this.presenceTimer);
    if (active.size) this.presenceTimer = setTimeout(() => this.renderPresence(), 5000);
  }

  // ── live updates ───────────────────────────────────────────────────────
  onLive(m) {
    for (const mod of Object.values(this.dockModules || {})) mod.onLive?.(m);
    if (m.type === 'hello' && m.project) { this.applyRemote(m.project); return; }
    if (m.type === 'project') {
      const isAgent = m.cause?.actor && !m.cause.actor.startsWith('human:');
      if (isAgent) this.markAgentChanges(this.project, m.project);
      this.applyRemote(m.project);
      if (m.cause) this.pushActivity(m.cause);
      return;
    }
    if (m.type === 'proposal') { this.loadProposals(); return; }
    if (m.type === 'job') {
      const who = m.actor && !m.actor.startsWith(`human:`) ? `${actorLabel(m.actor)}: ` : '';
      if (m.status === 'running') toast(`${who}${m.label}…`, { id: m.jobId, ms: 0 });
      else if (m.status === 'done') toast(`${who}${m.label} — done`, { id: m.jobId, kind: 'ok' });
      else toast(`${who}${m.label} failed: ${m.error}`, { id: m.jobId, kind: 'error', ms: 8000 });
    }
  }

  applyRemote(project) {
    if (this.preview) { this.preview.real = project; return; }
    if (this.project && project.rev < this.project.rev) return;
    this.project = project;
    // Drop selection entries that no longer exist.
    const ids = new Set(project.tracks.flatMap((t) => t.clips.map((c) => c.id)));
    for (const id of [...this.selection.clipIds]) if (!ids.has(id)) this.selection.clipIds.delete(id);
    if (this.selection.trackId && !project.tracks.some((t) => t.id === this.selection.trackId)) this.selection.trackId = project.tracks[0]?.id || null;
    this.player.setProject(project, this.pid);
    if (this.interacting) { this.deferredRender = true; this.timeline.renderHeaders(); this.timeline.dirty = true; return; }
    this.renderAll();
  }

  markAgentChanges(before, after) {
    const prev = new Map(before.tracks.flatMap((t) => t.clips.map((c) => [c.id, JSON.stringify({ ...c, t: t.id })])));
    const now = performance.now();
    for (const t of after.tracks) for (const c of t.clips) if (prev.get(c.id) !== JSON.stringify({ ...c, t: t.id })) this.glow.set(c.id, now);
  }
  agentGlow(id) {
    const t = this.glow.get(id);
    if (!t) return 0;
    const k = 1 - (performance.now() - t) / AGENT_GLOW_MS;
    if (k <= 0) { this.glow.delete(id); return 0; }
    return k;
  }
  hasRecentAgentEdits() { return this.glow.size > 0; }

  async loadActivity() {
    try {
      const entries = await api.activity(this.pid);
      this.activity = entries;
      this.renderActivity();
    } catch {}
  }
  pushActivity(entry) {
    this.activity = [entry, ...(this.activity || [])].slice(0, 150);
    this.renderActivity();
  }
  renderActivity() {
    this.renderPresence();
    this.activityEl.replaceChildren(...(this.activity || []).slice(0, 80).map((e) => {
      const agent = !e.actor?.startsWith('human:');
      return el('li', { class: agent ? 'agent' : '' }, [
        el('span', { class: 'who' }, actorLabel(e.actor)),
        el('span', { class: 'what' }, e.label),
        el('time', { datetime: e.ts, title: new Date(e.ts).toLocaleString() }, relTime(e.ts)),
      ]);
    }));
  }

  // ── proposals ──────────────────────────────────────────────────────────
  async loadProposals() {
    try { this.proposals = await api.proposals(this.pid); } catch { this.proposals = []; }
    // The previewed proposal was decided elsewhere (agent, other tab): its "Back to current"
    // button is gone with it, so leave the preview instead of staying stuck in it.
    if (this.preview && !this.proposals.some((p) => p.id === this.preview.id)) this.endPreview();
    this.renderProposals();
  }
  renderProposals() {
    const list = this.proposals || [];
    this.proposalsEl.hidden = !list.length;
    this.proposalsEl.replaceChildren(...list.map((pr) => {
      const previewing = this.preview?.id === pr.id;
      return el('div', { class: 'proposal' + (previewing ? ' on' : '') }, [
        el('div', { class: 'proposal-head' }, [el('span', { class: 'who' }, actorLabel(pr.createdBy)), el('span', { class: 'muted small' }, `suggests · ${pr.ops.length} edit${pr.ops.length > 1 ? 's' : ''}`)]),
        el('strong', {}, pr.label),
        pr.rationale ? el('p', { class: 'small' }, pr.rationale) : null,
        el('div', { class: 'row wrap' }, [
          el('button', { class: 'btn' + (previewing ? ' on' : ''), onclick: () => (previewing ? this.endPreview() : this.startPreview(pr)) }, previewing ? 'Back to current' : 'Listen to preview'),
          el('button', { class: 'btn primary', onclick: () => this.decide(pr, true) }, 'Accept'),
          el('button', { class: 'btn subtle', onclick: () => this.decide(pr, false) }, 'Reject'),
        ]),
      ]);
    }));
  }
  async startPreview(pr) {
    try {
      const draft = await api.proposalPreview(this.pid, pr.id);
      this.preview = { id: pr.id, real: this.preview?.real || this.project };
      this.project = draft;
      this.player.setProject(draft, this.pid);
      document.body.classList.add('previewing');
      this.renderAll();
      this.renderProposals();
      toast('Previewing the proposal. Edits are paused until you go back.', { id: 'preview', ms: 4000 });
    } catch (e) { this.fail(e); }
  }
  endPreview() {
    if (!this.preview) return;
    const real = this.preview.real;
    this.preview = null;
    document.body.classList.remove('previewing');
    this.project = real;
    this.player.setProject(real, this.pid);
    this.renderAll();
    this.renderProposals();
  }
  async decide(pr, accept) {
    if (this.preview?.id === pr.id) this.endPreview();
    try { await api.decide(this.pid, pr.id, accept); toast(accept ? 'Accepted. Undo works as usual.' : 'Rejected', { kind: accept ? 'ok' : 'info' }); }
    catch (e) {
      if (e.code === 'stale_proposal' && confirm('The session has changed since this was proposed, so its times may be off. Accept it anyway? (You can undo.)')) {
        try { await api.decide(this.pid, pr.id, true, true); toast('Accepted. Undo works as usual.', { kind: 'ok' }); } catch (e2) { this.fail(e2); }
      } else this.fail(e);
    }
    this.loadProposals();
  }

  async versionsDialog() {
    const list = el('ul', { class: 'versions' }, el('li', { class: 'muted' }, 'Loading…'));
    const name = el('input', { class: 'input', placeholder: 'Name, e.g. Before music pass' });
    const refresh = async () => {
      const vs = await api.versions(this.pid).catch(() => []);
      list.replaceChildren(...(vs.length ? vs.map((v) => el('li', {}, [
        el('div', {}, [el('strong', {}, v.name), el('div', { class: 'muted small' }, `${relTime(v.createdAt)} by ${actorLabel(v.createdBy)}`)]),
        el('button', { class: 'btn', onclick: async () => { await api.restoreVersion(this.pid, v.id).catch((e) => this.fail(e)); toast(`Restored “${v.name}”. Undo brings back what you had.`, { kind: 'ok' }); } }, 'Restore'),
      ])) : [el('li', { class: 'muted' }, 'No versions yet.')]));
    };
    const hist = el('ol', { class: 'history' }, el('li', { class: 'muted' }, 'Loading…'));
    const drawHistory = async () => {
      const h = await api.raw('GET', `/api/projects/${this.pid}/history`).catch(() => ({ undo: [], redo: [] }));
      const step = async (n, dir) => { for (let i = 0; i < n; i++) await api[dir](this.pid).catch(() => {}); drawHistory(); };
      hist.replaceChildren(
        ...[...h.redo].reverse().map((x, i, arr) => el('li', { class: 'redo' }, el('button', { class: 'link', title: 'Redo up to here', onclick: () => step(arr.length - i, 'redo') }, `${x.label} (${actorLabel(x.actor)})`))),
        el('li', { class: 'now' }, 'Now'),
        ...h.undo.map((x, i) => el('li', {}, el('button', { class: 'link', title: 'Go back to before this edit', onclick: () => step(i + 1, 'undo') }, `${x.label} (${actorLabel(x.actor)})`))),
      );
      if (!h.undo.length && !h.redo.length) hist.replaceChildren(el('li', { class: 'muted' }, 'No edits to step through yet.'));
    };
    drawHistory();
    modal('Versions', [
      el('h3', { class: 'sub' }, 'Undo history (click a step to go back to before it)'), hist,
      el('h3', { class: 'sub' }, 'Named versions'),
      el('p', { class: 'small muted' }, 'A version is a snapshot of the arrangement, effects and automation. Restoring one is a normal edit, so you can undo it.'),
      el('p', { class: 'small' }, [el('a', { href: api.fileUrl(`/api/projects/${this.pid}/archive`), download: '' }, 'Download the whole session (.nyxmix)'), ' — all audio, edits, transcripts, versions and the custom plugins it uses, to back up or open on another NyxMix server.']),
      el('div', { class: 'row' }, [name, el('button', { class: 'btn primary', onclick: async () => { await api.saveVersion(this.pid, name.value.trim() || undefined).catch((e) => this.fail(e)); name.value = ''; refresh(); } }, 'Save version')]),
      list,
    ]);
    refresh();
  }

  // ── edits ──────────────────────────────────────────────────────────────
  async ops(ops, label) {
    if (this.preview) { toast('You are listening to a proposal. Go back to the current version to edit.'); return null; }
    try {
      const r = await api.ops(this.pid, ops, label);
      return r;
    } catch (e) { this.fail(e); return null; }
  }
  op(name, args, label) { return this.ops([{ op: name, args }], label).then((r) => r?.results[0]); }
  async undo() { try { await api.undo(this.pid); } catch (e) { if (e.code !== 'nothing_to_undo') this.fail(e); else toast('Nothing to undo'); } }
  async redo() { try { await api.redo(this.pid); } catch (e) { if (e.code !== 'nothing_to_redo') this.fail(e); else toast('Nothing to redo'); } }

  fail(e) {
    console.error(e);
    toast(e instanceof ApiError ? e.message : `Something went wrong: ${e.message}`, { kind: 'error', ms: 6000 });
  }

  // Local, unsent changes while a slider is being dragged; committed on release.
  liveTrack(trackId, patch) {
    const t = this.project.tracks.find((x) => x.id === trackId);
    if (!t) return;
    Object.assign(t, patch);
    this.player.setProject(this.project, this.pid);
  }
  liveEffect(effectId, params) {
    for (const list of [this.project.master.effects, ...this.project.tracks.map((t) => t.effects)]) {
      const fx = list.find((e) => e.id === effectId);
      if (fx) { Object.assign(fx.params, params); this.player.setProject(this.project, this.pid); return; }
    }
  }
  liveMaster(gain) { this.project.master.gain = gain; this.player.setProject(this.project, this.pid); }

  select(sel, tab) {
    if (sel.clipIds !== undefined) this.selection.clipIds = sel.clipIds;
    else if (sel.trackId !== undefined) this.selection.clipIds = new Set();
    if (sel.trackId !== undefined) this.selection.trackId = sel.trackId;
    if (tab) this.inspectorTab = tab === 'track' ? 'selection' : tab;
    this.emitSelection();
  }
  emitSelection() {
    this.timeline.renderHeaders();
    this.timeline.dirty = true;
    this.renderInspector();
    this.renderDock();
    this.updateTransport();
  }

  selectedClips() {
    const out = [];
    for (const t of this.project.tracks) for (const c of t.clips) if (this.selection.clipIds.has(c.id)) out.push({ clip: c, track: t });
    return out;
  }

  splitAtPlayhead() {
    const t = this.player.position;
    let targets = this.selectedClips().filter(({ clip: c }) => t > c.start && t < c.start + c.duration);
    if (!targets.length) {
      for (const tr of this.project.tracks) for (const c of tr.clips) if (t > c.start && t < c.start + c.duration) targets.push({ clip: c, track: tr });
    }
    if (!targets.length) { toast('Move the playhead over a clip to split it'); return; }
    this.ops(targets.map(({ clip }) => ({ op: 'clip.split', args: { clipId: clip.id, at: t } })), targets.length > 1 ? `Split ${targets.length} clips at ${fmtTime(t)}` : undefined);
  }

  deleteSelection() {
    const r = this.selection.range;
    if (r && r.end - r.start > 0.0005) {
      this.op('range.delete', { start: r.start, end: r.end });
      this.selection.range = null;
      this.player.seek(r.start);
      return;
    }
    const clips = this.selectedClips();
    if (clips.length) this.ops(clips.map(({ clip }) => ({ op: 'clip.remove', args: { clipId: clip.id } })), clips.length > 1 ? `Deleted ${clips.length} clips` : undefined);
  }

  async placeAsset(assetId, trackId, start) {
    const asset = this.project.assets.find((a) => a.id === assetId);
    if (!asset) return;
    if (trackId) return this.op('clip.add', { trackId, assetId, start });
    return this.ops([{ op: 'track.add', args: { name: asset.name.slice(0, 60) } }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId, start } }], `Placed “${asset.name}” on a new track`);
  }

  async importFiles(files, place) {
    for (const f of files) {
      const id = `up-${f.name}-${f.size}`;
      toast(`Importing ${f.name}…`, { id, ms: 0 });
      try {
        const asset = await api.upload(this.pid, f, f.name.replace(/\.[^.]+$/, ''));
        toast(`Imported ${asset.name}`, { id, kind: 'ok' });
        if (place) await this.placeAsset(asset.id, place.trackId, place.start);
      } catch (e) { toast(`${f.name}: ${e.message}`, { id, kind: 'error', ms: 8000 }); }
    }
  }

  importUrlDialog() {
    const url = el('input', { class: 'input', type: 'url', placeholder: 'https://example.com/interview.wav' });
    modal('Import from URL', [el('label', { class: 'field' }, ['Public link to an audio or video file', url])], {
      actions: [{ label: 'Cancel' }, { label: 'Import', primary: true, action: async () => {
        if (!url.value) return false;
        toast('Downloading…', { id: 'url', ms: 0 });
        try { const a = await api.importUrl(this.pid, url.value); toast(`Imported ${a.name}`, { id: 'url', kind: 'ok' }); } catch (e) { toast(e.message, { id: 'url', kind: 'error', ms: 8000 }); }
      } }],
    });
  }

  peaksFor(assetId) {
    const p = this.peaks.get(assetId);
    if (p && p !== 'loading') return p;
    if (!p) {
      this.peaks.set(assetId, 'loading');
      api.peaks(this.pid, assetId).then(({ block, data }) => {
        this.peaks.set(assetId, { block, data, sr: this.project.sampleRate });
        this.timeline.dirty = true;
      }).catch(() => this.peaks.delete(assetId));
    }
    return null;
  }

  toggleLoop() {
    const r = this.selection.range;
    const L = this.player.loop;
    if (!L.on && !r) { toast('Select a range on the timeline first, then press L'); return; }
    if (!L.on) Object.assign(L, { on: true, start: r.start, end: r.end }); else L.on = false;
    if (this.player.playing) this.player.play(this.player.position);
    this.updateTransport();
  }

  addMarker() {
    const r = this.selection.range;
    this.op('marker.add', r ? { time: r.start, duration: r.end - r.start, label: '' } : { time: this.player.position, label: '' });
  }

  gotoPrompt() {
    const input = el('input', { class: 'input', value: fmtTime(this.player.position) });
    modal('Go to time', [el('label', { class: 'field' }, ['Time (m:ss.mmm or seconds)', input])], {
      actions: [{ label: 'Cancel' }, { label: 'Go', primary: true, action: () => { const t = parseTime(input.value); if (t === null) return false; this.player.seek(t); this.timeline.reveal(t); } }],
    });
    input.select();
  }

  renameInline(node, current, commit) {
    node.contentEditable = 'true';
    node.focus();
    document.getSelection().selectAllChildren(node);
    const done = (save) => {
      node.contentEditable = 'false';
      node.removeEventListener('keydown', onKey);
      const v = node.textContent.trim();
      if (save && v && v !== current) commit(v); else node.textContent = current;
    };
    const onKey = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); done(true); } if (e.key === 'Escape') done(false); };
    node.addEventListener('keydown', onKey);
    node.addEventListener('blur', () => done(true), { once: true });
  }

  // ── keyboard ───────────────────────────────────────────────────────────
  // Rebindable commands (Audition lets you remap shortcuts too). Defaults below;
  // personal overrides live in localStorage under klang.keys as { action: combo }.
  keyActions() {
    return {
      play: ['Play / pause', ' ', () => this.player.toggle()],
      split: ['Split at playhead', 's', () => this.splitAtPlayhead()],
      delete: ['Delete clip or ripple-cut range', 'delete', () => this.deleteSelection()],
      marker: ['Add marker', 'm', () => this.addMarker()],
      loop: ['Loop the range', 'l', () => this.toggleLoop()],
      record: ['Record / punch in', 'r', () => this.toggleRecord()],
      rangeIn: ['Range start at playhead', 'i', () => this.onKey({ key: 'i', target: document.body, preventDefault() {}, synthetic: true })],
      rangeOut: ['Range end at playhead', 'o', () => this.onKey({ key: 'o', target: document.body, preventDefault() {}, synthetic: true })],
      zoomIn: ['Zoom in', '+', () => this.timeline.zoomBy(1.5)],
      zoomOut: ['Zoom out', '-', () => this.timeline.zoomBy(1 / 1.5)],
      fit: ['Zoom to fit', '\\', () => this.timeline.zoomFit()],
      start: ['Go to start', 'home', () => { this.player.seek(0); this.timeline.reveal(0); }],
      export: ['Export', 'ctrl+e', () => this.exportDialog()],
      undo: ['Undo', 'ctrl+z', () => this.undo()],
      redo: ['Redo', 'ctrl+shift+z', () => this.redo()],
    };
  }
  keyOverrides() { try { return JSON.parse(localStorage.getItem('klang.keys')) || {}; } catch { return {}; } }
  static combo(e) { const k = e.key.toLowerCase(); return `${e.ctrlKey || e.metaKey ? 'ctrl+' : ''}${e.altKey ? 'alt+' : ''}${e.shiftKey && k.length > 1 ? 'shift+' : ''}${e.shiftKey && k === 'z' ? 'shift+' : ''}${k}`; }

  onKey(e) {
    if (!this.project || e.target.closest?.('input,textarea,select,[contenteditable="true"]')) return;
    if (document.querySelector('.modal-wrap')) return;
    if (!e.synthetic) {
      const ov = this.keyOverrides();
      if (Object.keys(ov).length) {
        const combo = App.combo(e), acts = this.keyActions();
        const hit = Object.entries(ov).find(([, c]) => c === combo);
        if (hit && acts[hit[0]]) { e.preventDefault(); acts[hit[0]][2](); return; }
        // A default key whose command was moved elsewhere does nothing any more.
        if (Object.keys(ov).some((a) => acts[a]?.[1] === combo)) return;
      }
    }
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const handled = () => e.preventDefault();
    if (k === ' ') { if (e.target.closest?.('button')) return; handled(); this.player.toggle(); }
    else if (mod && k === 'z') { handled(); e.shiftKey ? this.redo() : this.undo(); }
    else if (mod && k === 'y') { handled(); this.redo(); }
    else if (mod && k === 'd') { handled(); const cs = this.selectedClips(); if (cs.length) this.ops(cs.map(({ clip }) => ({ op: 'clip.duplicate', args: { clipId: clip.id } }))); }
    else if (mod && k === 'a') { handled(); this.select({ clipIds: new Set(this.project.tracks.flatMap((t) => t.clips.map((c) => c.id))) }); }
    else if (mod && k === 'e') { handled(); this.exportDialog(); }
    else if (mod && (k === 'c' || k === 'x')) {
      const cs = this.selectedClips();
      if (!cs.length) return;
      handled();
      const t0 = Math.min(...cs.map(({ clip }) => clip.start));
      this.clipboard = cs.map(({ clip, track }) => ({ trackId: track.id, rel: clip.start - t0, clip: { ...clip } }));
      if (k === 'x') this.ops(cs.map(({ clip }) => ({ op: 'clip.remove', args: { clipId: clip.id } })), `Cut ${cs.length} clip${cs.length > 1 ? 's' : ''}`);
      else toast(`Copied ${cs.length} clip${cs.length > 1 ? 's' : ''}`, { ms: 1500 });
    }
    else if (mod && k === 'v') {
      if (!this.clipboard?.length) return;
      handled();
      const at = this.player.position;
      const tracks = new Set(this.project.tracks.map((t) => t.id));
      const single = new Set(this.clipboard.map((c) => c.trackId)).size === 1;
      const ops = this.clipboard.map(({ trackId, rel, clip }) => ({ op: 'clip.add', args: {
        trackId: single && this.selection.trackId ? this.selection.trackId : tracks.has(trackId) ? trackId : this.selection.trackId,
        assetId: clip.assetId, start: at + rel, offset: clip.offset, duration: clip.duration, gain: clip.gain, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut, name: clip.name,
      } })).filter((o) => o.args.trackId);
      if (ops.length) this.ops(ops, `Pasted ${ops.length} clip${ops.length > 1 ? 's' : ''} at ${fmtTime(at)}`);
    }
    else if (mod) return;
    else if (k === 's') { handled(); this.splitAtPlayhead(); }
    else if (k === 'delete' || k === 'backspace') { handled(); this.deleteSelection(); }
    else if (k === 'm') { handled(); this.addMarker(); }
    else if (k === 'l') { handled(); this.toggleLoop(); }
    else if (k === 'r') { handled(); this.toggleRecord(); }
    else if (k === 'home') { handled(); this.player.seek(0); this.timeline.reveal(0); }
    else if (k === 'end') { handled(); const t = projectEnd(this.project); this.player.seek(t); this.timeline.reveal(t); }
    else if (k === '+' || k === '=') { handled(); this.timeline.zoomBy(1.5); }
    else if (k === '-') { handled(); this.timeline.zoomBy(1 / 1.5); }
    else if (k === '\\') { handled(); this.timeline.zoomFit(); }
    else if (k === 'i') { handled(); const r = this.selection.range; const t = this.player.position; this.selection.range = { start: t, end: Math.max(t, r?.end ?? t) }; this.emitSelection(); }
    else if (k === 'o') { handled(); const r = this.selection.range; const t = this.player.position; this.selection.range = { start: Math.min(t, r?.start ?? t), end: t }; this.emitSelection(); }
    else if (k === 'arrowleft' || k === 'arrowright') {
      handled();
      const step = e.shiftKey ? 1 : 0.1;
      const t = this.player.position + (k === 'arrowleft' ? -step : step);
      this.player.seek(Math.max(0, t)); this.timeline.reveal(t);
    }
    else if (k === 'escape') { this.envClip = null; this.selection.range = null; this.select({ clipIds: new Set() }); }
    else if (k === '?') { handled(); this.shortcutsDialog(); }
  }

  shortcutsDialog() {
    const rows = [['Space', 'Play / pause'], ['S', 'Split at playhead'], ['Delete', 'Delete clip, or ripple-cut the selected range'], ['Drag on lane', 'Select a time range'], ['I / O', 'Set range start / end at playhead'], ['L', 'Loop the range'], ['M', 'Add marker (or range marker)'], ['R', 'Record onto the selected track'], ['Alt + drag clip', 'Copy clip'], ['Alt while dragging', 'Bypass snapping'], ['Ctrl + wheel', 'Zoom'], ['Shift + wheel', 'Scroll sideways'], ['+ / − / \\', 'Zoom in / out / fit'], ['← / →', 'Nudge playhead (Shift = 1 s)'], ['Ctrl + D', 'Duplicate clip'], ['Ctrl + C / X / V', 'Copy, cut, paste clips at the playhead'], ['Ctrl + Z / Ctrl + Shift + Z', 'Undo / redo'], ['Ctrl + E', 'Export'], ['Double-click clip', 'Spectral view'], ['B / L / P / H / T', 'Spectral view: box, lasso, brush, spot heal, pitch (when it has focus)'], ['Delete in spectral view', 'Turn the painted region down by 60 dB'], ['R', 'Record (punch-in when a range is selected)']];
    const show = (c) => (c === ' ' ? 'Space' : c.split('+').map((x) => (x.length === 1 ? x.toUpperCase() : x.charAt(0).toUpperCase() + x.slice(1))).join(' + '));
    const custom = el('table', { class: 'keys' });
    const draw = () => {
      const ov = this.keyOverrides();
      custom.replaceChildren(...Object.entries(this.keyActions()).map(([id, [label, def]]) => {
        const cur = ov[id] || def;
        const btn = el('button', { class: 'chip', onclick: () => {
          btn.textContent = 'Press a key…';
          const grab = (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            if (['shift', 'control', 'alt', 'meta'].includes(ev.key.toLowerCase())) return;
            removeEventListener('keydown', grab, true);
            if (ev.key === 'Escape') { draw(); return; }
            const next = { ...this.keyOverrides(), [id]: App.combo(ev) };
            try { localStorage.setItem('klang.keys', JSON.stringify(next)); } catch {}
            draw();
          };
          addEventListener('keydown', grab, true);
        } }, 'Change');
        return el('tr', {}, [el('td', {}, el('kbd', { class: ov[id] ? 'custom' : '' }, show(cur))), el('td', {}, label), el('td', {}, btn)]);
      }));
    };
    draw();
    modal('Keyboard shortcuts', [
      el('h3', { class: 'sub' }, 'Commands you can remap'), custom,
      el('button', { class: 'link small', onclick: () => { try { localStorage.removeItem('klang.keys'); } catch {} draw(); } }, 'Reset to defaults'),
      el('h3', { class: 'sub' }, 'Mouse and other keys'),
      el('table', { class: 'keys' }, rows.map(([k, v]) => el('tr', {}, [el('td', {}, el('kbd', {}, k)), el('td', {}, v)]))),
    ], { wide: true });
  }

  // ── context menus ──────────────────────────────────────────────────────
  clipMenu(x, y, clip, t) {
    const inside = t > clip.start && t < clip.start + clip.duration;
    menu(x, y, [
      { label: 'Split here', disabled: !inside, action: () => this.op('clip.split', { clipId: clip.id, at: t }) },
      { label: 'Split at playhead', key: 'S', action: () => this.splitAtPlayhead() },
      { label: 'Duplicate', key: 'Ctrl D', action: () => this.op('clip.duplicate', { clipId: clip.id }) },
      '-',
      { label: this.envClip === clip.id ? 'Stop editing volume envelope' : 'Edit volume envelope', action: () => { this.envClip = this.envClip === clip.id ? null : clip.id; this.timeline.dirty = true; if (this.envClip) toast('Click the line to add points, drag to move, double-click to delete. Esc when done.', { ms: 5000 }); } },
      { label: 'Fit to length…', action: () => this.fitDialog(clip) },
      { label: 'Bring to front', action: () => this.stackClip(clip, 1) },
      { label: 'Send to back', action: () => this.stackClip(clip, -1) },
      { label: 'Add clip marker here', disabled: !inside, action: () => { const label = prompt('Marker note (optional)') ?? ''; this.op('clip.setMarkers', { clipId: clip.id, markers: [...(clip.markers || []), { time: clip.offset + (t - clip.start) * (clip.rate || 1), label }] }, 'Added clip marker'); } },
      clip.markers?.length ? { label: 'Remove clip markers', action: () => this.op('clip.setMarkers', { clipId: clip.id, markers: [] }, 'Removed clip markers') } : null,
      { label: 'Strip silence…', action: () => this.stripSilence(clip) },
      { label: 'Repair and process…', action: () => this.processDialog(clip.assetId, clip) },
      { label: 'Plugins (LV2)…', action: () => openLv2Dialog(this, clip.assetId, clip) },
      { label: 'Measure this clip', action: () => { this.inspectorTab = 'analysis'; this.analysisTarget = 'clip'; this.renderInspector(); this.runAnalysis(); } },
      { label: 'Spectral view', action: () => this.openEditor(clip.id) },
      '-',
      { label: 'Delete', key: 'Del', danger: true, action: () => this.op('clip.remove', { clipId: clip.id }) },
    ]);
  }
  laneMenu(x, y, track, t) {
    const r = this.selection.range;
    menu(x, y, [
      { label: 'Add marker here', action: () => this.op('marker.add', { time: t }) },
      { label: 'Ripple-delete selected range', disabled: !r, key: 'Del', action: () => this.deleteSelection() },
      { label: 'Silence the selected range (no ripple)', disabled: !r, action: () => this.op('range.delete', { start: r.start, end: r.end, ripple: false }, `Silenced ${fmtTime(r.start, 2)}–${fmtTime(r.end, 2)}`) },
      { label: 'Insert silence for selected range length', disabled: !r, action: () => this.op('range.insertSilence', { at: r.start, duration: r.end - r.start }) },
      '-',
      { label: 'Add track', action: () => this.op('track.add', {}) },
      track && { label: `Delete track “${track.name}”`, danger: true, action: () => this.op('track.remove', { trackId: track.id }) },
    ].filter(Boolean));
  }

  // ── bin ────────────────────────────────────────────────────────────────
  renderBin() {
    const used = new Map();
    for (const t of this.project.tracks) for (const c of t.clips) used.set(c.assetId, (used.get(c.assetId) || 0) + 1);
    const assets = [...this.project.assets].reverse();
    if (!assets.length) {
      this.binEl.replaceChildren(el('div', { class: 'bin-empty' }, [el('p', {}, 'Drop audio or video files here.'), el('p', { class: 'muted small' }, 'WAV, FLAC, MP3, AAC, Ogg, Opus, AIFF or a video’s soundtrack. Everything is stored as lossless 32-bit float.')]));
      return;
    }
    this.binEl.replaceChildren(...assets.map((a) => {
      const agent = a.createdBy && !a.createdBy.startsWith('human:');
      return el('div', {
        class: 'bin-item', draggable: 'true', tabindex: 0, title: 'Drag onto the timeline',
        ondragstart: (e) => { e.dataTransfer.setData('application/x-klang-asset', a.id); e.dataTransfer.effectAllowed = 'copy'; },
        ondblclick: () => this.placeAsset(a.id, this.selection.trackId, this.player.position),
        oncontextmenu: (e) => { e.preventDefault(); menu(e.clientX, e.clientY, [
          { label: 'Place at playhead', action: () => this.placeAsset(a.id, this.selection.trackId, this.player.position) },
          { label: 'Place on a new track', action: () => this.placeAsset(a.id, null, 0) },
          { label: 'Repair and process…', action: () => this.processDialog(a.id) },
          { label: 'Rename', action: () => { const n = prompt('Name', a.name); if (n) this.op('asset.rename', { assetId: a.id, name: n }); } },
          '-',
          { label: 'Delete from bin', danger: true, disabled: used.has(a.id), action: () => api.deleteAsset(this.pid, a.id).catch((e) => this.fail(e)) },
        ]); },
      }, [
        el('div', { class: 'bin-name' }, [a.name, agent ? el('span', { class: 'tag agent', title: a.createdBy }, actorLabel(a.createdBy)) : null]),
        el('div', { class: 'bin-meta' }, [
          fmtTime(a.duration, 1), ' · ', a.channels === 1 ? 'mono' : 'stereo',
          a.derivedFrom ? ` · ${a.process.kind}` : a.source ? ` · ${a.source.codec}` : '',
          used.get(a.id) ? ` · ${used.get(a.id)} clip${used.get(a.id) > 1 ? 's' : ''}` : '',
        ]),
      ]);
    }));
  }

  // ── inspector ──────────────────────────────────────────────────────────
  renderInspector() {
    if (this.interacting) { this.deferredRender = true; return; }
    const tabs = [['selection', 'Selection'], ['master', 'Master'], ['analysis', 'Measure']];
    this.tabs.replaceChildren(...tabs.map(([id, label]) => el('button', { role: 'tab', 'aria-selected': String(this.inspectorTab === id), class: 'tab' + (this.inspectorTab === id ? ' on' : ''), onclick: () => { this.inspectorTab = id; this.renderInspector(); } }, label)));
    const body = this.inspectorTab === 'master' ? this.masterPanel() : this.inspectorTab === 'analysis' ? this.analysisPanel() : this.selectionPanel();
    this.inspector.replaceChildren(...[].concat(body));
  }

  selectionPanel() {
    const clips = this.selectedClips();
    if (clips.length === 1) return [this.clipPanel(clips[0].clip, clips[0].track), this.trackPanel(clips[0].track, true)];
    if (clips.length > 1) return [el('div', { class: 'section' }, [el('h3', {}, `${clips.length} clips selected`), el('div', { class: 'row' }, [
      el('button', { class: 'btn', onclick: () => this.ops(clips.map(({ clip }) => ({ op: 'clip.update', args: { clipId: clip.id, fadeIn: Math.min(0.01, clip.duration / 2), fadeOut: Math.min(0.01, clip.duration / 2) } })), 'Added 10 ms fades') }, 'De-click edges'),
      el('button', { class: 'btn', title: 'Set each clip’s gain so they all measure the same loudness (EBU R128)', onclick: () => this.matchLoudness(clips.map((c) => c.clip)) }, 'Match loudness'),
      el('button', { class: 'btn danger', onclick: () => this.deleteSelection() }, 'Delete'),
    ])])];
    const t = this.project.tracks.find((x) => x.id === this.selection.trackId);
    if (t) return this.trackPanel(t);
    return el('div', { class: 'section muted' }, 'Select a clip or a track to edit it here.');
  }

  clipPanel(c, track) {
    const asset = this.project.assets.find((a) => a.id === c.assetId);
    const num = (label, value, onCommit, opts = {}) => {
      const input = el('input', { class: 'input num', value: opts.time ? fmtTime(value) : value.toFixed(3), onchange: (e) => { const v = opts.time ? parseTime(e.target.value) : parseFloat(e.target.value); if (v === null || !Number.isFinite(v)) { e.target.value = opts.time ? fmtTime(value) : value; return; } onCommit(v); } });
      return el('label', { class: 'field inline' }, [el('span', {}, label), input]);
    };
    return el('div', { class: 'section' }, [
      el('h3', {}, ['Clip ', el('span', { class: 'muted' }, c.name)]),
      num('Start', c.start, (v) => this.op('clip.update', { clipId: c.id, start: Math.max(0, v) }), { time: true }),
      num('Length', c.duration, (v) => this.op('clip.update', { clipId: c.id, duration: Math.max(0.001, v) }), { time: true }),
      num('Source in', c.offset, (v) => this.op('clip.update', { clipId: c.id, offset: Math.max(0, v) }), { time: true }),
      this.slider({ label: 'Clip gain', min: -60, max: 24, step: 0.1, value: c.gain, fmt: dbFmt, reset: 0, oncommit: (v) => this.op('clip.update', { clipId: c.id, gain: v }) }),
      this.slider({ label: 'Fade in', min: 0, max: Math.min(c.duration, 10), step: 0.001, value: c.fadeIn, fmt: (v) => `${v.toFixed(3)} s`, reset: 0, oncommit: (v) => this.op('clip.update', { clipId: c.id, fadeIn: v }) }),
      this.slider({ label: 'Fade out', min: 0, max: Math.min(c.duration, 10), step: 0.001, value: c.fadeOut, fmt: (v) => `${v.toFixed(3)} s`, reset: 0, oncommit: (v) => this.op('clip.update', { clipId: c.id, fadeOut: v }) }),
      this.slider({ label: 'Varispeed', min: -12, max: 12, step: 0.1, value: 12 * Math.log2(c.rate || 1), reset: 0,
        fmt: (v) => (Math.abs(v) < 0.05 ? 'Off' : `${v > 0 ? '+' : ''}${v.toFixed(1)} st · ×${Math.pow(2, v / 12).toFixed(3)}`),
        oncommit: (v) => this.op('clip.update', { clipId: c.id, rate: Math.round(Math.pow(2, v / 12) * 10000) / 10000 }, 'Changed varispeed') }),
      el('label', { class: 'check' }, [el('input', { type: 'checkbox', checked: !!c.loop, onchange: (e) => this.op('clip.update', { clipId: c.id, loop: e.target.checked }, e.target.checked ? 'Looped clip' : 'Stopped looping clip') }), ' Loop: drag the clip end past the source to repeat it']),
      el('div', { class: 'row shapes' }, [
        el('span', { class: 'muted small' }, 'Curves'),
        ...[['fadeInShape', 'In'], ['fadeOutShape', 'Out']].map(([k, l]) => el('select', { class: 'input', 'aria-label': `Fade ${l.toLowerCase()} curve`, onchange: (e) => this.op('clip.update', { clipId: c.id, [k]: e.target.value }) },
          [['linear', `${l}: linear`], ['equalPower', `${l}: equal power`], ['sCurve', `${l}: S-curve`], ['exponential', `${l}: exponential`]].map(([v, t]) => el('option', { value: v, selected: (c[k] || 'linear') === v }, t)))),
      ]),
      el('div', { class: 'row wrap' }, [
        el('button', { class: 'btn', onclick: () => this.splitAtPlayhead() }, 'Split at playhead'),
        el('button', { class: 'btn', onclick: () => this.processDialog(c.assetId, c) }, 'Repair and process…'),
        el('button', { class: 'btn', title: 'Native LV2 effects (LSP, x42, Calf) run on the server', onclick: () => openLv2Dialog(this, c.assetId, c) }, 'Plugins (LV2)…'),
        el('button', { class: 'btn danger', onclick: () => this.op('clip.remove', { clipId: c.id }) }, 'Delete'),
      ]),
      asset ? el('p', { class: 'muted small' }, `Source: ${asset.name} (${fmtTime(asset.duration, 2)}${asset.derivedFrom ? `, ${asset.process.kind} applied` : ''})`) : null,
    ]);
  }

  trackPanel(t, compact) {
    return el('div', { class: 'section' }, [
      el('h3', {}, ['Track ', el('span', { class: 'muted' }, t.name)]),
      compact ? null : el('div', { class: 'row' }, [
        el('label', { class: 'field inline grow' }, [el('span', {}, 'Name'), el('input', { class: 'input', value: t.name, onchange: (e) => this.op('track.update', { trackId: t.id, name: e.target.value || t.name }) })]),
        el('input', { type: 'color', class: 'swatch-input', value: t.color, 'aria-label': 'Track color', onchange: (e) => this.op('track.update', { trackId: t.id, color: e.target.value }) }),
      ]),
      compact ? null : this.slider({ label: 'Volume', min: -60, max: 12, step: 0.1, value: t.gain, fmt: dbFmt, reset: 0, onlive: (v) => this.liveTrack(t.id, { gain: v }), oncommit: (v) => this.op('track.update', { trackId: t.id, gain: v }) }),
      compact || this.project.channels === 6 ? null : this.slider({ label: 'Pan', min: -1, max: 1, step: 0.01, value: t.pan, fmt: panFmt, reset: 0, onlive: (v) => this.liveTrack(t.id, { pan: v }), oncommit: (v) => this.op('track.update', { trackId: t.id, pan: v }) }),
      !compact && this.project.channels === 6 && t.kind !== 'bus' ? this.surroundPad(t) : null,
      this.effectRack(t.effects, t.id),
      this.routingPanel(t),
      compact || this.project.tracks.length < 2 || t.kind === 'bus' ? null : el('div', { class: 'duck' }, [
        el('div', { class: 'row' }, [
          el('button', { class: 'btn', onclick: async () => {
            toast('Listening to the other tracks…', { id: 'duck', ms: 0 });
            try { const r = await api.duck(this.pid, { musicTrackId: t.id, amount: +this.duckAmount || -12 }); this.autoVisible.add(t.id); toast(`Ducked under ${r.speechRegions.length} passages. Drag the yellow points to fine-tune.`, { id: 'duck', kind: 'ok', ms: 6000 }); this.timeline.renderHeaders(); }
            catch (e) { toast(e.message, { id: 'duck', kind: 'error', ms: 8000 }); }
          } }, 'Duck under the other tracks'),
          el('select', { class: 'input', 'aria-label': 'Duck amount', onchange: (e) => (this.duckAmount = e.target.value) }, [-6, -9, -12, -15, -18, -24].map((v) => el('option', { value: v, selected: v === (+this.duckAmount || -12) }, `${v} dB`))),
        ]),
        t.automation?.volume?.length ? el('button', { class: 'link small', onclick: () => this.op('automation.set', { trackId: t.id, param: 'volume', points: [] }, 'Cleared volume automation') }, 'Clear volume automation') : null,
      ]),
      compact ? null : el('div', { class: 'row' }, [el('button', { class: 'btn danger subtle', onclick: () => confirm(`Delete track “${t.name}” and its clips?`) && this.op('track.remove', { trackId: t.id }) }, 'Delete track')]),
    ]);
  }

  routingPanel(t) {
    const buses = this.project.tracks.filter((x) => x.kind === 'bus' && x.id !== t.id);
    if (t.kind === 'bus') {
      const feeds = this.project.tracks.filter((x) => x.output === t.id || (x.sends || []).some((s) => s.busId === t.id));
      return el('div', { class: 'routing' }, [el('div', { class: 'rack-head' }, [el('span', {}, 'Inputs')]), el('p', { class: 'small muted' }, feeds.length ? feeds.map((x) => x.name).join(', ') : 'Nothing feeds this bus yet. Pick it as Output on a track, or add a send.')]);
    }
    const sends = t.sends || [];
    const free = buses.filter((b) => !sends.some((s) => s.busId === b.id));
    return el('div', { class: 'routing' }, [
      el('label', { class: 'field inline' }, [el('span', {}, 'Output'), el('select', { class: 'input', onchange: (e) => this.op('track.update', { trackId: t.id, output: e.target.value }) }, [
        el('option', { value: 'master', selected: !t.output }, 'Master'),
        ...buses.map((b) => el('option', { value: b.id, selected: t.output === b.id }, b.name)),
      ])]),
      el('div', { class: 'rack-head' }, [el('span', {}, 'Sends'), buses.length ? el('select', { class: 'input', disabled: !free.length, onchange: (e) => { if (e.target.value) this.op('send.add', { trackId: t.id, busId: e.target.value }); } }, [
        el('option', { value: '' }, free.length ? 'Add send…' : 'All buses used'), ...free.map((b) => el('option', { value: b.id }, b.name)),
      ]) : el('button', { class: 'chip', onclick: () => this.ops([{ op: 'track.add', args: { kind: 'bus', name: 'Reverb bus' } }, { op: 'effect.add', args: { trackId: '$0.trackId', type: 'reverb', params: { mix: 1 } } }, { op: 'send.add', args: { trackId: t.id, busId: '$0.trackId', level: -12 } }], 'Added a reverb bus') }, 'Add reverb bus')]),
      ...sends.map((x) => {
        const bus = this.project.tracks.find((b) => b.id === x.busId);
        return el('div', { class: 'send' }, [
          this.slider({ label: bus?.name || 'Bus', min: -60, max: 6, step: 0.1, value: x.level ?? -6, fmt: dbFmt, reset: -6, onlive: (v) => { x.level = v; this.player.setProject(this.project, this.pid); }, oncommit: (v) => this.op('send.update', { sendId: x.id, level: v }) }),
          el('button', { class: 'chip' + (x.pre ? ' on' : ''), title: 'Pre-fader: the send ignores this track’s volume', onclick: () => this.op('send.update', { sendId: x.id, pre: !x.pre }) }, x.pre ? 'Pre' : 'Post'),
          el('button', { class: 'icon-btn', 'aria-label': 'Remove send', onclick: () => this.op('send.remove', { sendId: x.id }) }, '×'),
        ]);
      }),
    ]);
  }

  // 5.1 position pad: drag the dot; speakers drawn at their ITU angles.
  surroundPad(t) {
    const S = 220, c = el('canvas', { class: 'surround-pad', width: S, height: S, tabindex: 0, 'aria-label': 'Surround position. Drag the dot; arrow keys move it; double-click centres it front.' });
    let x = t.pan || 0, y = t.surroundY ?? 1;
    const P = (vx, vy) => [S / 2 + vx * (S / 2 - 22), S / 2 - vy * (S / 2 - 22)];
    const draw = () => {
      const g = c.getContext('2d');
      g.clearRect(0, 0, S, S);
      g.strokeStyle = theme('cv-ring'); g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 22, 0, Math.PI * 2); g.stroke();
      g.font = '600 11px Instrument Sans'; g.textAlign = 'center'; g.fillStyle = theme('cv-label');
      for (const [lab, a] of [['L', -30], ['C', 0], ['R', 30], ['Ls', -110], ['Rs', 110]]) {
        const r = a * Math.PI / 180, [px, py] = P(Math.sin(r), Math.cos(r));
        g.fillRect(px - 5, py - 4, 10, 8); g.fillText(lab, px, py + (Math.cos(r) > 0 ? -8 : 18));
      }
      const g6 = this.graphMod?.surroundGains?.(x, y);
      if (g6) { g.font = '10px Instrument Sans'; g.fillStyle = theme('cv-pad-text'); g.fillText(`L ${pct(g6[0])} C ${pct(g6[2])} R ${pct(g6[1])}`, S / 2, S / 2 - 4); g.fillText(`Ls ${pct(g6[4])} Rs ${pct(g6[5])}`, S / 2, S / 2 + 10); }
      const [dx, dy] = P(x, y);
      g.fillStyle = t.color; g.beginPath(); g.arc(dx, dy, 9, 0, Math.PI * 2); g.fill();
      g.strokeStyle = theme('cv-ink'); g.lineWidth = 2; g.stroke();
    };
    const pct = (v) => `${Math.round(v * v * 100)}%`;
    const commit = () => this.op('track.update', { trackId: t.id, pan: Math.round(x * 100) / 100, surroundY: Math.round(y * 100) / 100 }, 'Moved in surround');
    const set = (e) => {
      const r = c.getBoundingClientRect();
      let vx = ((e.clientX - r.left) / r.width * S - S / 2) / (S / 2 - 22), vy = -((e.clientY - r.top) / r.height * S - S / 2) / (S / 2 - 22);
      const m = Math.hypot(vx, vy); if (m > 1) { vx /= m; vy /= m; }
      x = vx; y = vy; this.liveTrack(t.id, { pan: x, surroundY: y }); draw();
    };
    c.addEventListener('pointerdown', (e) => { c.setPointerCapture(e.pointerId); this.interacting = true; set(e); c.onpointermove = set; });
    c.addEventListener('pointerup', () => { c.onpointermove = null; this.endInteraction(); commit(); });
    c.addEventListener('dblclick', () => { x = 0; y = 1; draw(); commit(); });
    c.addEventListener('keydown', (e) => {
      const d = { ArrowLeft: [-0.05, 0], ArrowRight: [0.05, 0], ArrowUp: [0, 0.05], ArrowDown: [0, -0.05] }[e.key];
      if (!d) return; e.preventDefault(); e.stopPropagation();
      x = clamp(x + d[0], -1, 1); y = clamp(y + d[1], -1, 1); draw(); clearTimeout(this.padTimer); this.padTimer = setTimeout(commit, 300);
    });
    if (this.graphMod) requestAnimationFrame(draw); else import('./engine/graph.js').then((m) => { this.graphMod = m; draw(); });
    return el('div', { class: 'surround' }, [
      el('div', { class: 'rack-head' }, [el('span', {}, 'Surround position')]), c,
      this.slider({ label: 'LFE send', min: -60, max: 6, step: 0.5, value: t.lfe ?? -60, reset: -60, fmt: (v) => (v <= -60 ? 'Off' : dbFmt(v)), onlive: (v) => this.liveTrack(t.id, { lfe: v }), oncommit: (v) => this.op('track.update', { trackId: t.id, lfe: v }) }),
    ]);
  }

  masterPanel() {
    const p = this.project;
    return el('div', { class: 'section' }, [
      el('h3', {}, 'Master bus'),
      el('div', { class: 'row layout-toggle', role: 'group', 'aria-label': 'Channel layout' }, [['stereo', 'Stereo'], ['5.1', '5.1 surround']].map(([v, l]) => el('button', { class: 'chip' + ((p.channels === 6) === (v === '5.1') ? ' on' : ''), onclick: () => this.op('project.setLayout', { layout: v }, `Switched to ${l}`) }, l))),
      p.channels === 6 ? el('p', { class: 'small muted' }, 'Six channels (L R C LFE Ls Rs). You hear a stereo fold-down; exports are true 5.1 (MP3 stays stereo).') : null,
      this.slider({ label: 'Output', min: -60, max: 12, step: 0.1, value: p.master.gain, fmt: dbFmt, reset: 0, onlive: (v) => this.liveMaster(v), oncommit: (v) => this.op('master.update', { gain: v }) }),
      this.effectRack(p.master.effects, null),
      el('label', { class: 'field inline' }, [el('span', {}, 'Sample rate'), el('select', { class: 'input', onchange: async (e) => {
        const sr = +e.target.value;
        if (!confirm(`Resample every file in this session to ${sr / 1000} kHz? Timing stays the same. This cannot be undone (save a version first if unsure).`)) { e.target.value = p.sampleRate; return; }
        try { await api.raw('POST', `/api/projects/${this.pid}/sample-rate`, { sampleRate: sr }); toast(`Session is now ${sr / 1000} kHz`, { kind: 'ok' }); } catch (err) { this.fail(err); }
      } }, [44100, 48000, 88200, 96000].map((v) => el('option', { value: v, selected: v === p.sampleRate }, `${v / 1000} kHz`)))]),
      el('p', { class: 'muted small' }, 'Preview and export run through the same audio graph.'),
    ]);
  }

  effectRack(effects, trackId) {
    const add = el('select', { class: 'input', 'aria-label': 'Add effect', onchange: (e) => { if (e.target.value) this.op('effect.add', { ...(trackId ? { trackId } : {}), type: e.target.value }); e.target.value = ''; } }, [
      el('option', { value: '' }, 'Add effect…'),
      ...Object.entries(EFFECTS).map(([k, v]) => el('option', { value: k }, v.label)),
    ]);
    const target = trackId ? 'track' : 'master';
    const presetBtn = el('button', { class: 'chip', onclick: async (e) => {
      const { clientX: x, clientY: y } = e;
      const mine = await api.userPresets().catch(() => []);
      menu(x, y, [
        ...Object.entries(PRESETS).filter(([, v]) => v.target === target).map(([k, v]) => ({ label: v.label, action: () => this.op('preset.apply', { ...(trackId ? { trackId } : {}), preset: k }, `Applied preset “${v.label}”`) })),
        ...(mine.length ? ['-', ...mine.map((u) => ({ label: `${u.name}`, action: () => api.applyUserPreset(this.pid, u.id, trackId).catch((err) => this.fail(err)) }))] : []),
        '-',
        { label: 'Save this chain as a preset…', disabled: !effects.length, action: async () => {
          const name = prompt('Preset name');
          if (!name) return;
          try { await api.saveUserPreset(this.pid, trackId, name); toast(`Saved preset “${name}”`, { kind: 'ok' }); } catch (err) { this.fail(err); }
        } },
      ]);
    } }, 'Presets');
    return el('div', { class: 'rack' }, [
      el('div', { class: 'rack-head' }, [el('span', {}, 'Effects'), el('div', { class: 'row' }, [
        el('button', { class: 'chip', title: 'Copy this effect chain', disabled: !effects.length, onclick: () => { this.fxClipboard = effects.map(({ type, enabled, params }) => ({ type, enabled, params: { ...params } })); toast(`Copied ${effects.length} effect${effects.length > 1 ? 's' : ''}`, { ms: 1500 }); } }, 'Copy'),
        el('button', { class: 'chip', title: 'Paste the copied effects after this chain', disabled: !this.fxClipboard?.length, onclick: () => this.ops(this.fxClipboard.flatMap((e) => [{ op: 'effect.add', args: { ...(trackId ? { trackId } : {}), type: e.type, params: e.params } }]), `Pasted ${this.fxClipboard.length} effects`) }, 'Paste'),
        presetBtn, add])]),
      ...effects.map((fx, i) => {
        const def = EFFECTS[fx.type];
        const open = this.openFx?.has(fx.id) ?? true;
        return el('div', { class: 'fx' + (fx.enabled ? '' : ' off') }, [
          el('div', { class: 'fx-head' }, [
            el('button', { class: 'fx-power' + (fx.enabled ? ' on' : ''), title: fx.enabled ? 'Bypass' : 'Enable', 'aria-label': fx.enabled ? 'Bypass effect' : 'Enable effect', onclick: () => this.op('effect.update', { effectId: fx.id, enabled: !fx.enabled }) }),
            el('button', { class: 'fx-name', onclick: () => { (this.openFx ||= new Set(effects.map((e) => e.id))); open ? this.openFx.delete(fx.id) : this.openFx.add(fx.id); this.renderInspector(); } }, def.label),
            i > 0 ? el('button', { class: 'icon-btn', title: 'Move up', 'aria-label': 'Move up', onclick: () => this.op('effect.move', { effectId: fx.id, index: i - 1 }) }, '↑') : null,
            el('button', { class: 'icon-btn', title: 'Remove', 'aria-label': 'Remove effect', onclick: () => this.op('effect.remove', { effectId: fx.id }) }, '×'),
          ]),
          open ? el('div', { class: 'fx-params' }, [fx.type === 'eq' ? this.eqCurve(fx) : null, ...Object.entries(def.params).map(([k, s]) => s.type === 'string' ? el('label', { class: 'field inline' }, [el('span', {}, k === 'ir' ? 'Impulse response' : paramLabel(k)), el('select', { class: 'input', onchange: (e) => this.op('effect.update', { effectId: fx.id, params: { [k]: e.target.value } }) }, [
            el('option', { value: '', disabled: true, selected: !fx.params[k] }, 'Choose a file from the bin…'),
            ...this.project.assets.map((a) => el('option', { value: a.id, selected: fx.params[k] === a.id }, `${a.name} (${a.duration.toFixed(1)} s)`)),
          ])]) : this.slider({
            label: paramLabel(k) + (([this.project.master, ...this.project.tracks].find((o) => o.automation?.[`fx:${fx.id}:${k}`]?.length)) ? ' (auto)' : ''), min: s.minimum, max: s.maximum, step: stepFor(s), value: fx.params[k] ?? s.default, reset: s.default, log: s.unit === 'Hz',
            fmt: (v) => fmtParam(v, s), onlive: (v) => { this.liveEffect(fx.id, { [k]: v }); this.drawEq?.(fx.id); }, oncommit: (v) => this.op('effect.update', { effectId: fx.id, params: { [k]: v } }),
          }))]) : null,
        ]);
      }),
    ]);
  }

  // Frequency response of an EQ instance, computed from the same biquads that play it.
  // Frequency response of an EQ instance, computed from the same biquads that play it.
  // Bands are draggable handles: x = frequency, y = gain, wheel = Q (mid bands).
  eqCurve(fx) {
    const c = el('canvas', { class: 'eq-curve', width: 560, height: 180, tabindex: 0, 'aria-label': 'EQ frequency response. Drag the band handles; mouse wheel changes the width of the mid bands.' });
    const W = c.width, H = c.height;
    const X = (f) => (Math.log(f / 20) / Math.log(1000)) * W;
    const F = (x) => 20 * Math.pow(1000, clamp(x / W, 0, 1));
    const Y = (db) => H / 2 - (db / 18) * (H / 2 - 10);
    const D = (y) => ((H / 2 - y) / (H / 2 - 10)) * 18;
    const BANDS = [
      { id: 'hp', f: 'hpFreq', label: 'Low cut', color: 'teal' },
      { id: 'low', f: 'lowFreq', g: 'lowGain', label: 'Low shelf', color: 'amber' },
      { id: 'm1', f: 'mid1Freq', g: 'mid1Gain', q: 'mid1Q', label: 'Mid 1', color: 'amber' },
      { id: 'm2', f: 'mid2Freq', g: 'mid2Gain', q: 'mid2Q', label: 'Mid 2', color: 'amber' },
      { id: 'high', f: 'highFreq', g: 'highGain', label: 'High shelf', color: 'amber' },
      { id: 'lp', f: 'lpFreq', label: 'High cut', color: 'teal' },
    ];
    const spec = EFFECTS.eq.params;
    let drag = null, hover = null;
    const handlePos = (b) => ({ x: X(fx.params[b.f]), y: b.g ? Y(fx.params[b.g]) : b.id === 'hp' ? Y(-6) : Y(-6) });
    const draw = () => {
      if (!this.graphMod) return;
      const ctx = this.player.ensureContext();
      const N = 280;
      const freqs = new Float32Array(N).map((_, i) => 20 * Math.pow(1000, i / (N - 1)));
      const total = new Float32Array(N).fill(0);
      const mag = new Float32Array(N), ph = new Float32Array(N);
      const e = this.graphMod.buildEffect(ctx, { ...fx, enabled: true });
      for (const n of e.nodes) if (n.getFrequencyResponse) { n.getFrequencyResponse(freqs, mag, ph); for (let i = 0; i < N; i++) total[i] += 20 * Math.log10(Math.max(mag[i], 1e-6)); }
      const g = c.getContext('2d');
      g.clearRect(0, 0, W, H);
      g.strokeStyle = theme('cv-plot-grid'); g.lineWidth = 1;
      g.font = '18px Instrument Sans'; g.fillStyle = theme('cv-plot-label');
      for (const f of [100, 1000, 10000]) { const x = X(f); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 4, H - 6); }
      for (const d of [-12, 0, 12]) { g.beginPath(); g.moveTo(0, Y(d)); g.lineTo(W, Y(d)); g.stroke(); }
      g.beginPath();
      for (let i = 0; i < N; i++) { const x = (i / (N - 1)) * W; i ? g.lineTo(x, Y(total[i])) : g.moveTo(x, Y(total[i])); }
      g.lineWidth = 3; g.strokeStyle = theme('amber'); g.stroke();
      g.lineTo(W, Y(0)); g.lineTo(0, Y(0)); g.closePath(); g.fillStyle = theme('amber', 0.12); g.fill();
      for (const b of BANDS) {
        const { x, y } = handlePos(b);
        const active = drag?.b === b || hover === b;
        const off = (b.id === 'hp' && fx.params.hpFreq <= 20) || (b.id === 'lp' && fx.params.lpFreq >= 20000) || (b.g && fx.params[b.g] === 0);
        g.beginPath(); g.arc(clamp(x, 8, W - 8), y, active ? 11 : 8, 0, Math.PI * 2);
        g.fillStyle = off && !active ? theme('cv-knob-off') : theme(b.color); g.fill();
        g.lineWidth = 2; g.strokeStyle = theme(b.color); g.stroke();
        if (active) {
          g.font = '600 20px Instrument Sans'; g.fillStyle = theme('cv-ink');
          const f = fx.params[b.f], txt = `${b.label} ${f >= 1000 ? (f / 1000).toFixed(1) + ' kHz' : Math.round(f) + ' Hz'}${b.g ? ` ${fx.params[b.g] > 0 ? '+' : ''}${fx.params[b.g].toFixed(1)} dB` : ''}${b.q ? ` Q ${fx.params[b.q].toFixed(2)}` : ''}`;
          const tw = g.measureText(txt).width;
          g.fillText(txt, clamp(x - tw / 2, 4, W - tw - 4), y > H / 2 ? y - 18 : y + 30);
        }
      }
    };
    const pos = (e) => { const r = c.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }; };
    const nearest = (p) => {
      let best = null, bd = 26;
      for (const b of BANDS) { const h = handlePos(b); const d = Math.hypot(clamp(h.x, 8, W - 8) - p.x, h.y - p.y); if (d < bd) { bd = d; best = b; } }
      return best;
    };
    const setLive = (patch) => { Object.assign(fx.params, patch); this.liveEffect(fx.id, patch); draw(); };
    c.addEventListener('pointerdown', (e) => {
      const b = nearest(pos(e));
      if (!b) return;
      e.preventDefault(); c.setPointerCapture(e.pointerId);
      this.interacting = true;
      drag = { b, before: { ...fx.params } };
      draw();
    });
    c.addEventListener('pointermove', (e) => {
      const p = pos(e);
      if (!drag) { const h = nearest(p); if (h !== hover) { hover = h; c.style.cursor = h ? 'grab' : 'default'; draw(); } return; }
      const b = drag.b, fs = spec[b.f];
      const patch = { [b.f]: Math.round(clamp(F(p.x), fs.minimum, fs.maximum)) };
      if (b.g) patch[b.g] = Math.round(clamp(D(p.y), spec[b.g].minimum, spec[b.g].maximum) * 10) / 10;
      setLive(patch);
    });
    const end = () => {
      if (!drag) return;
      const changed = {};
      for (const k of [drag.b.f, drag.b.g, drag.b.q].filter(Boolean)) if (fx.params[k] !== drag.before[k]) changed[k] = fx.params[k];
      drag = null;
      this.endInteraction();
      if (Object.keys(changed).length) this.op('effect.update', { effectId: fx.id, params: changed }, 'Shaped EQ');
      draw();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { if (!drag && hover) { hover = null; draw(); } });
    c.addEventListener('dblclick', (e) => {
      const b = nearest(pos(e));
      if (!b) return;
      const reset = b.id === 'hp' ? { hpFreq: 20 } : b.id === 'lp' ? { lpFreq: 20000 } : { [b.g]: 0 };
      setLive(reset);
      this.op('effect.update', { effectId: fx.id, params: reset }, `Reset ${b.label}`);
    });
    let wheelTimer;
    c.addEventListener('wheel', (e) => {
      const b = nearest(pos(e));
      if (!b?.q) return;
      e.preventDefault();
      const q = Math.round(clamp(fx.params[b.q] * Math.exp(-e.deltaY * 0.002), spec[b.q].minimum, spec[b.q].maximum) * 100) / 100;
      setLive({ [b.q]: q });
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => this.op('effect.update', { effectId: fx.id, params: { [b.q]: q } }, 'Changed EQ width'), 400);
    }, { passive: false });
    (this.eqDrawers ||= new Map()).set(fx.id, () => {
      const live = [this.project.master.effects, ...this.project.tracks.map((t) => t.effects)].flat().find((x) => x.id === fx.id);
      if (live) fx = live;
      draw();
    });
    this.drawEq = (id) => this.eqDrawers.get(id)?.();
    if (this.graphMod) requestAnimationFrame(draw);
    else import('./engine/graph.js').then((m) => { this.graphMod = m; draw(); });
    return c;
  }

  // Generic slider with live preview, commit on release, double-click to reset.
  slider({ label, min, max, step, value, fmt, reset, onlive, oncommit, log, taper }) {
    // Volume sliders (-60…+12 dB) use the console fader law so the useful range gets most of the travel.
    taper ??= min === -60 && max === 12 && !log;
    const toPos = (v) => (taper ? dbToFader(v) : log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min));
    const fromPos = (p) => { const v = taper ? faderToDb(p) : log ? min * Math.pow(max / min, p) : min + p * (max - min); return Math.round(v / step) * step; };
    const out = el('output', {}, fmt(value));
    const input = el('input', { type: 'range', min: 0, max: 1, step: 'any', value: toPos(value), 'aria-label': label });
    const val = () => clamp(+fromPos(+input.value).toFixed(6), min, max);
    input.addEventListener('pointerdown', () => (this.interacting = true));
    // A click that doesn't move the value fires no 'change': end the interaction anyway,
    // or remote updates stay deferred forever.
    const release = () => setTimeout(() => { if (this.interacting) this.endInteraction(); }, 0);
    input.addEventListener('pointerup', release);
    input.addEventListener('pointercancel', release);
    input.addEventListener('input', () => { out.textContent = fmt(val()); onlive?.(val()); });
    input.addEventListener('change', () => { this.endInteraction(); oncommit(val()); });
    input.addEventListener('dblclick', () => { if (reset === undefined) return; input.value = toPos(reset); out.textContent = fmt(reset); onlive?.(reset); oncommit(reset); });
    return el('label', { class: 'slider' }, [el('span', {}, label), input, out]);
  }
  miniSlider(o) { const s = this.slider(o); s.classList.add('mini'); return s; }
  endInteraction() {
    this.interacting = false;
    if (this.deferredRender) { this.deferredRender = false; setTimeout(() => this.renderAll(), 0); }
  }

  // ── measurement ────────────────────────────────────────────────────────
  analysisPanel() {
    const clips = this.selectedClips();
    const r = this.selection.range;
    const opts = [['mix', 'Whole mix'], ...(r ? [['range', 'Selected range (mix)']] : []), ...(clips.length === 1 ? [['clip', 'Selected clip source']] : [])];
    if (!opts.some(([v]) => v === this.analysisTarget)) this.analysisTarget = opts.find(([v]) => v === 'range') ? 'range' : 'mix';
    const select = el('select', { class: 'input', onchange: (e) => { this.analysisTarget = e.target.value; } }, opts.map(([v, l]) => el('option', { value: v, selected: v === this.analysisTarget }, l)));
    this.analysisOut ||= el('div', { class: 'analysis' }, el('p', { class: 'muted small' }, 'Loudness to EBU R128, true peak, clipping, spectral balance and pauses. The same numbers an agent gets from the API.'));
    this.checkOut ||= el('div', { class: 'check-out' });
    const std = el('select', { class: 'input', 'aria-label': 'Delivery standard' }, [['podcast', 'Podcast (Apple, Spotify)'], ['podcast-mono', 'Mono podcast'], ['ebu', 'Broadcast EBU R128'], ['atsc', 'US broadcast ATSC A/85'], ['streaming', 'Music streaming'], ['acx', 'Audiobook (ACX / Audible)']].map(([v, l]) => el('option', { value: v, selected: v === (this.checkStd || 'podcast') }, l)));
    std.addEventListener('change', () => (this.checkStd = std.value));
    return [el('div', { class: 'section' }, [
      el('h3', {}, 'Measure'),
      el('div', { class: 'row' }, [select, el('button', { class: 'btn primary', onclick: () => this.runAnalysis() }, 'Measure')]),
      this.analysisOut,
    ]), el('div', { class: 'section' }, [
      el('h3', {}, 'Ready to publish?'),
      el('p', { class: 'muted small' }, 'Checks the whole mix against a platform’s delivery spec.'),
      el('div', { class: 'row' }, [std, el('button', { class: 'btn', onclick: () => this.runCheck(std.value) }, 'Check')]),
      this.checkOut,
    ])];
  }

  async runAnalysis() {
    const clips = this.selectedClips();
    const r = this.selection.range;
    const target = this.analysisTarget === 'clip' && clips[0] ? { clipId: clips[0].clip.id } : this.analysisTarget === 'range' && r ? { start: r.start, end: r.end } : {};
    this.analysisOut.replaceChildren(el('p', { class: 'muted' }, 'Measuring…'));
    try {
      const a = await api.analyze(this.pid, target, { include: ['loudness', 'levels', 'silences', 'spectrum'] });
      this.analysisOut.replaceChildren(this.renderAnalysis(a));
    } catch (e) { this.analysisOut.replaceChildren(el('p', { class: 'error' }, e.message)); }
  }

  renderAnalysis(a) {
    const L = a.loudness, lv = a.levels;
    const verdict = L.integratedLufs === null ? 'Silent' : L.integratedLufs > -14.5 ? 'Loud (streaming platforms will turn it down)' : L.integratedLufs > -17.5 ? 'Podcast range (−16 LUFS)' : L.integratedLufs > -24.5 ? 'Broadcast range (−23 LUFS)' : 'Quiet';
    const sil = a.silencesTimeline || a.silences || [];
    const bands = a.spectrum?.bandsRelativeDb || {};
    return el('div', {}, [
      el('div', { class: 'lufs' }, [el('strong', {}, L.integratedLufs ?? '–∞'), el('span', {}, 'LUFS integrated')]),
      el('p', { class: 'muted small' }, verdict),
      el('dl', { class: 'stats' }, [
        ['True peak', L.truePeakDbtp !== null ? `${L.truePeakDbtp} dBTP` : '–'], ['Loudness range', `${L.loudnessRangeLu ?? '–'} LU`],
        ['Sample peak', `${lv.samplePeakDbfs} dBFS`], ['RMS', `${lv.rmsDbfs} dBFS`],
        ['Clipped samples', String(lv.clippedSamples)], ['Spectral centroid', a.spectrum ? `${a.spectrum.spectralCentroidHz} Hz` : '–'],
      ].map(([k, v]) => [el('dt', {}, k), el('dd', { class: k === 'Clipped samples' && lv.clippedSamples ? 'warn' : k === 'True peak' && L.truePeakDbtp > -1 ? 'warn' : '' }, v)])),
      Object.keys(bands).length ? el('div', { class: 'bands', title: 'Share of energy per band' }, Object.entries(bands).map(([k, v]) => el('div', { class: 'band' }, [el('i', { style: `height:${clamp((v + 40) / 40, 0.02, 1) * 100}%` }), el('span', {}, bandLabel(k))]))) : null,
      el('h3', { class: 'sub' }, `Pauses longer than 0.5 s: ${sil.length}`),
      sil.length && a.silencesTimeline ? el('div', { class: 'row wrap' }, [
        el('button', { class: 'btn', onclick: () => this.tightenPauses(sil, 0.35) }, 'Shorten pauses to 0.35 s'),
        el('button', { class: 'btn', onclick: () => this.ops(sil.map((s) => ({ op: 'marker.add', args: { time: s.start, duration: s.duration, label: 'pause' } })), `Marked ${sil.length} pauses`) }, 'Mark pauses'),
      ]) : null,
      el('ol', { class: 'pauses' }, sil.slice(0, 50).map((s) => el('li', {}, el('button', { class: 'link', onclick: () => { this.player.seek(s.start); this.timeline.reveal(s.start); this.selection.range = { start: s.start, end: s.end }; this.emitSelection(); } }, `${fmtTime(s.start, 2)} → ${s.duration.toFixed(2)} s`)))),
    ]);
  }

  // Like Audition's Match Loudness, but non-destructive: measures each clip and sets clip gain.
  async matchLoudness(clips, target) {
    toast(`Measuring ${clips.length} clips…`, { id: 'match', ms: 0 });
    try {
      const measured = await Promise.all(clips.map((c) => api.analyze(this.pid, { clipId: c.id }, { include: ['loudness'] }).then((a) => ({ c, lufs: a.loudness.integratedLufs }))));
      const valid = measured.filter((m) => m.lufs !== null && m.lufs > -70);
      if (!valid.length) { toast('Those clips are silent', { id: 'match', kind: 'error' }); return; }
      // Default target: the loudest clip's level (nothing gets pushed into clipping by gain-up).
      const goal = target ?? Math.max(...valid.map((m) => m.lufs + (m.c.gain || 0)));
      const ops = valid.map(({ c, lufs }) => ({ op: 'clip.update', args: { clipId: c.id, gain: Math.max(-60, Math.min(24, Math.round((goal - lufs) * 10) / 10)) } }));
      await this.ops(ops, `Matched loudness of ${ops.length} clips to ${goal.toFixed(1)} LUFS`);
      toast(`Matched ${ops.length} clips to ${goal.toFixed(1)} LUFS`, { id: 'match', kind: 'ok' });
    } catch (e) { toast(e.message, { id: 'match', kind: 'error', ms: 8000 }); }
  }

  async runCheck(standard) {
    this.checkOut.replaceChildren(el('p', { class: 'muted' }, 'Rendering and measuring the mix…'));
    try {
      const r = await api.check(this.pid, standard);
      const res = r.results[0];
      this.checkOut.replaceChildren(
        el('p', { class: 'verdict ' + (res.pass ? 'ok' : 'bad') }, res.pass ? `Meets ${res.label}` : `Not yet: ${res.checks.filter((c) => !c.pass).length} of ${res.checks.length} checks fail`),
        el('ul', { class: 'checks' }, res.checks.map((c) => el('li', { class: c.pass ? 'ok' : 'bad' }, [
          el('span', { class: 'mark', 'aria-label': c.pass ? 'passes' : 'fails' }, c.pass ? '✓' : '✗'),
          el('div', {}, [el('div', {}, [el('strong', {}, c.name), ` ${c.value}`, el('span', { class: 'muted' }, ` (target ${c.target})`)]), c.fix ? el('div', { class: 'small fix' }, c.fix) : null]),
        ]))),
      );
    } catch (e) { this.checkOut.replaceChildren(el('p', { class: 'error' }, e.message)); }
  }

  tightenPauses(silences, keep) {
    // Cut from the end backwards so earlier times stay valid.
    const ops = [...silences].sort((a, b) => b.start - a.start).filter((s) => s.duration > keep + 0.02)
      .map((s) => ({ op: 'range.delete', args: { start: s.start + keep / 2, end: s.end - keep / 2, crossfade: 8 } }));
    if (ops.length) this.ops(ops, `Shortened ${ops.length} pauses to ${keep} s`);
  }

  // ── processing ─────────────────────────────────────────────────────────
  async processDialog(assetId, clip) {
    this.processes ||= await api.processes();
    const asset = this.project.assets.find((a) => a.id === assetId);
    clip ||= this.selectedClips().find(({ clip: c }) => c.assetId === assetId)?.clip;
    // A timeline range over the clip becomes a source range for the process.
    const r = this.selection.range;
    let span = null;
    if (clip && r && r.end > clip.start && r.start < clip.start + clip.duration) {
      const a = Math.max(r.start, clip.start), b = Math.min(r.end, clip.start + clip.duration);
      span = { start: clip.offset + (a - clip.start), end: clip.offset + (b - clip.start), tl: [a, b] };
    }
    const onlyRange = span ? el('input', { type: 'checkbox', checked: true }) : null;
    const order = ['voiceDenoise', 'denoise', 'dehum', 'declip', 'dereverb', 'soundRemove', 'pitchCorrect', 'declick', 'deess', 'level', 'loudness', 'normalize', 'gate', 'centerExtract', 'phaseAlign', 'removeSilence', 'tempo', 'pitch', 'pitchBend', 'doppler', 'mono', 'reverse'].filter((k) => this.processes[k]);
    const names = { declip: 'Repair clipping', pitchCorrect: 'Correct pitch', voiceDenoise: 'Clean up voice (AI)', denoise: 'Reduce steady noise', dehum: 'Remove hum', declick: 'Remove clicks', deess: 'De-ess', level: 'Level speech', loudness: 'Match loudness', normalize: 'Normalize peak', gate: 'Noise gate', removeSilence: 'Shorten silences', tempo: 'Change tempo', pitch: 'Shift pitch', mono: 'Convert to mono', reverse: 'Reverse', centerExtract: 'Extract or remove centre', dereverb: 'Reduce reverb', soundRemove: 'Remove a sound', phaseAlign: 'Fix stereo phase', doppler: 'Doppler pass-by', pitchBend: 'Bend pitch (varispeed)' };
    let kind = 'denoise';
    const paramsBox = el('div', { class: 'proc-params' });
    const values = {};
    const desc = el('p', { class: 'muted small' });
    const list = el('div', { class: 'proc-list', role: 'listbox', 'aria-label': 'Process' });
    const draw = () => {
      list.replaceChildren(...order.map((k) => el('button', { class: 'proc' + (k === kind ? ' on' : ''), role: 'option', 'aria-selected': String(k === kind), onclick: () => { kind = k; draw(); } }, names[k])));
      const def = this.processes[kind];
      desc.textContent = def.description + (def.keepsLength ? ' Clips using this file switch to the result.' : ' Creates a new file; place it yourself.')
        + (kind === 'soundRemove' ? (span ? ' The selected range is used as the example of the sound; the whole file is cleaned unless you tick the box below.' : ' Tip: select an example of the sound on the timeline first, and its span fills in the learn range.') : '');
      if (onlyRange) { onlyRange.disabled = !def.keepsLength; if (!def.keepsLength || kind === 'soundRemove') onlyRange.checked = false; }
      for (const k of Object.keys(values)) delete values[k];
      paramsBox.replaceChildren(...Object.entries(def.params).map(([k, s]) => {
        values[k] = kind === 'soundRemove' && span && k === 'learnStart' ? span.start : kind === 'soundRemove' && span && k === 'learnEnd' ? span.end : s.default;
        if (s.enum) return el('label', { class: 'field inline' }, [el('span', {}, paramLabel(k)), el('select', { class: 'input', onchange: (e) => (values[k] = +e.target.value) }, s.enum.map((v) => el('option', { value: v, selected: v === s.default }, `${v} Hz`)))]);
        const KEYS = ['Chromatic (any note)', 'C', 'C♯ / D♭', 'D', 'D♯ / E♭', 'E', 'F', 'F♯ / G♭', 'G', 'G♯ / A♭', 'A', 'A♯ / B♭', 'B'];
        const MODES = { 'centerExtract.mode': ['Keep centre', 'Remove centre'], 'phaseAlign.centre': ['R onto L', 'Both to middle'], 'doppler.volumeChange': ['Pitch only', 'With fade'], 'pitchBend.curve': ['Linear', 'Ease in', 'Ease out'] };
        const secs = (v) => `${v.toFixed(2)} s`, st = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} st`;
        const fmt = kind === 'pitchCorrect' && k === 'key' ? (v) => KEYS[Math.round(v) + 1] : kind === 'pitchCorrect' && k === 'scale' ? (v) => (Math.round(v) ? 'Minor' : 'Major') : kind === 'pitchCorrect' && k === 'speed' ? (v) => (v < 5 ? 'Instant (robotic)' : `${Math.round(v)} ms`)
          : MODES[`${kind}.${k}`] ? (v) => MODES[`${kind}.${k}`][Math.round(v)]
          : kind === 'dereverb' && k === 'rt60' ? (v) => (v < 0.05 ? 'Automatic' : secs(v)) : kind === 'doppler' && k === 'passTime' ? (v) => (v < 0 ? 'Middle' : secs(v))
          : (kind === 'soundRemove' && /^learn/.test(k)) ? secs : kind === 'pitchBend' && /Semitones$/.test(k) ? st
          : /Hz$/.test(k) ? (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`) : kind === 'doppler' && k === 'speed' ? (v) => `${Math.round(v)} m/s` : kind === 'doppler' && k === 'distance' ? (v) => `${v.toFixed(1)} m` : kind === 'phaseAlign' && k === 'maxShiftMs' ? (v) => `±${v.toFixed(1)} ms`
          : (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
        const toDur = kind === 'trim' || (kind === 'soundRemove' && /^learn/.test(k)) || (kind === 'doppler' && k === 'passTime');
        const max = toDur ? asset.duration : s.maximum;
        const LABELS = { mode: 'Mode', lowHz: 'From', highHz: 'Up to', amount: 'Amount', rt60: 'Reverb time', sensitivity: 'Sensitivity', learnStart: 'Example starts', learnEnd: 'Example ends', maxShiftMs: 'Search range', centre: 'Align', speed: 'Speed', distance: 'Closest distance', passTime: 'Passes at', volumeChange: 'Volume', startSemitones: 'Start', endSemitones: 'End', curve: 'Curve' };
        const label = (kind !== 'pitchCorrect' && LABELS[k]) || paramLabel(k);
        return this.slider({ label, min: s.minimum, max, step: s.type === 'integer' ? 1 : (max - s.minimum) / 200, value: values[k], reset: s.default, fmt, oncommit: (v) => (values[k] = v), onlive: (v) => (values[k] = v) });
      }));
    };
    draw();
    // Preview: process a short span on the server and play it, with an A/B switch.
    const previewSpan = () => {
      if (span) return { start: span.start, end: Math.min(span.end, span.start + 20) };
      const c = clip, t = this.player.position;
      const s0 = c && t >= c.start && t < c.start + c.duration ? c.offset + (t - c.start) : (c ? c.offset : 0);
      return { start: s0, end: Math.min(asset.duration, s0 + 8) };
    };
    let prevSrc = null, prevBufs = null, abOriginal = false;
    const stopPrev = () => { try { prevSrc?.stop(); } catch {} prevSrc = null; prevBtn.textContent = 'Preview'; };
    const playPrev = () => {
      const ctx = this.player.ensureContext();
      const buf = abOriginal ? prevBufs.orig : prevBufs.proc;
      prevSrc = ctx.createBufferSource(); prevSrc.buffer = buf; prevSrc.connect(ctx.destination);
      prevSrc.onended = () => { if (prevSrc && prevSrc.buffer === buf) stopPrev(); };
      prevSrc.start(); prevBtn.textContent = 'Stop preview';
    };
    const prevBtn = el('button', { class: 'btn', type: 'button', onclick: async () => {
      if (prevSrc) return stopPrev();
      this.player.pause();
      const sp = previewSpan();
      prevBtn.textContent = 'Processing…';
      try {
        const ctx = this.player.ensureContext();
        if (ctx.state === 'suspended') await ctx.resume();
        const [proc, orig] = await Promise.all([
          api.processPreview(this.pid, assetId, { kind, params: { ...values }, ...sp }).then((ab) => ctx.decodeAudioData(ab)),
          this.player.loadAsset(assetId),
        ]);
        const sr = orig.sampleRate, s = Math.floor(sp.start * sr), n = Math.min(proc.length, orig.length - s);
        const o = ctx.createBuffer(orig.numberOfChannels, n, sr);
        for (let ch = 0; ch < orig.numberOfChannels; ch++) o.copyToChannel(orig.getChannelData(ch).subarray(s, s + n), ch);
        prevBufs = { proc, orig: o };
        playPrev();
      } catch (e) { prevBtn.textContent = 'Preview'; this.fail(e); }
    } }, 'Preview');
    const abBtn = el('button', { class: 'chip', type: 'button', title: 'Switch between processed and original while previewing', onclick: () => {
      abOriginal = !abOriginal; abBtn.textContent = abOriginal ? 'Hearing: original' : 'Hearing: processed'; abBtn.classList.toggle('on', abOriginal);
      if (prevSrc && prevBufs) { try { prevSrc.stop(); } catch {} playPrev(); }
    } }, 'Hearing: processed');
    list.addEventListener('click', () => { stopPrev(); prevBufs = null; });
    paramsBox.addEventListener('change', () => { prevBufs = null; });
    const m = modal(`Repair and process “${asset.name}”`, [el('div', { class: 'proc-grid' }, [list, el('div', {}, [desc, paramsBox,
      el('div', { class: 'row proc-preview' }, [prevBtn, abBtn, el('span', { class: 'muted small' }, span ? 'Plays the selected range' : 'Plays 8 s from the playhead')]),
      span ? el('label', { class: 'check' }, [onlyRange, ` Only the selected range (${fmtTime(span.tl[0], 2)} – ${fmtTime(span.tl[1], 2)}), with smooth edges`]) : el('p', { class: 'muted small' }, 'Tip: select a range on the timeline first to process only that part.'),
    ])])], {
      wide: true,
      actions: [{ label: 'Cancel' }, { label: 'Apply', primary: true, action: () => {
        this.interacting = false;
        stopPrev();
        const range = onlyRange?.checked ? { start: span.start, end: span.end } : {};
        api.process(this.pid, assetId, kind, { ...values }, true, range).catch((e) => this.fail(e));
      } }],
    });
    new MutationObserver(() => { if (!m.root.isConnected) stopPrev(); }).observe(document.body, { childList: true });
  }

  // ── dock: tabbed bottom panel; each tab is its own module ──────────────
  // Module contract: new Module(app) with .label and .render(container) — called
  // on every project/selection change while the tab is open; keep it cheap and
  // reuse DOM between calls where possible.
  dockTabs() {
    this.dockModules ||= { mixer: new MixerView(this), spectral: new SpectralView(this), transcript: new TranscriptView(this), markers: new MarkersView(this), video: new VideoView(this) };
    return this.dockModules;
  }
  openEditor(clipId) { this.dockClip = clipId; this.dockOpen = true; this.dockTab = 'spectral'; this.renderDock(); }
  openDock(tab) { this.dockOpen = true; this.dockTab = tab; this.renderDock(); }
  dockClipRef() {
    const all = this.project.tracks.flatMap((t) => t.clips.map((c) => ({ clip: c, track: t })));
    return (this.dockClip && all.find((x) => x.clip.id === this.dockClip)) || this.selectedClips()[0] || null;
  }
  renderDock() {
    const mods = this.dockTabs();
    this.dockTab ||= 'spectral';
    this.dock.classList.toggle('open', !!this.dockOpen);
    this.dockHead ||= el('div', { class: 'dock-head' });
    this.dockBody ||= el('div', { class: 'dock-body' });
    this.dockHead.replaceChildren(...[
      ...Object.entries(mods).map(([id, m]) => el('button', { class: 'chip' + (this.dockOpen && this.dockTab === id ? ' on' : ''), onclick: () => { if (this.dockOpen && this.dockTab === id) this.dockOpen = false; else { this.dockOpen = true; this.dockTab = id; } this.renderDock(); } }, m.label)),
      this.dockOpen ? el('button', { class: 'icon-btn', title: 'Hide panel', 'aria-label': 'Hide panel', onclick: () => { this.dockOpen = false; this.renderDock(); } }, '×') : null,
    ].filter(Boolean));
    if (!this.dock.contains(this.dockHead)) this.dock.replaceChildren(this.dockHead, this.dockBody);
    this.dockBody.hidden = !this.dockOpen;
    if (this.dockOpen) mods[this.dockTab].render(this.dockBody);
  }

  // ── export ─────────────────────────────────────────────────────────────
  exportDialog() {
    const fmt = el('select', { class: 'input' }, [['wav', 'WAV (lossless)'], ['flac', 'FLAC (lossless, smaller)'], ['mp3', 'MP3'], ['aac', 'AAC / M4A'], ['opus', 'Opus']].map(([v, l]) => el('option', { value: v }, l)));
    const depth = el('select', { class: 'input' }, [[24, '24-bit'], [16, '16-bit'], [32, '32-bit float']].map(([v, l]) => el('option', { value: v }, l)));
    const rate = el('select', { class: 'input' }, [[0, `Session rate (${this.project.sampleRate / 1000} kHz)`], [44100, '44.1 kHz'], [48000, '48 kHz'], [96000, '96 kHz']].map(([v, l]) => el('option', { value: v }, l)));
    const loud = el('select', { class: 'input' }, [['', 'Leave as mixed'], ['-16', 'Podcast: −16 LUFS'], ['-14', 'Streaming music: −14 LUFS'], ['-23', 'Broadcast EBU R128: −23 LUFS'], ['-19', 'Mono podcast: −19 LUFS']].map(([v, l]) => el('option', { value: v }, l)));
    const range = el('select', { class: 'input' }, [['all', 'Whole session'], ...(this.selection.range ? [['sel', 'Selected range']] : [])].map(([v, l]) => el('option', { value: v }, l)));
    const tail = el('input', { class: 'input num', type: 'number', min: 0, max: 30, step: 0.5, value: this.project.tracks.some((t) => t.effects.some((e) => e.type === 'reverb' || e.type === 'delay')) ? 2 : 0 });
    const labelled = this.project.markers.filter((m) => m.label).length;
    const chapters = el('input', { type: 'checkbox', checked: labelled > 0, disabled: !labelled });
    const result = el('div', { class: 'render-result' });
    const prev = el('ul', { class: 'renders' });
    api.renders(this.pid).then((rs) => prev.replaceChildren(...rs.slice(0, 6).map((r) => el('li', {}, [el('a', { href: api.fileUrl(r.url), download: '' }, `${r.format.toUpperCase()}`), ` ${(r.bytes / 1e6).toFixed(1)} MB, ${r.loudness?.integratedLufs ?? '?'} LUFS, ${relTime(r.createdAt)} by ${actorLabel(r.createdBy)}`])))).catch(() => {});
    const depthField = el('label', { class: 'field' }, ['Bit depth', depth]);
    fmt.addEventListener('change', () => { depthField.style.display = ['wav', 'flac'].includes(fmt.value) ? '' : 'none'; });
    const go = async (bounce, stems) => {
      const r = this.selection.range;
      const body = { format: fmt.value, bitDepth: +depth.value, tail: +tail.value || 0, chapters: chapters.checked, ...(+rate.value ? { sampleRate: +rate.value } : {}), ...(loud.value ? { loudness: { lufs: +loud.value, truePeak: -1 } } : {}), ...(range.value === 'sel' && r ? { start: r.start, end: r.end } : {}), ...(bounce ? { bounce: true } : {}), ...(stems ? { stems: true } : {}) };
      result.replaceChildren(el('p', { class: 'muted' }, bounce ? 'Bouncing…' : stems ? 'Rendering one file per track…' : 'Rendering…'));
      try {
        const out = await api.render(this.pid, body);
        if (out.stems) { result.replaceChildren(el('ul', { class: 'renders' }, out.stems.map((st) => el('li', {}, [el('a', { href: api.fileUrl(st.url), download: '' }, st.name), ` ${(st.bytes / 1e6).toFixed(1)} MB, ${st.loudness?.integratedLufs ?? '?'} LUFS`])))); return; }
        if (bounce) { result.replaceChildren(el('p', {}, `Added “${out.asset.name}” to Files.`)); return; }
        result.replaceChildren(el('p', {}, [el('a', { class: 'btn primary', href: api.fileUrl(out.url), download: '' }, 'Download'), `  ${(out.bytes / 1e6).toFixed(1)} MB · ${out.loudness?.integratedLufs ?? '?'} LUFS · true peak ${out.loudness?.truePeakDbtp ?? '?'} dBTP${out.chapters ? ` · ${out.chapters} chapters` : ''}`]));
      } catch (e) { result.replaceChildren(el('p', { class: 'error' }, e.message)); }
    };
    modal('Export', [
      el('div', { class: 'form-grid' }, [
        el('label', { class: 'field' }, ['Format', fmt]), depthField, el('label', { class: 'field' }, ['Sample rate', rate]),
        el('label', { class: 'field' }, ['Loudness', loud]), el('label', { class: 'field' }, ['Range', range]), el('label', { class: 'field' }, ['Tail (s) for reverb and echo', tail]),
      ]),
      el('details', { class: 'tags' }, [
        el('summary', {}, 'Tags (title, artist, album …)'),
        el('div', { class: 'form-grid' }, [['title', 'Title', this.project.name], ['artist', 'Artist / host'], ['album', 'Album / show'], ['track', 'Episode / track no.'], ['date', 'Year or date'], ['genre', 'Genre'], ['comment', 'Comment'], ['copyright', 'Copyright']].map(([k, l, ph]) => el('label', { class: 'field' }, [l, el('input', { class: 'input', value: this.project.metadata?.[k] || '', placeholder: ph || '', onchange: (e) => this.op('project.setMetadata', { [k]: e.target.value.trim() }, `Set ${l.toLowerCase()} tag`) })]))),
      ]),
      el('label', { class: 'check' }, [chapters, labelled ? ` Write the ${labelled} labelled marker${labelled > 1 ? 's' : ''} as chapters (MP3, M4A, Opus, FLAC)` : ' No labelled markers to use as chapters']),
      el('div', { class: 'row wrap' }, [el('button', { class: 'btn primary', onclick: () => go(false) }, 'Render'), el('button', { class: 'btn', title: 'One file per track', onclick: () => go(false, true) }, 'Render stems'), el('button', { class: 'btn', onclick: () => go(true) }, 'Bounce to Files'),
        el('button', { class: 'btn', title: 'CD image: 44.1 kHz/16-bit WAV plus a CUE sheet; labelled markers become CD tracks', onclick: async () => {
          result.replaceChildren(el('p', { class: 'muted' }, 'Rendering the CD image…'));
          try {
            const cd = await api.raw('POST', `/api/projects/${this.pid}/cd`, {});
            result.replaceChildren(el('p', {}, [el('a', { class: 'btn primary', href: api.fileUrl(cd.wav.url), download: '' }, 'Download WAV'), ' ', el('a', { class: 'btn', href: api.fileUrl(cd.cue.url), download: '' }, 'Download CUE'), `  ${cd.tracks.length} track${cd.tracks.length > 1 ? 's' : ''}: ${cd.tracks.map((t) => t.title).join(', ')}`]));
          } catch (e) { result.replaceChildren(el('p', { class: 'error' }, e.message)); }
        } }, 'CD image')]),
      result,
      el('h3', { class: 'sub' }, 'Earlier exports'), prev,
    ], { wide: true });
  }

  agentDialog() {
    modal('Agents', agentInfo(this.pid), { wide: true });
  }

  // ── recording (lossless, via AudioWorklet) ─────────────────────────────
  async toggleRecord() {
    if (this.recording) return this.stopRecord();
    const track = this.project.tracks.find((t) => t.id === this.selection.trackId && t.kind !== 'bus');
    if (!track) { toast('Select an audio track to record onto (or add one)'); return; }
    const { Recorder, audioSettings } = await import('./recorder.js');
    const settings = audioSettings();
    // Punch-in: with a range selected, record exactly into it after a 2 s pre-roll.
    const r = settings.punch && this.selection.range && this.selection.range.end - this.selection.range.start > 0.1 ? { ...this.selection.range } : null;
    try {
      this.recording = new Recorder(this.player, settings);
      await this.recording.start();
      Object.assign(this.recording, { trackId: track.id, punch: r });
      const from = r ? Math.max(0, r.start - 2) : this.player.position;
      this.recording.at = from;
      if (this.player.loop.on) { this.player.loop.on = false; }
      this.player.holdOpen = true; // keep running past the end of the session while recording
      await this.player.play(from);
      if (r) {
        const watch = () => { if (!this.recording || this.recording !== rec) return; if (this.player.position >= r.end + 0.15) this.stopRecord(); else requestAnimationFrame(watch); };
        const rec = this.recording; requestAnimationFrame(watch);
      }
      toast(r ? `Punch-in on “${track.name}” from ${fmtTime(r.start, 2)} to ${fmtTime(r.end, 2)} (2 s pre-roll)` : `Recording onto “${track.name}”… press R to stop`, { id: 'rec', ms: 0, kind: 'rec' });
    } catch (e) { this.recording = null; this.player.holdOpen = false; toast(`Microphone unavailable: ${e.message}`, { kind: 'error', ms: 8000 }); }
    this.updateTransport();
  }
  async stopRecord() {
    const rec = this.recording; this.recording = null;
    this.player.holdOpen = false;
    this.player.pause();
    this.updateTransport();
    toast('Saving recording…', { id: 'rec', ms: 0 });
    try {
      const { blob, latency, compensation: cmp } = await rec.stop();
      const asset = await api.upload(this.pid, blob, `Take ${new Date().toLocaleTimeString('en-GB')}`);
      const args = rec.punch
        ? { trackId: rec.trackId, assetId: asset.id, start: rec.punch.start, offset: Math.min(latency + (rec.punch.start - rec.at), asset.duration - 0.01), duration: rec.punch.end - rec.punch.start, fadeIn: 0.01, fadeOut: 0.01 }
        : { trackId: rec.trackId, assetId: asset.id, start: rec.at, offset: Math.min(latency, asset.duration / 2) };
      await this.ops([{ op: 'clip.add', args }], rec.punch ? 'Punched in a take' : 'Recorded a take');
      toast(`Recording saved · lined up by ${cmp.roundTripMs.toFixed(0)} ms (${cmp.source === 'measured' ? 'measured' : 'estimated — measure once in ⚙ for exact timing'})${cmp.nudgeMs ? `, nudge ${cmp.nudgeMs > 0 ? '+' : ''}${cmp.nudgeMs} ms` : ''}`, { id: 'rec', kind: 'ok', ms: cmp.source === 'measured' ? undefined : 7000 });
    } catch (e) { toast(`Recording failed: ${e.message}`, { id: 'rec', kind: 'error', ms: 8000 }); }
  }

  async generateDialog() {
    const voices = await api.raw('GET', '/api/voices').catch(() => []);
    const kind = el('select', { class: 'input' }, [['speech', 'Speech from text'], ['tone', 'Tone'], ['noise', 'Noise'], ['silence', 'Silence']].map(([v, l]) => el('option', { value: v }, l)));
    const text = el('textarea', { class: 'input', rows: 3, placeholder: 'What should the voice say?' });
    const voice = el('select', { class: 'input' }, voices.map((v) => el('option', { value: v }, v.replace(/-/g, ' '))));
    const freq = el('input', { class: 'input num', type: 'number', value: 440, min: 10, max: 20000 });
    const wave = el('select', { class: 'input' }, ['sine', 'square', 'triangle', 'sawtooth'].map((v) => el('option', { value: v }, v)));
    const color = el('select', { class: 'input' }, ['pink', 'white', 'brown'].map((v) => el('option', { value: v }, `${v} noise`)));
    const dur = el('input', { class: 'input num', type: 'number', value: 2, min: 0.05, step: 0.1 });
    const level = el('input', { class: 'input num', type: 'number', value: -18, min: -60, max: 0 });
    const place = el('input', { type: 'checkbox', checked: true });
    const rows = { speech: [el('label', { class: 'field' }, ['Text', text]), el('label', { class: 'field' }, ['Voice', voice])], tone: [el('label', { class: 'field' }, ['Frequency (Hz)', freq]), el('label', { class: 'field' }, ['Waveform', wave])], noise: [el('label', { class: 'field' }, ['Colour', color])], silence: [] };
    const box = el('div', { class: 'form-grid' });
    const common = el('div', { class: 'form-grid' }, [el('label', { class: 'field' }, ['Length (s)', dur]), el('label', { class: 'field' }, ['Level (dBFS)', level])]);
    const draw = () => { box.replaceChildren(...rows[kind.value]); common.hidden = kind.value === 'speech'; };
    kind.addEventListener('change', draw); draw();
    modal('Generate audio', [el('label', { class: 'field' }, ['What', kind]), box, common, el('label', { class: 'check' }, [place, ' Place it at the playhead on the selected track (or a new one)'])], {
      wide: true,
      actions: [{ label: 'Cancel' }, { label: 'Generate', primary: true, action: async () => {
        const b = { kind: kind.value, ...(kind.value === 'speech' ? { text: text.value, voice: voice.value } : { duration: +dur.value, level: +level.value }), ...(kind.value === 'tone' ? { frequency: +freq.value, waveform: wave.value } : {}), ...(kind.value === 'noise' ? { color: color.value } : {}) };
        if (place.checked) { const t = this.project.tracks.find((x) => x.id === this.selection.trackId && x.kind !== 'bus'); b.place = { ...(t ? { trackId: t.id } : {}), start: this.player.position }; }
        if (b.kind === 'speech' && !b.text.trim()) return false;
        toast('Generating…', { id: 'gen', ms: 0 });
        try { await api.raw('POST', `/api/projects/${this.pid}/generate`, b); toast('Added to Files', { id: 'gen', kind: 'ok' }); } catch (e) { toast(e.message, { id: 'gen', kind: 'error', ms: 8000 }); }
      } }],
    });
  }

  trackMenu(x, y) {
    menu(x, y, [
      { label: 'Add several tracks…', action: () => {
        const n = el('input', { class: 'input num', type: 'number', value: 4, min: 1, max: 64 });
        const kind = el('select', { class: 'input' }, [['audio', 'Audio tracks'], ['bus', 'Buses']].map(([v, l]) => el('option', { value: v }, l)));
        modal('Add tracks', [el('div', { class: 'form-grid' }, [el('label', { class: 'field' }, ['How many', n]), el('label', { class: 'field' }, ['Kind', kind])])], { actions: [{ label: 'Cancel' }, { label: 'Add', primary: true, action: () => {
          const count = Math.max(1, Math.min(64, Math.round(+n.value || 1)));
          this.ops(Array.from({ length: count }, () => ({ op: 'track.add', args: kind.value === 'bus' ? { kind: 'bus' } : {} })), `Added ${count} ${kind.value === 'bus' ? 'buses' : 'tracks'}`);
        } }] });
      } },
      { label: 'Remove tracks without clips', action: () => {
        const p = this.project;
        const unused = p.tracks.filter((t) => t.kind !== 'bus' && !t.clips.length);
        const unusedBuses = p.tracks.filter((t) => t.kind === 'bus' && !p.tracks.some((o) => o.output === t.id || (o.sends || []).some((s) => s.busId === t.id)));
        const all = [...unused, ...unusedBuses];
        if (!all.length) { toast('Every track is in use'); return; }
        this.ops(all.map((t) => ({ op: 'track.remove', args: { trackId: t.id } })), `Removed ${all.length} unused track${all.length > 1 ? 's' : ''}`);
      } },
    ]);
  }

  stackClip(clip, dir) {
    const track = this.project.tracks.find((t) => t.clips.some((c) => c.id === clip.id));
    const zs = track.clips.filter((c) => c.id !== clip.id).map((c) => c.z || 0);
    const z = dir > 0 ? Math.max(0, ...zs) + 1 : Math.min(0, ...zs) - 1;
    this.op('clip.update', { clipId: clip.id, z }, dir > 0 ? 'Brought clip to front' : 'Sent clip to back');
  }

  // Strip Silence (Audition 14.2): cut the quiet parts out of a clip without moving
  // anything, so multitrack sync is kept.
  async stripSilence(clip) {
    const thr = el('input', { class: 'input num', type: 'number', value: -45, min: -80, max: -10 });
    const min = el('input', { class: 'input num', type: 'number', value: 0.6, min: 0.1, step: 0.1 });
    const pad = el('input', { class: 'input num', type: 'number', value: 0.1, min: 0, step: 0.05 });
    modal(`Strip silence from “${clip.name}”`, [
      el('p', { class: 'small muted' }, 'Removes the quiet stretches from this clip and leaves gaps, so everything stays in sync (nothing moves).'),
      el('div', { class: 'form-grid' }, [el('label', { class: 'field' }, ['Quieter than (dBFS)', thr]), el('label', { class: 'field' }, ['For at least (s)', min]), el('label', { class: 'field' }, ['Keep around speech (s)', pad])]),
    ], { actions: [{ label: 'Cancel' }, { label: 'Strip silence', primary: true, action: async () => {
      try {
        const a = await api.analyze(this.pid, { clipId: clip.id }, { include: ['silences'], silenceThresholdDb: +thr.value, minSilence: +min.value });
        const track = this.project.tracks.find((t) => t.clips.some((c) => c.id === clip.id));
        const p = +pad.value;
        const spans = (a.silencesTimeline || []).map((s) => ({ start: s.start + (s.start > clip.start + 0.01 ? p : 0), end: s.end - (s.end < clip.start + clip.duration - 0.01 ? p : 0) })).filter((s) => s.end - s.start > 0.05);
        if (!spans.length) { toast('No silence found with those settings'); return; }
        await this.ops(spans.map((s) => ({ op: 'range.delete', args: { start: +s.start.toFixed(4), end: +s.end.toFixed(4), ripple: false, trackIds: [track.id], crossfade: 10 } })), `Stripped ${spans.length} silent stretch${spans.length > 1 ? 'es' : ''}`);
      } catch (e) { this.fail(e); }
    } }] });
  }

  fitDialog(clip) {
    const len = el('input', { class: 'input num', value: fmtTime(clip.duration, 2) });
    const mode = el('select', { class: 'input' }, [['remix', 'Remix: jump between matching beats (music keeps its tempo)'], ['stretch', 'Stretch: change the tempo, keep the pitch']].map(([v, l]) => el('option', { value: v }, l)));
    modal(`Fit “${clip.name}” to a length`, [
      el('label', { class: 'field' }, ['New length (m:ss.ss or seconds)', len]),
      el('label', { class: 'field' }, ['How', mode]),
      el('p', { class: 'small muted' }, 'Remix suits music beds: it cuts or repeats whole bars, and the jumps stay editable as clips. Stretch suits anything, within 0.25× to 4×.'),
    ], { actions: [{ label: 'Cancel' }, { label: 'Fit', primary: true, action: async () => {
      const d = parseTime(len.value);
      if (!(d > 0)) return false;
      const url = `/api/projects/${this.pid}/clips/${clip.id}/${mode.value}`;
      toast(mode.value === 'remix' ? 'Listening for beats…' : 'Stretching…', { id: 'fit', ms: 0 });
      try { await api.raw('POST', url, { duration: d }); toast('Done', { id: 'fit', kind: 'ok' }); } catch (e) { toast(e.message, { id: 'fit', kind: 'error', ms: 8000 }); }
    } }] });
  }

  async audioSettingsDialog() {
    const { audioSettings, saveAudioSettings, calibrateLatency, measuredLatency, withMeasuredLatency } = await import('./recorder.js');
    const s = audioSettings();
    let devices = [];
    try { devices = await navigator.mediaDevices.enumerateDevices(); } catch {}
    const ins = devices.filter((d) => d.kind === 'audioinput'), outs = devices.filter((d) => d.kind === 'audiooutput');
    const inSel = el('select', { class: 'input' }, [el('option', { value: '' }, 'System default'), ...ins.map((d, i) => el('option', { value: d.deviceId, selected: d.deviceId === s.inputId }, d.label || `Input ${i + 1}`))]);
    const outSel = el('select', { class: 'input', disabled: !this.player.ensureContext().setSinkId }, [el('option', { value: '' }, 'System default'), ...outs.map((d, i) => el('option', { value: d.deviceId, selected: d.deviceId === s.outputId }, d.label || `Output ${i + 1}`))]);
    const chSel = el('select', { class: 'input' }, [[1, 'Mono'], [2, 'Stereo']].map(([v, l]) => el('option', { value: v, selected: v === (s.channels || 1) }, l)));
    const mon = el('input', { type: 'checkbox', checked: !!s.monitor });
    const punch = el('input', { type: 'checkbox', checked: s.punch !== false });
    const ctx = this.player.ensureContext();
    const est = ((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000;
    const cur = () => ({ ...s, inputId: inSel.value || undefined, outputId: outSel.value || undefined });
    const latText = () => { const m = measuredLatency(cur()); return m !== undefined ? `Measured round trip for these devices: ${(m * 1000).toFixed(1)} ms (used to line takes up).` : `Not measured for these devices yet. Takes use the browser’s estimate (output ${est.toFixed(1)} ms + input latency); measuring is more exact.`; };
    const latOut = el('p', { class: 'small' }, latText());
    inSel.addEventListener('change', () => (latOut.textContent = latText()));
    outSel.addEventListener('change', () => (latOut.textContent = latText()));
    const nudgeVal = el('output', { class: 'small' }, `${s.nudgeMs || 0} ms`);
    const nudge = el('input', { type: 'range', min: -100, max: 100, step: 1, value: s.nudgeMs || 0, 'aria-label': 'Take nudge in milliseconds', oninput: (e) => (nudgeVal.textContent = `${e.target.value > 0 ? '+' : ''}${e.target.value} ms`) });
    const measure = el('button', { class: 'btn', onclick: async () => {
      measure.disabled = true; latOut.textContent = 'Listening for eight short test sounds…';
      try { const c = cur(); const r = await calibrateLatency(this.player, c); const l = r.latency; Object.assign(s, withMeasuredLatency(c, l)); saveAudioSettings({ ...audioSettings(), latencies: s.latencies }); latOut.textContent = `Measured round trip for these devices: ${(l * 1000).toFixed(1)} ms (${r.hits}/${r.of} test sounds heard, spread ${r.spreadMs.toFixed(1)} ms${r.spreadMs > 3 ? ' — a bit unsteady, measuring again in a quieter moment may help' : ', very steady'}). Saved.`; }
      catch (e) { latOut.textContent = e.message; }
      measure.disabled = false;
    } }, 'Measure latency');
    modal('Audio settings', [
      el('div', { class: 'form-grid' }, [el('label', { class: 'field' }, ['Input', inSel]), el('label', { class: 'field' }, ['Record as', chSel]), el('label', { class: 'field' }, ['Output', outSel])]),
      el('label', { class: 'check' }, [mon, ' Hear the input through NyxMix while recording (use headphones)']),
      el('p', { class: 'small muted' }, 'For zero-latency monitoring, use your interface’s direct-monitor switch or knob and leave the option above off; takes still land exactly in time thanks to the measured latency below.'),
      el('label', { class: 'check' }, [punch, ' Punch in: with a range selected, record only into that range after a 2 s pre-roll']),
      el('h3', { class: 'sub' }, 'Latency'),
      el('p', { class: 'small muted' }, 'For takes that sit exactly in time, measure once per setup — it takes about 3 seconds and NyxMix remembers the result for these devices:'),
      el('ul', { class: 'small muted lat-howto' }, [
        el('li', {}, [el('strong', {}, 'Speakers: '), 'hold the mic about 20–50 cm in front of them, normal volume is enough. Closer is better (every metre adds ~3 ms).']),
        el('li', {}, [el('strong', {}, 'Headphones: '), 'hold one ear cup right in front of the mic. Best if you record with headphones, because it measures exactly the path you sing to.']),
        el('li', {}, [el('strong', {}, 'Most exact: '), 'a cable from an output of your interface into one of its inputs (no room in between).']),
        el('li', {}, 'Pick the same input and output above that you record with, and stay quiet for the 3 seconds.'),
      ]),
      latOut, measure,
      el('label', { class: 'field' }, ['Fine-tune takes (take sits late → +, sits early → −)', el('div', { class: 'row' }, [nudge, nudgeVal])]),
      el('p', { class: 'small muted' }, 'If takes still sit a hair early or late, move this once; it applies to every new take. 0 is right after a measurement.'),
    ], { wide: true, actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, action: async () => {
      const next = { ...audioSettings(), inputId: inSel.value || undefined, outputId: outSel.value || undefined, channels: +chSel.value, monitor: mon.checked, punch: punch.checked, nudgeMs: +nudge.value };
      saveAudioSettings(next);
      if (ctx.setSinkId) try { await ctx.setSinkId(next.outputId || ''); } catch (e) { toast(`Output device: ${e.message}`, { kind: 'error' }); }
    } }] });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────
function agentInfo(pid) {
  const origin = location.origin;
  const token = getToken();
  const tokenHeader = token ? ` --header "Authorization: Bearer ${token}"` : '';
  const code = (s) => el('div', { class: 'code' }, [el('pre', {}, s), el('button', { class: 'chip', onclick: (e) => { navigator.clipboard?.writeText(s); e.target.textContent = 'Copied'; setTimeout(() => (e.target.textContent = 'Copy'), 1200); } }, 'Copy')]);
  const nameInput = el('input', { class: 'input', value: getName(), placeholder: 'Your name', onchange: (e) => setName(e.target.value.trim()) });
  return el('div', { class: 'agent-info' }, [
    el('p', {}, 'Agents edit the same session you see. Their changes show up instantly, outlined in violet, and every edit lands in the session log with its author. Anything they do can be undone.'),
    el('h3', { class: 'sub' }, 'Claude Code and other MCP clients'),
    code(`claude mcp add --transport http nyxmix ${origin}/mcp${tokenHeader}`),
    el('h3', { class: 'sub' }, 'Any HTTP agent'),
    el('p', { class: 'small' }, [el('a', { href: '/llms.txt', target: '_blank' }, 'llms.txt'), ' explains the model in plain words; ', el('a', { href: '/openapi.json', target: '_blank' }, 'openapi.json'), ' has every endpoint. Send ', el('code', {}, 'X-Actor: agent:<name>'), ' so you can see who did what.']),
    code(`curl -s ${origin}/api/projects${pid ? `/${pid}/summary` : ''}${token ? ` -H "Authorization: Bearer ${token}"` : ''}`),
    pid ? el('p', { class: 'small muted' }, `This session’s id: ${pid}`) : null,
    el('h3', { class: 'sub' }, 'Your name in the session log'),
    nameInput,
  ]);
}

function tokenForm(done) {
  const input = el('input', { class: 'input', type: 'password', placeholder: 'Access token' });
  return el('div', { class: 'token-form' }, [
    el('h2', {}, 'This NyxMix server needs an access token'),
    el('div', { class: 'row' }, [input, el('button', { class: 'btn primary', onclick: () => { setToken(input.value.trim()); done(); } }, 'Continue')]),
  ]);
}

function actorLabel(a = '') {
  if (a.startsWith('human:')) { const n = a.slice(6); return n === 'you' || n === getName() ? 'You' : n; }
  return a.replace(/^agent:/, '') || 'agent';
}
const dbFmt = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
const panFmt = (v) => (Math.abs(v) < 0.005 ? 'Center' : v < 0 ? `${Math.round(-v * 100)}% L` : `${Math.round(v * 100)}% R`);
function paramLabel(k) {
  const map = { key: 'Key', scale: 'Scale', speed: 'Retune speed', maxCorrection: 'Max correction (st)', threshold: 'Threshold', b31: '31 Hz', b63: '63 Hz', b125: '125 Hz', b250: '250 Hz', b500: '500 Hz', b1k: '1 kHz', b2k: '2 kHz', b4k: '4 kHz', b8k: '8 kHz', b16k: '16 kHz', lowCross: 'Low/mid split', highCross: 'Mid/high split', lowThreshold: 'Low threshold', lowRatio: 'Low ratio', lowMakeup: 'Low makeup', midThreshold: 'Mid threshold', midRatio: 'Mid ratio', midMakeup: 'Mid makeup', highThreshold: 'High threshold', highRatio: 'High ratio', highMakeup: 'High makeup', Q: 'Q / resonance', bits: 'Bit depth', detune: 'Detune (cents)', hpFreq: 'Low cut', lowFreq: 'Low shelf freq', lowGain: 'Low shelf', mid1Freq: 'Mid 1 freq', mid1Gain: 'Mid 1 gain', mid1Q: 'Mid 1 Q', mid2Freq: 'Mid 2 freq', mid2Gain: 'Mid 2 gain', mid2Q: 'Mid 2 Q', highFreq: 'High shelf freq', highGain: 'High shelf', lpFreq: 'High cut', preDelay: 'Pre-delay', peakDb: 'Peak', lufs: 'Target', truePeak: 'True peak limit', noiseFloorDb: 'Noise floor', thresholdDb: 'Threshold', attackMs: 'Attack', releaseMs: 'Release', minSilence: 'Pauses longer than', keep: 'Shorten to', semitones: 'Semitones' };
  return map[k] || k.charAt(0).toUpperCase() + k.slice(1);
}
// Integer parameters whose values are named choices (described as "Integer: 0 x, 1 y, …").
export function choicesFor(s) {
  const m = /^Integer:\s*(.*)$/.exec(s.description || '');
  if (!m) return null;
  return m[1].split(',').map((part) => part.trim().replace(/^\d+\s*/, '')).map((t) => t.charAt(0).toUpperCase() + t.slice(1));
}
function stepFor(s) {
  if (choicesFor(s) || s.type === 'integer') return 1; return s.unit === 'Hz' ? 1 : s.maximum - s.minimum > 50 ? 0.5 : s.maximum - s.minimum > 5 ? 0.1 : 0.01; }
function fmtParam(v, s) {
  const ch = choicesFor(s);
  if (ch) return ch[Math.round(v)] || String(Math.round(v));
  if (s.unit === 'Hz') return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${Math.round(v)} Hz`;
  if (s.unit === 'dB') return dbFmt(v);
  if (s.unit === 'ms') return `${v.toFixed(v < 10 ? 1 : 0)} ms`;
  if (s.unit === 's') return `${v.toFixed(2)} s`;
  if (s.maximum <= 1) return `${Math.round(v * 100)}%`;
  return v.toFixed(v < 10 ? 2 : 1);
}
function bandLabel(k) { return { sub: 'Sub', bass: 'Bass', lowMid: 'Low mid', mid: 'Mid', highMid: 'High mid', presence: 'Presence', brilliance: 'Air' }[k] || k; }

function logo() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 32 32'); s.setAttribute('class', 'logo'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<path d="M3 16h4l2.4-7 3.3 15 3.3-19 3.3 17 2.2-9 2 3H29" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`;
  return s;
}
function icon(name) {
  const paths = {
    play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>',
    pause: '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/>',
    start: '<rect x="5" y="5" width="2.5" height="14" rx="1" fill="currentColor"/><path d="M19 5v14L9 12z" fill="currentColor"/>',
    loop: '<path d="M5 12a5 5 0 0 1 5-5h8m-3-3 3 3-3 3M19 12a5 5 0 0 1-5 5H6m3 3-3-3 3-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    rec: '<circle cx="12" cy="12" r="6" fill="currentColor"/>',
    settings: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="7" r="2.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="10" cy="17" r="2.2" fill="none" stroke="currentColor" stroke-width="2"/>',
    undo: '<path d="M9 7 4 12l5 5M4 12h10a6 6 0 0 1 0 12" transform="translate(0 -3)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    redo: '<path d="m15 7 5 5-5 5M20 12H10a6 6 0 0 0 0 12" transform="translate(0 -3)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  };
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = paths[name];
  return s;
}

window.klang = new App(document.getElementById('app'));
