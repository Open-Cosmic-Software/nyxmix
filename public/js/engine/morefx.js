// More real-time effects (filters, dynamics, distortion, delays, pitch), closing the gap to
// a DAW/Audition effect rack. Same contract as modfx.js: definitions in MORE_EFFECTS, graphs
// from buildMoreEffect(). Everything here runs in the browser and in the server's offline
// renderer; LFOs, grain windows and sample-and-hold phases are locked to the timeline.

const num = (minimum, maximum, def, unit, description) => ({ type: 'number', minimum, maximum, default: def, ...(unit ? { unit } : {}), ...(description ? { description } : {}) });

export const FILTER_MODES = ['lowpass', 'highpass', 'bandpass', 'notch', 'lowshelf', 'highshelf', 'peaking'];
export const GRAPHIC_EQ_BANDS = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const bandKey = (f) => (f >= 1000 ? `b${f / 1000}k` : `b${f}`);

export const MORE_EFFECTS = {
  filter: {
    label: 'Filter',
    description: 'One multimode biquad filter: low-pass, high-pass, band-pass, notch, shelf or bell (choose with `mode`).',
    params: {
      mode: num(0, 6, 0, null, 'Integer: 0 lowpass, 1 highpass, 2 bandpass, 3 notch, 4 lowshelf, 5 highshelf, 6 peaking (bell)'),
      frequency: num(20, 20000, 1000, 'Hz', 'Cutoff / centre / shelf frequency'),
      Q: num(0.1, 18, 0.7071, null, 'Resonance or bandwidth (0.707 = flat Butterworth); ignored by shelves'),
      gain: num(-24, 24, 0, 'dB', 'Boost/cut; used only by lowshelf, highshelf and peaking'),
    },
  },
  graphiceq: {
    label: 'Graphic EQ (10 band)',
    description: '10-band octave graphic EQ, 31 Hz to 16 kHz, ±12 dB per band (bands at 0 dB are transparent).',
    params: {
      ...Object.fromEntries(GRAPHIC_EQ_BANDS.map((f) => [bandKey(f), num(-12, 12, 0, 'dB', `${f >= 1000 ? f / 1000 + ' kHz' : f + ' Hz'} band`)])),
      output: num(-24, 12, 0, 'dB', 'Output level'),
    },
  },
  multiband: {
    label: 'Multiband compressor',
    description: '3-band compressor with phase-coherent Linkwitz-Riley (24 dB/oct) crossovers; with all ratios at 1 the bands sum back flat.',
    params: {
      lowCross: num(40, 1000, 200, 'Hz', 'Crossover low/mid'),
      highCross: num(1000, 16000, 3000, 'Hz', 'Crossover mid/high'),
      lowThreshold: num(-60, 0, -24, 'dB'), lowRatio: num(1, 20, 2), lowMakeup: num(-12, 24, 0, 'dB'),
      midThreshold: num(-60, 0, -24, 'dB'), midRatio: num(1, 20, 2), midMakeup: num(-12, 24, 0, 'dB'),
      highThreshold: num(-60, 0, -24, 'dB'), highRatio: num(1, 20, 2), highMakeup: num(-12, 24, 0, 'dB'),
      attack: num(0, 1000, 10, 'ms', 'Attack for all bands'),
      release: num(10, 1000, 150, 'ms', 'Release for all bands'),
    },
  },
  expander: {
    label: 'Expander',
    description: 'Downward expander: below `threshold` the level falls `ratio` dB per dB (at most `range`); softer than a gate for taming room noise.',
    params: {
      threshold: num(-90, 0, -40, 'dB'),
      ratio: num(1, 20, 2, null, '2 = every dB below threshold becomes 2 dB'),
      range: num(-90, 0, -40, 'dB', 'Maximum reduction'),
      attack: num(0.1, 100, 1, 'ms', 'How fast it opens'),
      release: num(5, 3000, 100, 'ms', 'How fast it closes'),
    },
  },
  transient: {
    label: 'Transient shaper',
    description: 'Level-independent punch control: boosts/cuts note onsets (`attack`) and the ringing tail (`sustain`).',
    params: {
      attack: num(-24, 24, 6, 'dB', 'Gain applied to onsets (+ = punchier, − = softer)'),
      sustain: num(-24, 24, 0, 'dB', 'Gain applied to decays (+ = more room/ring, − = tighter)'),
      output: num(-24, 12, 0, 'dB'),
    },
  },
  distortion: {
    label: 'Distortion',
    description: 'Tanh waveshaper overdrive (4x oversampled) with a post low-pass tone control and dry/wet mix.',
    params: {
      drive: num(0, 40, 12, 'dB', 'Input gain into the shaper'),
      tone: num(500, 20000, 7000, 'Hz', 'Low-pass after the shaper (lower = darker)'),
      mix: num(0, 1, 1),
      output: num(-24, 12, -6, 'dB', 'Output level (drive makes quiet parts much louder)'),
    },
  },
  bitcrusher: {
    label: 'Bit crusher',
    description: 'Lo-fi digital grit: reduces bit depth and sample rate (sample-and-hold, no anti-alias filter).',
    params: {
      bits: num(1, 16, 8, null, 'Bit depth (fractional values allowed)'),
      rate: num(100, 48000, 11025, 'Hz', 'Effective sample rate; at or above the project rate = off'),
      mix: num(0, 1, 1),
    },
  },
  pingpong: {
    label: 'Ping-pong delay',
    description: 'Stereo delay whose echoes alternate left/right; dry stays at unity, mix sets the echo level.',
    params: {
      time: num(5, 2000, 375, 'ms', 'Time between echoes'),
      feedback: num(0, 0.9, 0.5, null, 'Level of each echo relative to the previous one'),
      damping: num(500, 20000, 6000, 'Hz', 'Low-pass on the repeats (echoes get darker)'),
      mix: num(0, 1, 0.3),
    },
  },
  autofilter: {
    label: 'Auto filter',
    description: 'Resonant filter swept by a timeline-locked LFO (auto-wah); sweep is in octaves around `frequency`.',
    params: {
      mode: num(0, 2, 1, null, 'Integer: 0 lowpass, 1 bandpass, 2 highpass'),
      frequency: num(100, 8000, 800, 'Hz', 'Centre of the sweep'),
      depth: num(0, 4, 2, null, 'Sweep range in octaves (± half of this around the centre)'),
      rate: num(0.05, 10, 1, 'Hz'),
      Q: num(0.5, 15, 4, null, 'Resonance'),
      mix: num(0, 1, 1),
    },
  },
  pitchshift: {
    label: 'Pitch shifter',
    description: 'Real-time pitch shift (two-tap overlap-add delay); fine for previews, but the destructive `pitch` process (Rubber Band) gives the highest quality.',
    params: {
      semitones: num(-12, 12, 0, null, 'Shift in semitones'),
      window: num(20, 120, 60, 'ms', 'Grain length: short = less echo, long = smoother tone'),
      mix: num(0, 1, 1),
    },
  },
  doubler: {
    label: 'Doubler',
    description: 'Vocal/instrument doubler: two short, slowly detuned delayed copies panned left and right.',
    params: {
      detune: num(0, 30, 8, null, 'Pitch drift of the copies in cents'),
      delay: num(8, 60, 22, 'ms', 'Base delay of the copies'),
      spread: num(0, 1, 1, null, 'Stereo spread of the copies (0 = centre)'),
      mix: num(0, 1, 0.5, null, 'Level of the copies'),
    },
  },
  invert: {
    label: 'Invert polarity',
    description: 'Flips the polarity (phase 180°) of both channels or one channel.',
    params: {
      channel: num(0, 2, 0, null, 'Integer: 0 both, 1 left only, 2 right only'),
    },
  },
  dcfilter: {
    label: 'DC offset removal',
    description: 'Removes DC offset and subsonic rumble with a gentle 12 dB/oct high-pass.',
    params: {
      frequency: num(2, 40, 10, 'Hz', 'High-pass corner'),
    },
  },
  vocalenhancer: {
    label: 'Vocal enhancer',
    description: 'One-knob voice polish: low cut, less mud, presence and air boost, gentle compression; `amount` scales all of it.',
    params: {
      amount: num(0, 1, 0.5),
    },
  },
  ringmod: {
    label: 'Ring modulator',
    description: 'Multiplies the signal with a sine carrier (timeline-locked): metallic, robotic, bell-like tones.',
    params: {
      frequency: num(1, 5000, 440, 'Hz', 'Carrier frequency (below ~20 Hz it acts like tremolo)'),
      mix: num(0, 1, 0.5),
    },
  },
  exciter: {
    label: 'Exciter',
    description: 'Adds generated harmonics above `frequency` for sparkle and clarity on dull recordings.',
    params: {
      frequency: num(1000, 12000, 3500, 'Hz', 'Only content above this is excited'),
      amount: num(0, 1, 0.3, null, 'Level of the added harmonics'),
    },
  },
};

const dbToGain = (db) => Math.pow(10, db / 20);
// Web Audio interprets Q of lowpass/highpass biquads in dB (resonance); Butterworth = −3.01 dB.
// All other types take a linear Q. qFor() converts a linear Q for any type.
const BUTTER = 20 * Math.log10(Math.SQRT1_2);
const qFor = (type, q) => (type === 'lowpass' || type === 'highpass' ? 20 * Math.log10(q) : q);
const mode = (v, max) => Math.max(0, Math.min(max, Math.round(v)));

// Sine LFO whose phase at timeline time t is 2π·rate·t + offset (same as modfx.js).
function lfo(ctx, rate, timing, offset = 0) {
  const osc = ctx.createOscillator();
  const phase = 2 * Math.PI * rate * (timing?.from || 0) + offset;
  const wave = ctx.createPeriodicWave(new Float32Array([0, Math.sin(phase)]), new Float32Array([0, Math.cos(phase)]), { disableNormalization: true });
  osc.setPeriodicWave(wave);
  osc.frequency.value = rate;
  osc.start(timing?.when || 0);
  return osc;
}

const tanhCurve = (k, n = 4096) => {
  const c = new Float32Array(n), norm = Math.tanh(k);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / norm; }
  return c;
};

/**
 * Build one of MORE_EFFECTS. Returns { input, output, nodes, update, sources } or null if the
 * type is unknown. `P(params)` merges defaults; `WorkletNode` is the AudioWorkletNode
 * constructor (the server passes node-web-audio-api's).
 */
export function buildMoreEffect(ctx, fx, P, timing, WorkletNode = globalThis.AudioWorkletNode) {
  if (!MORE_EFFECTS[fx.type]) return null;
  const nodes = [], sources = [];
  const mk = (n) => (nodes.push(n), n);
  const input = mk(ctx.createGain());
  const output = mk(ctx.createGain());
  // Stereo normally; 6 on a 5.1 master/bus (timing.channels). Ping-pong and doubler always
  // produce a stereo wet signal (it lands on front L/R of a 5.1 bus).
  const nch = timing?.channels || 2;
  input.channelCount = nch; input.channelCountMode = 'explicit';
  let update = () => {};
  const p0 = P(fx.params);
  const biquad = (type, f, q) => { const b = mk(ctx.createBiquadFilter()); b.type = type; if (f) b.frequency.value = f; if (q) b.Q.value = q; return b; };
  const worklet = (name) => mk(new WorkletNode(ctx, name, {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [nch],
    processorOptions: { from: timing?.from || 0, when: timing?.when || 0 },
  }));
  const bandComp = (inputs) => mk(new WorkletNode(ctx, 'klang-bandcomp', { numberOfInputs: inputs, numberOfOutputs: 1, outputChannelCount: [nch] }));
  const setParams = (node, p, keys) => { for (const k of keys) node.parameters.get(k).value = p[k]; };

  switch (fx.type) {
    case 'filter': {
      const b = biquad('lowpass');
      input.connect(b).connect(output);
      update = (params) => {
        const p = P(params);
        b.type = FILTER_MODES[mode(p.mode, 6)];
        b.frequency.value = p.frequency; b.Q.value = qFor(b.type, p.Q); b.gain.value = p.gain;
      };
      break;
    }
    case 'graphiceq': {
      // Octave bands: Q = √2 gives a one-octave bandwidth per bell.
      const bands = GRAPHIC_EQ_BANDS.map((f) => biquad('peaking', f, Math.SQRT2));
      let cur = input;
      for (const b of bands) { cur.connect(b); cur = b; }
      cur.connect(output);
      update = (params) => {
        const p = P(params);
        GRAPHIC_EQ_BANDS.forEach((f, i) => { bands[i].gain.value = p[bandKey(f)]; });
        output.gain.value = dbToGain(p.output);
      };
      break;
    }
    case 'multiband': {
      // LR4 = two cascaded Butterworth biquads. low = AP2(LP1²), mid = LP2²(HP1²), high = HP2²(HP1²).
      // LP² + HP² at one corner is the 2nd-order all-pass AP (Q 0.7071), so the sum is AP1·AP2: flat.
      const Q = BUTTER;
      const lp1 = [biquad('lowpass', 0, Q), biquad('lowpass', 0, Q)], hp1 = [biquad('highpass', 0, Q), biquad('highpass', 0, Q)];
      const ap2 = biquad('allpass', 0, Math.SQRT1_2);
      const lp2 = [biquad('lowpass', 0, Q), biquad('lowpass', 0, Q)], hp2 = [biquad('highpass', 0, Q), biquad('highpass', 0, Q)];
      input.connect(lp1[0]).connect(lp1[1]).connect(ap2);
      input.connect(hp1[0]).connect(hp1[1]);
      hp1[1].connect(lp2[0]).connect(lp2[1]);
      hp1[1].connect(hp2[0]).connect(hp2[1]);
      // One worklet compresses all three bands (input k = band k) and sums them. Unlike the
      // native DynamicsCompressor it has no hidden auto-makeup and no lookahead delay.
      const comp = bandComp(3);
      [ap2, lp2[1], hp2[1]].forEach((src, k) => src.connect(comp, 0, k));
      comp.connect(output);
      update = (params) => {
        const p = P(params);
        const lc = Math.min(p.lowCross, p.highCross / 1.5), hc = p.highCross;
        for (const b of [...lp1, ...hp1]) b.frequency.value = lc;
        for (const b of [...lp2, ...hp2, ap2]) b.frequency.value = hc; // the all-pass mirrors the high crossover
        const set = (k, v) => { comp.parameters.get(k).value = v; };
        ['low', 'mid', 'high'].forEach((k, i) => { set(`t${i}`, p[`${k}Threshold`]); set(`r${i}`, p[`${k}Ratio`]); set(`m${i}`, p[`${k}Makeup`]); });
        set('attack', p.attack); set('release', p.release); set('knee', 6);
      };
      break;
    }
    case 'expander':
    case 'transient':
    case 'bitcrusher':
    case 'pitchshift': {
      const node = worklet(`klang-${fx.type}`);
      input.connect(node).connect(output);
      const keys = Object.keys(MORE_EFFECTS[fx.type].params);
      update = (params) => setParams(node, P(params), keys);
      break;
    }
    case 'distortion': {
      const pre = mk(ctx.createGain()), shaper = mk(ctx.createWaveShaper()), tone = biquad('lowpass', 0, BUTTER);
      const wet = mk(ctx.createGain()), dry = mk(ctx.createGain());
      shaper.oversample = '4x';
      input.connect(pre).connect(shaper).connect(tone).connect(wet).connect(output);
      input.connect(dry).connect(output);
      let k = null;
      update = (params) => {
        const p = P(params);
        const drive = dbToGain(p.drive);
        // The curve covers [-1, 1] after a pre-gain of 1/2 so peaks up to 2x (+6 dBFS) still shape smoothly.
        if (drive !== k) { k = drive; shaper.curve = tanhCurve(2 * drive); }
        pre.gain.value = 0.5;
        tone.frequency.value = p.tone;
        const o = dbToGain(p.output);
        wet.gain.value = p.mix * o; dry.gain.value = (1 - p.mix) * o;
      };
      break;
    }
    case 'pingpong': {
      const mono = mk(ctx.createGain()); mono.channelCount = 1; mono.channelCountMode = 'explicit'; // (L+R)/2
      const dL = mk(ctx.createDelay(2.5)), dR = mk(ctx.createDelay(2.5));
      const fbLR = mk(ctx.createGain()), fbRL = mk(ctx.createGain()), damp = biquad('lowpass', 0, BUTTER);
      const merge = mk(ctx.createChannelMerger(2)), wet = mk(ctx.createGain());
      input.connect(output);
      input.connect(mono).connect(dL);
      dL.connect(fbLR).connect(dR);          // L echo → next echo on the right
      dR.connect(fbRL).connect(damp).connect(dL); // R echo → darker echo on the left
      dL.connect(merge, 0, 0); dR.connect(merge, 0, 1);
      merge.connect(wet).connect(output);
      update = (params) => {
        const p = P(params);
        dL.delayTime.value = dR.delayTime.value = p.time / 1000;
        fbLR.gain.value = fbRL.gain.value = p.feedback;
        damp.frequency.value = p.damping;
        wet.gain.value = p.mix;
      };
      break;
    }
    case 'autofilter': {
      const b = biquad('bandpass');
      const sweep = mk(ctx.createGain()), wet = mk(ctx.createGain()), dry = mk(ctx.createGain());
      const osc = lfo(ctx, p0.rate, timing); sources.push(osc);
      osc.connect(sweep).connect(b.detune); // detune is in cents: an exponential (musical) sweep
      input.connect(b).connect(wet).connect(output);
      input.connect(dry).connect(output);
      update = (params) => {
        const p = P(params);
        b.type = ['lowpass', 'bandpass', 'highpass'][mode(p.mode, 2)];
        b.frequency.value = p.frequency; b.Q.value = qFor(b.type, p.Q);
        sweep.gain.value = p.depth * 600; // ± depth/2 octaves
        osc.frequency.value = p.rate;
        wet.gain.value = p.mix; dry.gain.value = 1 - p.mix;
      };
      break;
    }
    case 'doubler': {
      const mono = mk(ctx.createGain()); mono.channelCount = 1; mono.channelCountMode = 'explicit';
      const merge = mk(ctx.createChannelMerger(2)), wet = mk(ctx.createGain());
      input.connect(output);
      input.connect(mono);
      // Two voices with unrelated LFO rates so the copies never move together.
      const voices = [{ rate: 0.23, off: 0, scale: 1 }, { rate: 0.31, off: Math.PI / 2, scale: 1.37 }].map((v, i) => {
        const d = mk(ctx.createDelay(0.2)), depth = mk(ctx.createGain());
        const osc = lfo(ctx, v.rate, timing, v.off); sources.push(osc);
        osc.connect(depth).connect(d.delayTime);
        const toL = mk(ctx.createGain()), toR = mk(ctx.createGain());
        mono.connect(d); d.connect(toL); d.connect(toR);
        toL.connect(merge, 0, 0); toR.connect(merge, 0, 1);
        return { ...v, i, d, depth, toL, toR };
      });
      merge.connect(wet).connect(output);
      update = (params) => {
        const p = P(params);
        for (const v of voices) {
          v.d.delayTime.value = (p.delay * v.scale) / 1000;
          // Pitch drift of a sine-modulated delay: peak ratio 1 + 2π·f·D → D = (2^(c/1200) − 1)/(2π·f).
          const D = (Math.pow(2, p.detune / 1200) - 1) / (2 * Math.PI * v.rate);
          v.depth.gain.value = Math.min(D, (p.delay * v.scale) / 1000 - 0.001);
          const pan = v.i === 0 ? -p.spread : p.spread; // equal-power pan
          v.toL.gain.value = Math.cos(((pan + 1) * Math.PI) / 4); v.toR.gain.value = Math.sin(((pan + 1) * Math.PI) / 4);
        }
        wet.gain.value = p.mix;
        output.gain.value = 1 / (1 + p.mix * 0.5);
      };
      break;
    }
    case 'invert': {
      const split = mk(ctx.createChannelSplitter(nch)), merge = mk(ctx.createChannelMerger(nch));
      const gains = Array.from({ length: nch }, (_, ch) => { const g = mk(ctx.createGain()); split.connect(g, ch); g.connect(merge, 0, ch); return g; });
      input.connect(split); merge.connect(output);
      update = (params) => {
        const c = mode(P(params).channel, 2); // 0 all, 1 left only, 2 right only
        gains.forEach((g, ch) => { g.gain.value = c === 0 || c === ch + 1 ? -1 : 1; });
      };
      break;
    }
    case 'dcfilter': {
      const b = biquad('highpass', 10, BUTTER);
      input.connect(b).connect(output);
      update = (params) => { b.frequency.value = P(params).frequency; };
      break;
    }
    case 'vocalenhancer': {
      const hp = biquad('highpass', 80, BUTTER), mud = biquad('peaking', 300, 1);
      const presence = biquad('peaking', 3500, 0.8), air = biquad('highshelf', 10000);
      const comp = bandComp(1);
      const set = (k, v) => { comp.parameters.get(k).value = v; };
      set('knee', 12); set('attack', 8); set('release', 150);
      input.connect(hp).connect(mud).connect(presence).connect(air).connect(comp).connect(output);
      update = (params) => {
        const a = P(params).amount;
        hp.frequency.value = 20 + 80 * a;           // 20 Hz (off) … 100 Hz
        mud.gain.value = -4 * a;
        presence.gain.value = 5 * a;
        air.gain.value = 3 * a;
        set('t0', -12 - 12 * a);                      // -12 … -24 dB
        set('r0', 1 + 2 * a);                         // 1 … 3:1
        set('m0', 3 * a);
      };
      break;
    }
    case 'ringmod': {
      const mod = mk(ctx.createGain()), wet = mk(ctx.createGain()), dry = mk(ctx.createGain());
      mod.gain.value = 0; // gain = carrier
      const osc = lfo(ctx, p0.frequency, timing); sources.push(osc);
      osc.connect(mod.gain);
      input.connect(mod).connect(wet).connect(output);
      input.connect(dry).connect(output);
      update = (params) => { const p = P(params); osc.frequency.value = p.frequency; wet.gain.value = p.mix; dry.gain.value = 1 - p.mix; };
      break;
    }
    case 'exciter': {
      const hp1 = biquad('highpass', 3500, BUTTER), shaper = mk(ctx.createWaveShaper()), hp2 = biquad('highpass', 3500, BUTTER);
      const amt = mk(ctx.createGain());
      // |x| has no component at the input frequency: only even harmonics (octave up) are added.
      const n = 2049, curve = new Float32Array(n);
      for (let i = 0; i < n; i++) curve[i] = Math.abs((i / (n - 1)) * 2 - 1);
      shaper.curve = curve; shaper.oversample = '2x';
      input.connect(output);
      input.connect(hp1).connect(shaper).connect(hp2).connect(amt).connect(output);
      update = (params) => {
        const p = P(params);
        hp1.frequency.value = hp2.frequency.value = p.frequency;
        amt.gain.value = p.amount;
      };
      break;
    }
  }
  update(fx.params);
  return { input, output, nodes, update, sources };
}
