export function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k in n && typeof v !== 'string') n[k] = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  add(children);
  return n;
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function fmtTime(t, decimals = 3) {
  const neg = t < 0; t = Math.abs(t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const ss = decimals ? s.toFixed(decimals).padStart(decimals + 3, '0') : String(Math.floor(s)).padStart(2, '0');
  return (neg ? '−' : '') + (h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`);
}

export function parseTime(str) {
  const parts = String(str).trim().split(':').map(Number);
  if (parts.some((x) => !Number.isFinite(x))) return null;
  return parts.reduce((acc, x) => acc * 60 + x, 0);
}

export function relTime(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 10) return 'just now';
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

let menuEl = null;
export function closeMenu() { menuEl?.remove(); menuEl = null; }
export function menu(x, y, items) {
  closeMenu();
  menuEl = el('div', { class: 'menu', role: 'menu' }, items.filter(Boolean).map((it) => it === '-' ? el('hr') : el('button', {
    class: 'menu-item' + (it.danger ? ' danger' : ''), disabled: it.disabled, role: 'menuitem',
    onclick: () => { closeMenu(); it.action(); },
  }, [el('span', {}, it.label), it.key ? el('kbd', {}, it.key) : null])));
  document.body.append(menuEl);
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  menuEl.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  menuEl.querySelector('button:not([disabled])')?.focus();
}
addEventListener('mousedown', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

export function modal(title, body, { actions = [], wide } = {}) {
  const close = () => { wrap.remove(); removeEventListener('keydown', onKey); opener?.focus?.(); };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    // Keep Tab inside the dialog.
    if (e.key === 'Tab') {
      const f = [...wrap.querySelectorAll('button,input,select,textarea,a[href],[tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  const opener = document.activeElement;
  const wrap = el('div', { class: 'modal-wrap', onmousedown: (e) => { if (e.target === wrap) close(); } }, [
    el('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
      el('div', { class: 'modal-head' }, [el('h2', {}, title), el('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '×')]),
      el('div', { class: 'modal-body' }, body),
      actions.length ? el('footer', {}, actions.map((a) => el('button', { class: a.primary ? 'btn primary' : 'btn', onclick: async (e) => { if ((await a.action?.(e)) !== false) close(); } }, a.label))) : null,
    ]),
  ]);
  document.body.append(wrap);
  addEventListener('keydown', onKey);
  wrap.querySelector('input,select,textarea,button.primary')?.focus();
  return { close, root: wrap };
}

const toasts = el('div', { class: 'toasts', 'aria-live': 'polite' });
document.body.append(toasts);
export function toast(msg, { kind = 'info', ms = 3500, id } = {}) {
  let t = id && toasts.querySelector(`[data-id="${id}"]`);
  if (!t) { t = el('div', { class: 'toast' }); if (id) t.dataset.id = id; toasts.append(t); }
  t.className = `toast ${kind}`;
  t.textContent = msg;
  clearTimeout(t._timer);
  if (ms) t._timer = setTimeout(() => t.remove(), ms);
  return t;
}

// Console-style fader law: most of the travel sits around 0 dB, quiet levels are
// compressed at the bottom (a linear dB scale makes small moves jump from silent to loud).
const FADER = [[0, -60], [0.1, -40], [0.25, -24], [0.45, -12], [0.6, -6], [0.75, 0], [0.88, 6], [1, 12]];
export function faderToDb(p) {
  p = clamp(p, 0, 1);
  for (let i = 1; i < FADER.length; i++) if (p <= FADER[i][0]) { const [p0, d0] = FADER[i - 1], [p1, d1] = FADER[i]; return d0 + ((p - p0) / (p1 - p0)) * (d1 - d0); }
  return 12;
}
export function dbToFader(db) {
  db = clamp(db, -60, 12);
  for (let i = 1; i < FADER.length; i++) if (db <= FADER[i][1]) { const [p0, d0] = FADER[i - 1], [p1, d1] = FADER[i]; return p0 + ((db - d0) / (d1 - d0)) * (p1 - p0); }
  return 1;
}

// ── theme ────────────────────────────────────────────────────────────────
// Colours live as CSS custom properties on :root (app.css). Canvas code reads them through
// theme(); the cache is dropped whenever the theme (or the OS scheme, in "auto") changes,
// and a 'klang:theme' event tells views to repaint.
const THEME_KEY = 'klang.theme';
let themeVals = new Map();
let themeStyle = null;
export function theme(name, alpha) {
  let v = themeVals.get(name);
  if (v === undefined) {
    themeStyle ||= getComputedStyle(document.documentElement);
    v = themeStyle.getPropertyValue('--' + name).trim();
    themeVals.set(name, v);
  }
  return alpha === undefined ? v : withAlpha(v, alpha);
}
// '#rrggbb' + alpha → 'rgba(r,g,b,a)' (same string the old hard-coded canvas colours used).
export function withAlpha(hex, a) {
  if (hex[0] !== '#') return hex;
  const n = parseInt(hex.length === 4 ? hex.slice(1).replace(/./g, '$&$&') : hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
// Track colours are mid-tones picked for dark lanes; on light lanes the waveform is shaded
// toward black (--cv-wave-shade) so it keeps its hue but gains contrast.
export function trackInk(hex, a = 1) {
  const k = +theme('cv-wave-shade') || 0;
  if (!k || hex[0] !== '#') return withAlpha(hex, a);
  const n = parseInt(hex.slice(1, 7), 16), f = 1 - k;
  return `rgba(${Math.round(((n >> 16) & 255) * f)},${Math.round(((n >> 8) & 255) * f)},${Math.round((n & 255) * f)},${a})`;
}
let memPref = null; // fallback when localStorage throws
export function themePref() {
  let v = memPref;
  try { v = localStorage.getItem(THEME_KEY) ?? memPref; } catch { /* storage blocked */ }
  return v === 'light' || v === 'dark' ? v : 'auto';
}
export function isLightTheme() {
  const p = themePref();
  return p === 'light' || (p === 'auto' && matchMedia('(prefers-color-scheme: light)').matches);
}
function applyTheme() {
  const p = themePref();
  if (p === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = p;
  themeVals = new Map(); themeStyle = null;
  dispatchEvent(new CustomEvent('klang:theme', { detail: { pref: p, light: isLightTheme() } }));
}
export function setThemePref(p) {
  try { if (p === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, p); } catch { /* storage blocked */ }
  memPref = p;
  applyTheme();
}
// Re-run fn on every theme change for as long as node stays in the document.
function onTheme(node, fn) {
  const h = () => { if (!node.isConnected) { if (node._themeSeen) removeEventListener('klang:theme', h); return; } node._themeSeen = true; fn(); };
  addEventListener('klang:theme', h);
}
applyTheme();
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (themePref() === 'auto') applyTheme(); });

const THEME_ICONS = {
  auto: '<circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 4.5a7.5 7.5 0 0 1 0 15z" fill="currentColor"/>',
  light: '<circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.5 1.5M17.2 17.2l1.5 1.5M5.3 18.7l1.5-1.5M17.2 6.8l1.5-1.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  dark: '<path d="M19.5 14.6A8 8 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
};
const THEME_LABELS = { auto: 'Auto (system)', light: 'Light', dark: 'Dark' };
function themeIcon(p) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = THEME_ICONS[p];
  return s;
}
// Compact icon button with an Auto / Light / Dark menu (top bar).
export function themeButton(cls = 'tbtn') {
  const b = el('button', { class: cls + ' theme-btn', 'aria-haspopup': 'menu' });
  const sync = () => { const p = themePref(); b.replaceChildren(themeIcon(p)); b.title = `Appearance: ${THEME_LABELS[p]}`; b.setAttribute('aria-label', `Appearance: ${THEME_LABELS[p]}`); };
  b.addEventListener('click', () => {
    const r = b.getBoundingClientRect(), cur = themePref();
    menu(r.left, r.bottom + 4, ['auto', 'light', 'dark'].map((p) => ({ label: (p === cur ? '✓ ' : ' ') + THEME_LABELS[p], action: () => setThemePref(p) })));
  });
  onTheme(b, sync);
  sync();
  return b;
}
// Segmented Auto / Light / Dark control (home page).
export function themeSegmented() {
  const wrap = el('div', { class: 'theme-seg', role: 'radiogroup', 'aria-label': 'Appearance' });
  const sync = () => { const cur = themePref(); for (const b of wrap.children) { const on = b.dataset.pref === cur; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); } };
  for (const p of ['auto', 'light', 'dark']) wrap.append(el('button', { class: 'theme-opt', role: 'radio', 'data-pref': p, onclick: () => setThemePref(p) }, [themeIcon(p), el('span', {}, p === 'auto' ? 'Auto' : THEME_LABELS[p])]));
  onTheme(wrap, sync);
  sync();
  return wrap;
}
