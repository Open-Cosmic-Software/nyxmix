// Ready-made effect chains (Audition's "Essential Sound" idea). Shared by UI and server.
export const PRESETS = {
  'podcast-voice': {
    label: 'Podcast voice',
    target: 'track',
    description: 'Clean, present, even spoken word: low cut, mud cut, presence lift, de-ess, gentle compression.',
    effects: [
      { type: 'eq', params: { hpFreq: 80, lowFreq: 180, lowGain: 0, mid1Freq: 300, mid1Gain: -3, mid1Q: 1.2, mid2Freq: 3500, mid2Gain: 2.5, mid2Q: 0.9, highFreq: 10000, highGain: 1.5 } },
      { type: 'deesser', params: { frequency: 6500, threshold: -32, reduction: 8 } },
      { type: 'compressor', params: { threshold: -22, ratio: 3, knee: 8, attack: 8, release: 180, makeup: 4 } },
    ],
  },
  'warm-narrator': {
    label: 'Warm narrator',
    target: 'track',
    description: 'Fuller low end and smooth top for audiobooks and voice-over.',
    effects: [
      { type: 'eq', params: { hpFreq: 60, lowFreq: 140, lowGain: 2, mid1Freq: 450, mid1Gain: -2, mid1Q: 1, mid2Freq: 2800, mid2Gain: 1.5, mid2Q: 1, highFreq: 9000, highGain: -1 } },
      { type: 'saturation', params: { drive: 4, mix: 0.35, output: -1 } },
      { type: 'compressor', params: { threshold: -24, ratio: 2.5, knee: 10, attack: 15, release: 250, makeup: 3 } },
    ],
  },
  'phone-voice': {
    label: 'Telephone',
    target: 'track',
    description: 'Narrow band-limited voice, like a phone call.',
    effects: [
      { type: 'eq', params: { hpFreq: 400, mid1Freq: 1500, mid1Gain: 6, mid1Q: 1, lpFreq: 3400 } },
      { type: 'saturation', params: { drive: 12, mix: 0.6, output: -4 } },
    ],
  },
  'clean-noisy-voice': {
    label: 'Tame room noise',
    target: 'track',
    description: 'Gate the gaps between phrases and cut rumble. Pair with noise reduction for steady hiss.',
    effects: [
      { type: 'eq', params: { hpFreq: 90 } },
      { type: 'gate', params: { threshold: -48, range: -18, attack: 2, hold: 120, release: 220 } },
    ],
  },
  'music-bed': {
    label: 'Music bed',
    target: 'track',
    description: 'Make room for voices: dip the vocal range and sit the music lower.',
    effects: [
      { type: 'eq', params: { mid1Freq: 2500, mid1Gain: -4, mid1Q: 0.8 } },
      { type: 'gain', params: { gain: -8 } },
    ],
  },
  'tube-compressor': {
    label: 'Tube compressor',
    target: 'track',
    description: 'Slow, warm optical-style compression with gentle tube saturation (Audition: Tube-modeled Compressor).',
    effects: [
      { type: 'saturation', params: { drive: 5, mix: 0.45, output: -2 } },
      { type: 'compressor', params: { threshold: -20, ratio: 3, knee: 18, attack: 25, release: 400, makeup: 4 } },
      { type: 'eq', params: { highFreq: 9000, highGain: -1.5 } },
    ],
  },
  'analog-delay': {
    label: 'Analog delay',
    target: 'track',
    description: 'Dark, saturated echoes that lose highs with every repeat, like a tape or bucket-brigade delay (Audition: Analog Delay).',
    effects: [
      { type: 'pingpong', params: { time: 350, feedback: 0.45, damping: 2500, mix: 0.3 } },
      { type: 'saturation', params: { drive: 3, mix: 0.3, output: -1 } },
    ],
  },
  'guitar-amp': {
    label: 'Guitar amp',
    target: 'track',
    description: 'Compressor, overdrive, amp-style mid push and a speaker-cabinet roll-off (Audition: Guitar Suite).',
    effects: [
      { type: 'compressor', params: { threshold: -24, ratio: 4, knee: 6, attack: 5, release: 120, makeup: 6 } },
      { type: 'distortion', params: { drive: 18, mix: 1 } },
      { type: 'eq', params: { hpFreq: 90, mid1Freq: 800, mid1Gain: 4, mid1Q: 0.8, mid2Freq: 3000, mid2Gain: -3, mid2Q: 1.2, lpFreq: 5500 } },
    ],
  },
  'master-podcast': {
    label: 'Podcast master',
    target: 'master',
    description: 'Glue compression plus a -1 dB true-peak-safe limiter. Export with loudness -16 LUFS.',
    effects: [
      { type: 'compressor', params: { threshold: -14, ratio: 2, knee: 10, attack: 20, release: 250, makeup: 2 } },
      { type: 'limiter', params: { drive: 2, ceiling: -1.2, release: 80 } },
    ],
  },
  'master-music': {
    label: 'Music master',
    target: 'master',
    description: 'Gentle tilt, glue and a loud limiter for streaming (-14 LUFS).',
    effects: [
      { type: 'eq', params: { hpFreq: 25, lowFreq: 90, lowGain: 1, highFreq: 11000, highGain: 1.5 } },
      { type: 'compressor', params: { threshold: -16, ratio: 2, knee: 12, attack: 30, release: 200, makeup: 2 } },
      { type: 'limiter', params: { drive: 4, ceiling: -1, release: 60 } },
    ],
  },
};
