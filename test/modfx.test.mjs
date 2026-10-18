// Modulation effects: LFO phase is locked to the timeline, so starting playback
// mid-way gives the same audio as rendering from the top.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfflineAudioContext } from 'node-web-audio-api';
import { buildModEffect, MOD_EFFECTS } from '../public/js/engine/modfx.js';

const SR = 48000;
const P = (type) => (params) => ({ ...Object.fromEntries(Object.entries(MOD_EFFECTS[type].params).map(([k, v]) => [k, v.default])), ...(params || {}) });

async function render(type, from, seconds) {
  const ctx = new OfflineAudioContext(2, SR * seconds, SR);
  const src = ctx.createOscillator(); src.frequency.value = 220;
  // Same source signal relative to the timeline: start the 220 Hz tone with timeline phase.
  const ph = 2 * Math.PI * 220 * from;
  src.setPeriodicWave(ctx.createPeriodicWave(new Float32Array([0, Math.sin(ph)]), new Float32Array([0, Math.cos(ph)]), { disableNormalization: true }));
  const fx = buildModEffect(ctx, { id: 'x', type, params: {} }, P(type), { from, when: 0 });
  src.connect(fx.input); fx.output.connect(ctx.destination); src.start(0);
  const b = await ctx.startRendering();
  return [b.getChannelData(0), b.getChannelData(1)];
}

for (const type of ['chorus', 'phaser', 'tremolo', 'autopan']) {
  test(`${type}: render from 2 s equals the tail of a render from 0 s`, async () => {
    const full = await render(type, 0, 4), tail = await render(type, 2, 2);
    // Skip the first 50 ms (delay lines fill up) and compare.
    let maxDiff = 0;
    for (let ch = 0; ch < 2; ch++) for (let i = SR * 0.05; i < SR * 2; i++) maxDiff = Math.max(maxDiff, Math.abs(full[ch][i + 2 * SR] - tail[ch][i]));
    assert.ok(maxDiff < 2e-3, `max difference ${maxDiff}`);
  });
}

test('stereo width 0 makes mono, 1 is transparent', async () => {
  const run = async (w) => {
    const ctx = new OfflineAudioContext(2, SR / 10, SR);
    const l = ctx.createOscillator(), r = ctx.createOscillator(); r.frequency.value = 660;
    const m = ctx.createChannelMerger(2); l.connect(m, 0, 0); r.connect(m, 0, 1);
    const fx = buildModEffect(ctx, { id: 'w', type: 'width', params: { width: w } }, P('width'), { from: 0, when: 0 });
    m.connect(fx.input); fx.output.connect(ctx.destination); l.start(); r.start();
    const b = await ctx.startRendering();
    return [b.getChannelData(0), b.getChannelData(1)];
  };
  const [L0, R0] = await run(0);
  let d = 0; for (let i = 0; i < L0.length; i++) d = Math.max(d, Math.abs(L0[i] - R0[i]));
  assert.ok(d < 1e-6, `width 0 should be mono, diff ${d}`);
  const [L1] = await run(1);
  const ref = new OfflineAudioContext(1, SR / 10, SR); const o = ref.createOscillator(); o.connect(ref.destination); o.start();
  const rb = (await ref.startRendering()).getChannelData(0);
  let e = 0; for (let i = 0; i < rb.length; i++) e = Math.max(e, Math.abs(L1[i] - rb[i]));
  assert.ok(e < 1e-5, `width 1 should be transparent, diff ${e}`);
});
