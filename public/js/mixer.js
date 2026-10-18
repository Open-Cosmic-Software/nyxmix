// Console view: one channel strip per track plus master, with live meters.
import { el, clamp, faderToDb, dbToFader, theme } from './ui.js';

const dbFmt = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`;

export class MixerView {
  constructor(app) { this.app = app; this.label = 'Mixer'; this.raf = null; }

  render(box) {
    const app = this.app, p = app.project;
    const strip = (t) => {
      const meter = el('canvas', { class: 'mx-meter', width: 10, height: 180 });
      meter.dataset.track = t.id;
      return el('div', { class: 'mx-strip' + (app.selection.trackId === t.id ? ' selected' : ''), style: `--tc:${t.color}` }, [
        el('button', { class: 'mx-name', title: t.name, onclick: () => app.select({ trackId: t.id }) }, t.name),
        el('div', { class: 'mx-fx' }, t.effects.length ? t.effects.map((e) => el('span', { class: e.enabled ? '' : 'off' }, e.type)) : el('span', { class: 'muted' }, 'no effects')),
        this.knob(t.pan, (v) => app.liveTrack(t.id, { pan: v }), (v) => app.op('track.update', { trackId: t.id, pan: v })),
        el('div', { class: 'mx-body' }, [this.fader(t.gain, -60, 12, (v) => app.liveTrack(t.id, { gain: v }), (v) => app.op('track.update', { trackId: t.id, gain: v })), meter]),
        el('div', { class: 'mx-btns' }, [
          el('button', { class: 'tr-btn' + (t.mute ? ' on mute' : ''), onclick: () => app.op('track.update', { trackId: t.id, mute: !t.mute }) }, 'M'),
          el('button', { class: 'tr-btn' + (t.solo ? ' on solo' : ''), onclick: () => app.op('track.update', { trackId: t.id, solo: !t.solo }) }, 'S'),
        ]),
      ]);
    };
    const masterMeter = el('canvas', { class: 'mx-meter', width: 10, height: 180 });
    masterMeter.dataset.track = 'master';
    this.spec ||= el('canvas', { class: 'mx-spectrum', width: 640, height: 200, 'aria-label': 'Live spectrum of the master output' });
    box.replaceChildren(el('div', { class: 'mixer' }, [
      ...p.tracks.map(strip),
      el('div', { class: 'mx-strip master' }, [
        el('button', { class: 'mx-name', onclick: () => { app.inspectorTab = 'master'; app.renderInspector(); } }, 'Master'),
        el('div', { class: 'mx-fx' }, p.master.effects.length ? p.master.effects.map((e) => el('span', { class: e.enabled ? '' : 'off' }, e.type)) : el('span', { class: 'muted' }, 'no effects')),
        el('div', { class: 'mx-knob-spacer' }),
        el('div', { class: 'mx-body' }, [this.fader(p.master.gain, -60, 12, (v) => app.liveMaster(v), (v) => app.op('master.update', { gain: v })), masterMeter]),
        el('div', { class: 'mx-btns' }),
      ]),
      el('div', { class: 'mx-analyzer' }, [el('div', { class: 'muted small' }, 'Master spectrum'), this.spec]),
      el('div', { class: 'mx-phase' }, [el('div', { class: 'muted small' }, 'Phase'), (this.gonio ||= el('canvas', { class: 'mx-gonio', width: 200, height: 200, 'aria-label': 'Goniometer and phase correlation of the master output' }))]),
    ]));
    this.box = box;
    if (!this.raf) this.loop();
  }

  fader(value, min, max, onlive, oncommit) {
    const out = el('output', {}, dbFmt(value));
    // Fader law: 0 dB sits at three quarters of the travel, like a real console.
    const input = el('input', { type: 'range', class: 'mx-fader', min: 0, max: 1, step: 'any', value: dbToFader(value), 'aria-label': 'Volume', 'aria-valuetext': `${dbFmt(value)} dB`, orient: 'vertical' });
    const val = () => Math.round(faderToDb(+input.value) * 10) / 10;
    input.addEventListener('pointerdown', () => (this.app.interacting = true));
    input.addEventListener('input', () => { out.textContent = dbFmt(val()); input.setAttribute('aria-valuetext', `${dbFmt(val())} dB`); onlive(val()); });
    input.addEventListener('change', () => { this.app.endInteraction(); oncommit(val()); });
    input.addEventListener('dblclick', () => { input.value = dbToFader(0); out.textContent = dbFmt(0); onlive(0); oncommit(0); });
    const scale = el('div', { class: 'mx-scale', 'aria-hidden': 'true' }, [12, 6, 0, -6, -12, -24, -40, -60].map((d) => el('span', { style: `top:${(1 - dbToFader(d)) * 100}%` }, d === -60 ? '−∞' : d > 0 ? `+${d}` : String(d).replace('-', '−'))));
    return el('div', { class: 'mx-fader-wrap' }, [el('div', { class: 'mx-fader-col' }, [scale, input]), out]);
  }

  knob(value, onlive, oncommit) {
    const label = (v) => (Math.abs(v) < 0.005 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`);
    const out = el('output', {}, label(value));
    const input = el('input', { type: 'range', min: -1, max: 1, step: 0.01, value, 'aria-label': 'Pan', class: 'mx-pan' });
    input.addEventListener('pointerdown', () => (this.app.interacting = true));
    input.addEventListener('input', () => { out.textContent = label(+input.value); onlive(+input.value); });
    input.addEventListener('change', () => { this.app.endInteraction(); oncommit(+input.value); });
    input.addEventListener('dblclick', () => { input.value = 0; out.textContent = 'C'; onlive(0); oncommit(0); });
    return el('div', { class: 'mx-pan-wrap' }, [input, out]);
  }

  // Live spectrum (log frequency, 1/6-octave smoothing, peak hold).
  drawSpectrum(player) {
    const c = this.spec; if (!c) return;
    const g = c.getContext('2d'), W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    g.strokeStyle = theme('cv-plot-grid'); g.fillStyle = theme('cv-plot-label'); g.font = '12px Instrument Sans';
    const X = (f) => (Math.log(f / 20) / Math.log(1000)) * W, Y = (db) => H - ((db + 96) / 96) * H;
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { g.beginPath(); g.moveTo(X(f), 0); g.lineTo(X(f), H); g.stroke(); g.fillText(f >= 1000 ? `${f / 1000}k` : f, X(f) + 3, H - 4); }
    if (!player.ctx || !player.playing) { this.hold = null; return; }
    if (!this.an || this.an.context !== player.ctx) { this.an = player.ctx.createAnalyser(); this.an.fftSize = 8192; this.an.smoothingTimeConstant = 0.6; player.fold.connect(this.an); this.bins = new Float32Array(this.an.frequencyBinCount); }
    this.an.getFloatFrequencyData(this.bins);
    const sr = player.ctx.sampleRate, N = this.bins.length, pts = [];
    for (let i = 0; i <= 160; i++) {
      const f = 20 * Math.pow(1000, i / 160), lo = f / 1.06, hi = f * 1.06;
      let sum = 0, n = 0;
      for (let k = Math.max(1, Math.floor((lo / (sr / 2)) * N)); k <= Math.min(N - 1, Math.ceil((hi / (sr / 2)) * N)); k++) { sum += Math.pow(10, this.bins[k] / 10); n++; }
      pts.push([X(f), n ? 10 * Math.log10(sum / n) + 6 : -120]);
    }
    this.hold = pts.map(([x, v], i) => [x, Math.max(v, (this.hold?.[i]?.[1] ?? -120) - 0.6)]);
    g.beginPath(); pts.forEach(([x, v], i) => (i ? g.lineTo(x, Y(v)) : g.moveTo(x, Y(v)))); g.lineTo(W, H); g.lineTo(0, H); g.closePath();
    g.fillStyle = theme('amber', 0.25); g.fill();
    g.beginPath(); this.hold.forEach(([x, v], i) => (i ? g.lineTo(x, Y(v)) : g.moveTo(x, Y(v)))); g.strokeStyle = theme('amber'); g.lineWidth = 2; g.stroke();
  }

  // Goniometer (mid up, sides across) and correlation: +1 mono, 0 wide, negative = phase trouble.
  drawPhase(player) {
    const c = this.gonio; if (!c) return;
    const g = c.getContext('2d'), W = c.width, H = c.height - 22;
    g.fillStyle = theme('cv-gonio-fade'); g.fillRect(0, 0, W, c.height);
    g.strokeStyle = theme('cv-gonio-axis'); g.beginPath(); g.moveTo(W / 2, 0); g.lineTo(W / 2, H); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
    if (!player.playing || !player.meterL) { this.corr = null; return; }
    const n = 1024, L = (this.gL ||= new Float32Array(n)), R = (this.gR ||= new Float32Array(n));
    player.meterL.getFloatTimeDomainData(L); player.meterR.getFloatTimeDomainData(R);
    let lr = 0, ll = 0, rr = 0, peak = 1e-6;
    for (let i = 0; i < n; i++) { lr += L[i] * R[i]; ll += L[i] * L[i]; rr += R[i] * R[i]; peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
    const scale = (Math.min(W, H) / 2 - 6) / Math.max(peak, 0.05);
    g.fillStyle = theme('cv-gonio-dot');
    for (let i = 0; i < n; i += 2) { const m = (L[i] + R[i]) * 0.7071, sd = (L[i] - R[i]) * 0.7071; g.fillRect(W / 2 + sd * scale, H / 2 - m * scale, 1.5, 1.5); }
    const corr = ll > 1e-9 && rr > 1e-9 ? lr / Math.sqrt(ll * rr) : 1;
    this.corr = this.corr == null ? corr : this.corr * 0.85 + corr * 0.15;
    g.fillStyle = theme('cv-corr-bg'); g.fillRect(0, H + 6, W, 10);
    const x = ((this.corr + 1) / 2) * W;
    g.fillStyle = this.corr < 0 ? theme('red') : this.corr < 0.3 ? theme('amber') : theme('ok');
    g.fillRect(Math.min(W / 2, x), H + 6, Math.abs(x - W / 2), 10);
    g.fillStyle = theme('cv-label'); g.font = '11px Instrument Sans'; g.fillText('−1', 2, H + 4); g.fillText('+1', W - 16, H + 4);
  }

  loop() {
    this.raf = requestAnimationFrame(() => { this.raf = null; if (this.box?.isConnected && !this.box.hidden && this.app.dockTab === 'mixer') this.loop(); });
    if (!this.box) return;
    const player = this.app.player;
    const master = player.masterLevels();
    this.drawSpectrum(player);
    this.drawPhase(player);
    for (const c of this.box.querySelectorAll('.mx-meter')) {
      const id = c.dataset.track;
      const lv = id === 'master' ? (master ? { peak: Math.max(master[0].peak, master[1].peak), rms: Math.max(master[0].rms, master[1].rms) } : null) : player.trackLevel(id);
      const g = c.getContext('2d'), H = c.height;
      g.fillStyle = theme('well'); g.fillRect(0, 0, c.width, H);
      if (!lv) continue;
      const y = (v) => H - clamp((20 * Math.log10(Math.max(v, 1e-6)) + 60) / 60, 0, 1) * H;
      const grad = g.createLinearGradient(0, H, 0, 0);
      grad.addColorStop(0, theme('meter-lo')); grad.addColorStop(0.75, theme('meter-mid')); grad.addColorStop(0.9, theme('meter-hi')); grad.addColorStop(1, theme('meter-clip'));
      g.fillStyle = grad;
      g.globalAlpha = 0.45; g.fillRect(0, y(lv.peak), c.width, H - y(lv.peak));
      g.globalAlpha = 1; g.fillRect(2, y(lv.rms), c.width - 4, H - y(lv.rms));
    }
  }
}
