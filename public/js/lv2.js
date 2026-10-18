// Native LV2 plugins: a browser of the server's catalog and an editor generated from the
// plugin's controls. Plugins run on the server (ffmpeg lv2); preview plays a processed span
// with an A/B switch against the original, Apply makes a new asset swapped into the clips.
import { api, getToken, actor, ApiError } from './api.js';
import { el, fmtTime, modal, toast } from './ui.js';

const RECENT_KEY = 'klang.lv2.recent';
const loadRecent = () => { try { const v = JSON.parse(localStorage.getItem(RECENT_KEY)); return Array.isArray(v) ? v.filter((x) => x && typeof x.uri === 'string') : []; } catch { return []; } };
const saveRecent = (uri, controls) => {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([{ uri, controls }, ...loadRecent().filter((x) => x.uri !== uri)].slice(0, 10))); } catch {}
};

async function post(path, body, binary) {
  const h = { 'Content-Type': 'application/json', 'X-Actor': actor() };
  const t = getToken();
  if (t) h.Authorization = `Bearer ${t}`;
  const res = await fetch(path, { method: 'POST', headers: h, body: JSON.stringify(body) });
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new ApiError(res.status, j.error?.code || `http_${res.status}`, j.error?.message || res.statusText); }
  return binary ? res.arrayBuffer() : res.json();
}

let catalogP = null;
const catalog = () => (catalogP ||= api.raw('GET', '/api/lv2').catch((e) => { catalogP = null; throw e; }));
const details = new Map();
const plugin = (index) => { if (!details.has(index)) details.set(index, api.raw('GET', `/api/lv2/${index}`).catch((e) => { details.delete(index); throw e; })); return details.get(index); };

const shortName = (p) => p.name.replace(/^(LSP|Calf)\s+/, '').replace(/^x42-\w+\s+-\s+/, '');
const chLabel = (c) => `${c.in === 1 ? 'mono' : 'stereo'}${c.out !== c.in ? ` → ${c.out === 1 ? 'mono' : 'stereo'}` : ''}`;

function fmtValue(p, v) {
  if (p.enum) return p.enum.find((e) => e.value === v)?.label ?? String(v);
  const n = Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3);
  // Calf and LSP express levels as linear gain factors: show them in dB.
  const gainLike = p.unit === 'G' || (!p.unit && !p.integer && p.min >= 0 && p.max <= 128 && /gain|threshold|level|makeup|input|output/i.test(p.name));
  if (gainLike) return `${v > 0 ? (20 * Math.log10(v)).toFixed(1) : '−∞'} dB`;
  if (p.unit === 'dB') return `${v.toFixed(1)} dB`;
  if (p.unit === 'Hz' && v >= 1000) return `${(v / 1000).toFixed(2)} kHz`;
  return p.unit ? `${n} ${p.unit}` : n;
}

// One control → a row. Sliders map 0..1 linearly, logarithmically (Hz, gains) or, when a
// log control starts at 0, along a cubic curve so the useful low end is not squashed.
function control(p, value, onchange) {
  const set = (v) => { onchange(v); row.classList.toggle('changed', v !== p.default); };
  let row;
  if (p.toggle) {
    const cb = el('input', { type: 'checkbox', checked: !!value, onchange: (e) => set(e.target.checked ? 1 : 0) });
    row = el('label', { class: 'lv2-ctl lv2-toggle', title: p.symbol }, [el('span', { class: 'lv2-ctl-name' }, p.name), cb]);
  } else if (p.enum) {
    const sel = el('select', { class: 'input', 'aria-label': p.name, onchange: (e) => set(+e.target.value) }, p.enum.map((e) => el('option', { value: e.value, selected: e.value === value }, e.label)));
    row = el('label', { class: 'lv2-ctl', title: p.symbol }, [el('span', { class: 'lv2-ctl-name' }, p.name), sel]);
  } else {
    const { min, max } = p;
    const mode = p.log ? (min > 0 ? 'log' : 'cube') : 'lin';
    const toPos = (v) => (mode === 'log' ? Math.log(v / min) / Math.log(max / min) : mode === 'cube' ? Math.cbrt((v - min) / (max - min)) : (v - min) / (max - min));
    const fromPos = (x) => { let v = mode === 'log' ? min * Math.pow(max / min, x) : mode === 'cube' ? min + (max - min) * x ** 3 : min + x * (max - min); v = Math.min(max, Math.max(min, v)); return p.integer ? Math.round(v) : +v.toPrecision(5); };
    const range = el('input', { type: 'range', min: 0, max: 1, step: p.integer ? 1 / Math.max(1, max - min) : 'any', value: toPos(value), 'aria-label': p.name });
    const out = el('output', {}, fmtValue(p, value));
    const num = el('input', { class: 'input lv2-num', inputmode: 'decimal', value: String(value), 'aria-label': `${p.name} value`, title: `${min} … ${max}${p.unit && p.unit !== 'G' ? ` ${p.unit}` : ''}` });
    const apply = (v, from) => { if (from !== 'range') range.value = toPos(v); if (from !== 'num') num.value = String(v); out.textContent = fmtValue(p, v); set(v); };
    range.addEventListener('input', () => apply(fromPos(+range.value), 'range'));
    range.addEventListener('dblclick', () => apply(p.default));
    num.addEventListener('change', () => { const v = parseFloat(num.value); if (!Number.isFinite(v)) { num.value = String(value); return; } apply(Math.min(max, Math.max(min, p.integer ? Math.round(v) : v))); });
    row = el('div', { class: 'lv2-ctl lv2-slider', title: `${p.symbol} · double-click the slider to reset` }, [el('span', { class: 'lv2-ctl-name' }, p.name), range, num, out]);
  }
  row.classList.toggle('changed', value !== p.default);
  return row;
}

export async function openLv2Dialog(app, assetId, clip) {
  const asset = app.project.assets.find((a) => a.id === assetId);
  if (!asset) return;
  clip ||= app.selectedClips().find(({ clip: c }) => c.assetId === assetId)?.clip;
  const r = app.selection.range;
  let span = null;
  if (clip && r && r.end > clip.start && r.start < clip.start + clip.duration) {
    const a = Math.max(r.start, clip.start), b = Math.min(r.end, clip.start + clip.duration);
    span = { start: clip.offset + (a - clip.start), end: clip.offset + (b - clip.start), tl: [a, b] };
  }

  let cat;
  try { cat = await catalog(); } catch (e) { app.fail(e); return; }
  if (!cat.plugins.length) { toast('No LV2 plugins are available on this server.', { kind: 'error' }); return; }

  let current = null, values = {}, query = '', category = '', brand = '', showAll = false, ctlFilter = '';
  const recent = loadRecent();

  // ── browser ──
  const search = el('input', { class: 'input', type: 'search', placeholder: 'Search plugins', 'aria-label': 'Search plugins', oninput: (e) => { query = e.target.value; drawList(); } });
  const catSel = el('select', { class: 'input', 'aria-label': 'Category', onchange: (e) => { category = e.target.value; drawList(); } },
    [el('option', { value: '' }, 'All categories'), ...Object.entries(cat.categories).sort().map(([c, n]) => el('option', { value: c }, `${c} (${n})`))]);
  const brandSel = el('select', { class: 'input', 'aria-label': 'Maker', onchange: (e) => { brand = e.target.value; drawList(); } },
    [el('option', { value: '' }, 'All makers'), ...Object.entries(cat.brands).sort().map(([b, n]) => el('option', { value: b }, `${b} (${n})`))]);
  const list = el('div', { class: 'lv2-list', role: 'listbox', 'aria-label': 'Plugins' });
  const item = (p) => el('button', { type: 'button', role: 'option', class: 'lv2-item' + (current?.uri === p.uri ? ' on' : ''), 'aria-selected': String(current?.uri === p.uri), onclick: () => select(p) }, [
    el('span', { class: 'lv2-item-name' }, shortName(p)),
    el('span', { class: 'lv2-item-meta' }, `${p.brand} · ${p.category} · ${chLabel(p.channels)}`),
  ]);
  function drawList() {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = cat.plugins.filter((p) => (!category || p.category === category) && (!brand || p.brand === brand) && words.every((w) => `${p.name} ${p.brand} ${p.category}`.toLowerCase().includes(w)));
    const kids = [];
    const rec = !words.length && !category && !brand ? recent.map((x) => cat.plugins.find((p) => p.uri === x.uri)).filter(Boolean) : [];
    if (rec.length) kids.push(el('div', { class: 'lv2-group' }, 'Recently used'), ...rec.map(item), el('div', { class: 'lv2-group' }, 'All plugins'));
    let lastCat = null;
    for (const p of hits) {
      if (!category && p.category !== lastCat && !words.length) { kids.push(el('div', { class: 'lv2-subgroup' }, p.category)); lastCat = p.category; }
      kids.push(item(p));
    }
    if (!hits.length) kids.push(el('p', { class: 'muted small lv2-none' }, 'No plugin matches.'));
    list.replaceChildren(...kids);
  }

  // ── editor ──
  const editor = el('div', { class: 'lv2-editor' });
  const params = el('div', { class: 'lv2-params' });
  function drawParams() {
    if (!current) return;
    const words = ctlFilter.toLowerCase().split(/\s+/).filter(Boolean);
    const all = current.params.filter((p) => words.every((w) => `${p.name} ${p.symbol}`.toLowerCase().includes(w)));
    const LIMIT = 48;
    const shown = showAll || words.length ? all : all.slice(0, LIMIT);
    params.replaceChildren(...[...shown.map((p) => control(p, values[p.symbol] ?? p.default, (v) => { values[p.symbol] = v; prevBufs = null; })),
      all.length > shown.length ? el('button', { class: 'link small', type: 'button', onclick: () => { showAll = true; drawParams(); } }, `Show all ${all.length} controls`) : null,
      !all.length ? el('p', { class: 'muted small' }, current.params.length ? 'No control matches.' : 'This plugin has no adjustable controls.') : null].filter(Boolean));
  }
  function drawEditor() {
    if (!current) {
      editor.replaceChildren(el('div', { class: 'lv2-empty' }, [
        el('p', {}, 'Pick a plugin on the left.'),
        el('p', { class: 'muted small' }, `${cat.available} native LV2 effects from ${Object.keys(cat.brands).join(', ')} run on the server, so the result is exactly what you hear in the preview and in exports.`),
      ]));
      return;
    }
    editor.replaceChildren(...[
      el('div', { class: 'lv2-head' }, [
        el('div', {}, [el('h3', {}, current.name), el('p', { class: 'muted small' }, `${current.brand} · ${current.category} · ${chLabel(current.channels)} · ${current.params.length} controls${current.latency ? ' · latency compensated' : ''}`)]),
        el('button', { class: 'link small', type: 'button', title: 'Back to the plugin defaults', onclick: () => { values = {}; prevBufs = null; drawParams(); } }, 'Reset to defaults'),
      ]),
      current.params.length > 16 ? el('input', { class: 'input lv2-filter', type: 'search', placeholder: 'Filter controls', 'aria-label': 'Filter controls', value: ctlFilter, oninput: (e) => { ctlFilter = e.target.value; drawParams(); } }) : null,
      params,
      asset.channels === 1 && current.channels.in === 2 ? el('p', { class: 'muted small' }, 'Mono file: the plugin gets the same signal on both inputs and the result is folded back to mono.') : null,
      asset.channels === 2 && current.channels.in === 1 && current.channels.out === 1 ? el('p', { class: 'muted small' }, 'Stereo file: this mono plugin runs once per channel.') : null,
    ].filter(Boolean));
    drawParams();
  }
  async function select(p) {
    stopPrev(); prevBufs = null;
    try {
      current = await plugin(p.index);
      values = { ...(recent.find((x) => x.uri === p.uri)?.controls || {}) };
      for (const k of Object.keys(values)) { const d = current.params.find((x) => x.symbol === k); if (!d || typeof values[k] !== 'number' || values[k] < d.min || values[k] > d.max) delete values[k]; }
      showAll = false; ctlFilter = '';
      drawList(); drawEditor();
    } catch (e) { app.fail(e); }
  }
  const body = () => {
    const controls = {};
    for (const [k, v] of Object.entries(values)) if (current.params.find((p) => p.symbol === k)?.default !== v) controls[k] = v;
    return { uri: current.uri, controls };
  };

  // ── preview with A/B (same approach as the Repair dialog) ──
  const previewSpan = () => {
    if (span) return { start: span.start, end: Math.min(span.end, span.start + 20) };
    const t = app.player.position;
    const s0 = clip && t >= clip.start && t < clip.start + clip.duration ? clip.offset + (t - clip.start) : (clip ? clip.offset : 0);
    return { start: s0, end: Math.min(asset.duration, s0 + 8) };
  };
  let prevSrc = null, prevBufs = null, abOriginal = false;
  const stopPrev = () => { try { prevSrc?.stop(); } catch {} prevSrc = null; prevBtn.textContent = 'Preview'; };
  const playPrev = () => {
    const ctx = app.player.ensureContext();
    const buf = abOriginal ? prevBufs.orig : prevBufs.proc;
    prevSrc = ctx.createBufferSource(); prevSrc.buffer = buf; prevSrc.connect(ctx.destination);
    prevSrc.onended = () => { if (prevSrc && prevSrc.buffer === buf) stopPrev(); };
    prevSrc.start(); prevBtn.textContent = 'Stop preview';
  };
  const prevBtn = el('button', { class: 'btn', type: 'button', onclick: async () => {
    if (prevSrc) return stopPrev();
    if (!current) return toast('Pick a plugin first.');
    app.player.pause();
    const sp = previewSpan();
    prevBtn.textContent = 'Processing…';
    try {
      const ctx = app.player.ensureContext();
      if (ctx.state === 'suspended') await ctx.resume();
      if (!prevBufs) {
        const [proc, orig] = await Promise.all([
          post(`/api/projects/${app.pid}/assets/${assetId}/lv2-preview`, { ...body(), ...sp }, true).then((ab) => ctx.decodeAudioData(ab)),
          app.player.loadAsset(assetId),
        ]);
        const sr = orig.sampleRate, s = Math.floor(sp.start * sr), n = Math.min(proc.length, orig.length - s);
        const o = ctx.createBuffer(orig.numberOfChannels, n, sr);
        for (let ch = 0; ch < orig.numberOfChannels; ch++) o.copyToChannel(orig.getChannelData(ch).subarray(s, s + n), ch);
        prevBufs = { proc, orig: o };
      }
      playPrev();
    } catch (e) { prevBtn.textContent = 'Preview'; app.fail(e); }
  } }, 'Preview');
  const abBtn = el('button', { class: 'chip', type: 'button', title: 'Switch between processed and original while previewing', onclick: () => {
    abOriginal = !abOriginal; abBtn.textContent = abOriginal ? 'Hearing: original' : 'Hearing: processed'; abBtn.classList.toggle('on', abOriginal);
    if (prevSrc && prevBufs) { try { prevSrc.stop(); } catch {} playPrev(); }
  } }, 'Hearing: processed');
  const onlyRange = span ? el('input', { type: 'checkbox', checked: true }) : null;

  const m = modal(`Plugins (LV2 / VST3) for “${asset.name}”`, [el('div', { class: 'lv2-grid' }, [
    el('div', { class: 'lv2-browser' }, [search, el('div', { class: 'row' }, [catSel, brandSel]), list]),
    el('div', { class: 'lv2-right' }, [editor,
      el('div', { class: 'row proc-preview' }, [prevBtn, abBtn, el('span', { class: 'muted small' }, span ? 'Plays the selected range' : 'Plays 8 s from the playhead')]),
      span ? el('label', { class: 'check' }, [onlyRange, ` Only the selected range (${fmtTime(span.tl[0], 2)} – ${fmtTime(span.tl[1], 2)}), with smooth edges`]) : el('p', { class: 'muted small' }, 'Tip: select a range on the timeline first to process only that part.'),
    ]),
  ])], {
    wide: true,
    actions: [{ label: 'Cancel' }, { label: 'Apply', primary: true, action: () => {
      if (!current) { toast('Pick a plugin first.'); return false; }
      stopPrev();
      const b = body();
      saveRecent(current.uri, b.controls);
      const range = onlyRange?.checked ? { start: span.start, end: span.end } : {};
      const name = shortName(current);
      toast(`Running ${name}…`, { id: 'lv2', ms: 0 });
      post(`/api/projects/${app.pid}/assets/${assetId}/lv2`, { ...b, ...range, replaceInClips: true })
        .then((r) => toast(`${name} applied${r.clipsUpdated ? ` to ${r.clipsUpdated} clip${r.clipsUpdated > 1 ? 's' : ''}` : ''}.`, { id: 'lv2', kind: 'ok' }))
        .catch((e) => { toast('', { id: 'lv2', ms: 1 }); app.fail(e); });
    } }],
  });
  m.root.querySelector('.modal').classList.add('lv2-modal');
  new MutationObserver((_, obs) => { if (!m.root.isConnected) { stopPrev(); obs.disconnect(); } }).observe(document.body, { childList: true });
  drawList(); drawEditor();
  search.focus();
  if (recent.length) { const p = cat.plugins.find((x) => x.uri === recent[0].uri); if (p) select(p); }
}
