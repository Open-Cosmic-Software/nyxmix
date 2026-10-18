// Studio effects matching Audition's Channel Mixer, Graphic Phase Shifter, 30-band
// Graphic EQ and Convolution Reverb (with your own impulse response from the bin).
// Native nodes only, so preview and export are identical.

const THIRD_OCTAVES = [25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];
const bandKey = (f) => `g${f >= 1000 ? `${+(f / 1000).toFixed(2)}k`.replace('.', '_') : String(f).replace('.', '_')}`;

export const STUDIO_EFFECTS = {
  channelmixer: {
    label: 'Channel mixer',
    automatable: ['lFromL', 'lFromR', 'rFromL', 'rFromR'],
    description: 'Rebuild left and right from the input channels (Audition: Channel Mixer). Output L = lFromL·L + lFromR·R, output R = rFromL·L + rFromR·R; values are linear gains (−1 … 1, negative inverts).',
    params: {
      lFromL: { type: 'number', minimum: -1, maximum: 1, default: 1 },
      lFromR: { type: 'number', minimum: -1, maximum: 1, default: 0 },
      rFromL: { type: 'number', minimum: -1, maximum: 1, default: 0 },
      rFromR: { type: 'number', minimum: -1, maximum: 1, default: 1 },
    },
  },
  phaseshift: {
    label: 'Phase shifter',
    description: 'Frequency-dependent phase rotation with no change in level (Audition: Graphic Phase Shifter): a chain of all-pass stages centred on frequency, on one or both channels. Useful to fix phase between mics or to widen.',
    params: {
      frequency: { type: 'number', minimum: 20, maximum: 20000, default: 500, unit: 'Hz' },
      stages: { type: 'integer', minimum: 1, maximum: 8, default: 2, description: 'All-pass stages (each adds up to 360° of rotation around the frequency)' },
      Q: { type: 'number', minimum: 0.1, maximum: 10, default: 0.7 },
      channel: { type: 'integer', minimum: 0, maximum: 2, default: 2, description: 'Integer: 0 both, 1 left only, 2 right only' },
    },
  },
  graphiceq30: {
    label: 'Graphic EQ (30 band)',
    get automatable() { return THIRD_OCTAVES.map(bandKey); },
    description: '1/3-octave graphic equalizer, 25 Hz – 20 kHz, ±12 dB per band (Audition: Graphic Equalizer, 30 bands).',
    params: Object.fromEntries([
      ...THIRD_OCTAVES.map((f) => [bandKey(f), { type: 'number', minimum: -12, maximum: 12, default: 0, unit: 'dB', description: `${f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`} band` }]),
      ['output', { type: 'number', minimum: -24, maximum: 12, default: 0, unit: 'dB' }],
    ]),
  },
  convolution: {
    label: 'Convolution reverb',
    description: 'Reverb from a real impulse response: set ir to the id of a file in the bin (a recorded room, hall, plate, speaker cabinet…). Dry stays at unity; mix sets the reverb level; predelay delays the reverb.',
    params: {
      ir: { type: 'string', description: 'Asset id (ast_…) of the impulse response in the bin' },
      mix: { type: 'number', minimum: 0, maximum: 1, default: 0.3 },
      predelay: { type: 'number', minimum: 0, maximum: 200, default: 0, unit: 'ms' },
      gain: { type: 'number', minimum: -24, maximum: 12, default: 0, unit: 'dB', description: 'Level of the reverb after normalisation' },
    },
    automatable: ['mix'],
  },
};

const dbToGain = (db) => Math.pow(10, db / 20);

/** Returns null for other types. timing.irBuffers: Map assetId → AudioBuffer. */
export function buildStudioEffect(ctx, fx, P, timing) {
  if (!STUDIO_EFFECTS[fx.type]) return null;
  const nodes = [], targets = {};
  const mk = (n) => (nodes.push(n), n);
  const input = mk(ctx.createGain()), output = mk(ctx.createGain());
  let update = () => {};

  switch (fx.type) {
    case 'channelmixer': {
      input.channelCount = 2; input.channelCountMode = 'explicit'; input.channelInterpretation = 'speakers';
      const split = mk(ctx.createChannelSplitter(2)), merge = mk(ctx.createChannelMerger(2));
      const g = {};
      for (const [k, from, to] of [['lFromL', 0, 0], ['lFromR', 1, 0], ['rFromL', 0, 1], ['rFromR', 1, 1]]) { g[k] = mk(ctx.createGain()); split.connect(g[k], from); g[k].connect(merge, 0, to); }
      input.connect(split); merge.connect(output);
      update = (params) => { const p = P(params); for (const k of Object.keys(g)) g[k].gain.value = p[k]; };
      for (const k of Object.keys(g)) targets[k] = { param: g[k].gain, map: (v) => v };
      break;
    }
    case 'phaseshift': {
      input.channelCount = 2; input.channelCountMode = 'explicit'; input.channelInterpretation = 'speakers';
      const split = mk(ctx.createChannelSplitter(2)), merge = mk(ctx.createChannelMerger(2));
      const p0 = P(fx.params);
      const chains = [0, 1].map((ch) => {
        const apply = p0.channel === 0 || p0.channel === ch + 1;
        const stages = apply ? Array.from({ length: p0.stages }, () => { const b = mk(ctx.createBiquadFilter()); b.type = 'allpass'; return b; }) : [];
        let cur = mk(ctx.createGain());
        split.connect(cur, ch);
        for (const b of stages) { cur.connect(b); cur = b; }
        cur.connect(merge, 0, ch);
        return stages;
      });
      input.connect(split); merge.connect(output);
      update = (params) => { const p = P(params); for (const st of chains) for (const b of st) { b.frequency.value = p.frequency; b.Q.value = p.Q; } };
      break;
    }
    case 'graphiceq30': {
      const bands = THIRD_OCTAVES.map((f) => { const b = mk(ctx.createBiquadFilter()); b.type = 'peaking'; b.frequency.value = f; b.Q.value = 4.32; return [bandKey(f), b]; });
      const out = mk(ctx.createGain());
      let cur = input;
      for (const [, b] of bands) { cur.connect(b); cur = b; }
      cur.connect(out); out.connect(output);
      update = (params) => { const p = P(params); for (const [k, b] of bands) b.gain.value = p[k]; out.gain.value = dbToGain(p.output); };
      for (const [k, b] of bands) targets[k] = { param: b.gain, map: (v) => v };
      break;
    }
    case 'convolution': {
      const conv = mk(ctx.createConvolver());
      conv.normalize = true;
      const pre = mk(ctx.createDelay(0.25)), wet = mk(ctx.createGain()), lvl = mk(ctx.createGain());
      input.connect(output);
      input.connect(pre); pre.connect(conv); conv.connect(lvl); lvl.connect(wet); wet.connect(output);
      let irId = null;
      update = (params) => {
        const p = P(params);
        if (p.ir !== irId) { irId = p.ir; const b = timing?.irBuffers?.get(p.ir); conv.buffer = b || null; }
        pre.delayTime.value = p.predelay / 1000; wet.gain.value = p.mix; lvl.gain.value = dbToGain(p.gain);
      };
      targets.mix = { param: wet.gain, map: (v) => v };
      break;
    }
  }
  update(fx.params);
  return { input, output, nodes, update, targets };
}

// Impulse-response assets referenced by a project's convolution effects.
export function irAssetIds(project) {
  const ids = new Set();
  for (const list of [project.master?.effects || [], ...project.tracks.map((t) => t.effects || [])]) for (const e of list) if (e.type === 'convolution' && e.params?.ir) ids.add(e.params.ir);
  return ids;
}
