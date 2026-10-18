// Modulation and stereo effects built from native nodes. LFO phase is locked to the
// timeline (not to when playback started), so a chorus sounds the same in a preview
// started at 1:23 as in the full export.

export const MOD_EFFECTS = {
  chorus: {
    label: 'Chorus',
    description: 'Thickens a sound with two slowly moving delayed copies (left and right in opposite phase).',
    params: {
      rate: { type: 'number', minimum: 0.05, maximum: 5, default: 0.8, unit: 'Hz' },
      depth: { type: 'number', minimum: 0, maximum: 10, default: 3, unit: 'ms' },
      delay: { type: 'number', minimum: 5, maximum: 40, default: 18, unit: 'ms' },
      mix: { type: 'number', minimum: 0, maximum: 1, default: 0.4 },
    },
  },
  flanger: {
    label: 'Flanger',
    description: 'Jet-like sweep from a very short modulated delay with feedback.',
    params: {
      rate: { type: 'number', minimum: 0.02, maximum: 5, default: 0.25, unit: 'Hz' },
      depth: { type: 'number', minimum: 0, maximum: 5, default: 2, unit: 'ms' },
      delay: { type: 'number', minimum: 0.5, maximum: 10, default: 2.5, unit: 'ms' },
      feedback: { type: 'number', minimum: 0, maximum: 0.9, default: 0.5 },
      mix: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
    },
  },
  phaser: {
    label: 'Phaser',
    description: 'Sweeping notches from four all-pass stages.',
    params: {
      rate: { type: 'number', minimum: 0.02, maximum: 5, default: 0.4, unit: 'Hz' },
      center: { type: 'number', minimum: 200, maximum: 4000, default: 900, unit: 'Hz' },
      depth: { type: 'number', minimum: 0, maximum: 1, default: 0.7, description: 'Sweep width (fraction of the centre frequency)' },
      feedback: { type: 'number', minimum: 0, maximum: 0.9, default: 0.4 },
      mix: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
    },
  },
  tremolo: {
    label: 'Tremolo',
    description: 'Rhythmic volume modulation.',
    params: {
      rate: { type: 'number', minimum: 0.1, maximum: 20, default: 5, unit: 'Hz' },
      depth: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
    },
  },
  autopan: {
    label: 'Auto-pan',
    description: 'Moves the sound between left and right.',
    params: {
      rate: { type: 'number', minimum: 0.02, maximum: 10, default: 0.5, unit: 'Hz' },
      depth: { type: 'number', minimum: 0, maximum: 1, default: 0.8 },
    },
  },
  width: {
    label: 'Stereo width',
    description: 'Mid/side width: 0 = mono, 1 = unchanged, 2 = extra wide.',
    params: {
      width: { type: 'number', minimum: 0, maximum: 2, default: 1.3 },
    },
  },
};

// Sine LFO whose phase at timeline time t is 2π·rate·t + offset.
function lfo(ctx, rate, timing, offset = 0) {
  const osc = ctx.createOscillator();
  const phase = 2 * Math.PI * rate * (timing?.from || 0) + offset;
  const wave = ctx.createPeriodicWave(new Float32Array([0, Math.sin(phase)]), new Float32Array([0, Math.cos(phase)]), { disableNormalization: true });
  osc.setPeriodicWave(wave);
  osc.frequency.value = rate;
  osc.start(timing?.when || 0);
  return osc;
}

/**
 * Build a modulation effect. Returns { input, output, nodes, update, sources } or null if
 * the type is not one of MOD_EFFECTS. `P(params)` merges defaults.
 */
export function buildModEffect(ctx, fx, P, timing) {
  if (!MOD_EFFECTS[fx.type]) return null;
  const nodes = [], sources = [];
  const mk = (n) => (nodes.push(n), n);
  const input = mk(ctx.createGain());
  const output = mk(ctx.createGain());
  input.channelCount = 2; input.channelCountMode = 'explicit';
  let update = () => {};
  const p0 = P(fx.params);

  switch (fx.type) {
    case 'chorus':
    case 'flanger': {
      const split = mk(ctx.createChannelSplitter(2)), merge = mk(ctx.createChannelMerger(2));
      const wet = mk(ctx.createGain());
      const lines = [0, 1].map((ch) => {
        const d = mk(ctx.createDelay(0.1));
        const depth = mk(ctx.createGain());
        const fb = mk(ctx.createGain());
        const osc = lfo(ctx, p0.rate, timing, ch === 0 ? 0 : Math.PI); sources.push(osc);
        osc.connect(depth); depth.connect(d.delayTime);
        split.connect(d, ch); d.connect(merge, 0, ch);
        d.connect(fb); fb.connect(d);
        return { d, depth, fb, osc };
      });
      input.connect(split); merge.connect(wet); wet.connect(output);
      input.connect(output);
      update = (params) => {
        const p = P(params);
        for (const l of lines) {
          l.d.delayTime.value = p.delay / 1000;
          l.depth.gain.value = p.depth / 1000;
          l.fb.gain.value = fx.type === 'flanger' ? p.feedback : 0;
          l.osc.frequency.value = p.rate;
        }
        wet.gain.value = p.mix;
        input.gain.value = 1;
        // Keep overall level steady as the wet signal is added.
        output.gain.value = 1 / (1 + p.mix * 0.5);
      };
      break;
    }
    case 'phaser': {
      const stages = [0, 1, 2, 3].map(() => { const b = mk(ctx.createBiquadFilter()); b.type = 'allpass'; b.Q.value = 0.7; return b; });
      const sweep = mk(ctx.createGain());
      const osc = lfo(ctx, p0.rate, timing); sources.push(osc);
      osc.connect(sweep);
      for (const b of stages) sweep.connect(b.frequency);
      const fb = mk(ctx.createGain()), wet = mk(ctx.createGain());
      input.connect(stages[0]);
      for (let i = 1; i < stages.length; i++) stages[i - 1].connect(stages[i]);
      stages[3].connect(fb); fb.connect(stages[0]);
      stages[3].connect(wet); wet.connect(output);
      input.connect(output);
      update = (params) => {
        const p = P(params);
        for (const b of stages) b.frequency.value = p.center;
        sweep.gain.value = p.center * p.depth * 0.9;
        osc.frequency.value = p.rate;
        fb.gain.value = p.feedback; wet.gain.value = p.mix;
        output.gain.value = 1 / (1 + p.mix * 0.5);
      };
      break;
    }
    case 'tremolo': {
      const amp = mk(ctx.createGain());
      const depth = mk(ctx.createGain());
      const osc = lfo(ctx, p0.rate, timing); sources.push(osc);
      osc.connect(depth); depth.connect(amp.gain);
      input.connect(amp); amp.connect(output);
      update = (params) => {
        const p = P(params);
        amp.gain.value = 1 - p.depth / 2;   // centre of the swing
        depth.gain.value = p.depth / 2;      // ± swing
        osc.frequency.value = p.rate;
      };
      break;
    }
    case 'autopan': {
      const pan = mk(ctx.createStereoPanner());
      const depth = mk(ctx.createGain());
      const osc = lfo(ctx, p0.rate, timing); sources.push(osc);
      osc.connect(depth); depth.connect(pan.pan);
      pan.pan.value = 0;
      input.connect(pan); pan.connect(output);
      update = (params) => { const p = P(params); depth.gain.value = p.depth; osc.frequency.value = p.rate; };
      break;
    }
    case 'width': {
      // L' = M + w·S, R' = M − w·S with M = (L+R)/2, S = (L−R)/2.
      const split = mk(ctx.createChannelSplitter(2)), merge = mk(ctx.createChannelMerger(2));
      const lL = mk(ctx.createGain()), rL = mk(ctx.createGain()), lR = mk(ctx.createGain()), rR = mk(ctx.createGain());
      input.connect(split);
      split.connect(lL, 0); split.connect(rL, 1); lL.connect(merge, 0, 0); rL.connect(merge, 0, 0);
      split.connect(lR, 0); split.connect(rR, 1); lR.connect(merge, 0, 1); rR.connect(merge, 0, 1);
      merge.connect(output);
      update = (params) => {
        const w = P(params).width;
        lL.gain.value = (1 + w) / 2; rL.gain.value = (1 - w) / 2;
        lR.gain.value = (1 - w) / 2; rR.gain.value = (1 + w) / 2;
      };
      break;
    }
  }
  update(fx.params);
  return { input, output, nodes, update, sources };
}
