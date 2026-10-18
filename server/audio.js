import { existsSync } from 'node:fs';
// Audio I/O, analysis, destructive processing (ffmpeg) and offline rendering
// (node-web-audio-api running the same graph as the browser).
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { projectEnd, effectDefaults, EFFECTS } from '../public/js/engine/graph.js';
let pluginDir = null;
export const setPluginDir = (d) => { pluginDir = d; };
export const pluginPath = (id) => `${pluginDir}/${id}.js`;
import { fork } from 'node:child_process';
import os from 'node:os';

const VENV_PY = fileURLToPath(new URL('../.venv/bin/python', import.meta.url));
const PITCH_SCRIPT = fileURLToPath(new URL('./pitchcorrect.py', import.meta.url));
const FX_SCRIPT = fileURLToPath(new URL('./audition_fx.py', import.meta.url));
const FX_ARGS = { centerExtract: ['mode', 'lowHz', 'highHz', 'strength'], dereverb: ['amount', 'rt60'], soundRemove: ['strength', 'sensitivity', 'learnStart', 'learnEnd'], phaseAlign: ['maxShiftMs', 'centre'], doppler: ['speed', 'distance', 'passTime', 'volumeChange'], pitchBend: ['startSemitones', 'endSemitones', 'curve'] };
const RNN_MODEL = fileURLToPath(new URL('../models/sh.rnnn', import.meta.url));
const WORKLET_PATH = fileURLToPath(new URL('../public/js/engine/dsp-worklet.js', import.meta.url));

export const PEAK_BLOCK = 256; // frames per peak pair

export function run(cmd, args, { input, timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const out = []; const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => { err.push(d); if (err.length > 4000) err.splice(0, 2000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(err).toString();
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr });
      else reject(Object.assign(new Error(`${cmd} failed (${code}): ${stderr.split('\n').filter(Boolean).slice(-3).join(' | ')}`), { status: 422, code: 'ffmpeg_failed' }));
    });
    if (input) child.stdin.end(input);
  });
}
const ffmpeg = (args, opts) => run('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args], opts);

export async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const info = JSON.parse(stdout.toString());
  const a = (info.streams || []).find((s) => s.codec_type === 'audio');
  if (!a) throw Object.assign(new Error('No audio stream found in file'), { status: 415, code: 'no_audio' });
  return { codec: a.codec_name, sampleRate: +a.sample_rate, channels: a.channels, duration: +(a.duration || info.format?.duration || 0), format: info.format?.format_name };
}

// Any input → 32-bit float WAV at the project rate, mono or stereo.
export async function importToWav(src, dest, sampleRate) {
  const info = await probe(src);
  const ch = info.channels >= 2 ? 2 : 1;
  await ffmpeg(['-i', src, '-vn', '-map', '0:a:0', '-ac', String(ch), '-ar', String(sampleRate), '-c:a', 'pcm_f32le', '-bitexact', dest]);
  return info;
}

// ── WAV (float32) I/O ────────────────────────────────────────────────────
export async function readWav(file) {
  const buf = await fs.readFile(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file');
  let pos = 12, fmt, dataOff, dataLen;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(pos + 8), channels: buf.readUInt16LE(pos + 10), sampleRate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    if (id === 'data') { dataOff = pos + 8; dataLen = Math.min(size, buf.length - dataOff); break; }
    pos += 8 + size + (size & 1);
  }
  if (!fmt || dataOff === undefined) throw new Error('Malformed WAV');
  if (fmt.bits !== 32 || (fmt.format !== 3 && fmt.format !== 0xfffe)) throw new Error('Expected 32-bit float WAV');
  const frames = Math.floor(dataLen / (4 * fmt.channels));
  const aligned = new Float32Array(buf.buffer.slice(buf.byteOffset + dataOff, buf.byteOffset + dataOff + frames * 4 * fmt.channels));
  const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  for (let i = 0, k = 0; i < frames; i++) for (let c = 0; c < fmt.channels; c++) channels[c][i] = aligned[k++];
  return { sampleRate: fmt.sampleRate, channels, frames };
}

export async function writeWav(file, channels, sampleRate) {
  const nch = channels.length, frames = channels[0].length;
  const data = new Float32Array(frames * nch);
  for (let i = 0, k = 0; i < frames; i++) for (let c = 0; c < nch; c++) data[k++] = channels[c][i];
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.byteLength, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(nch, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * nch * 4, 28); header.writeUInt16LE(nch * 4, 32); header.writeUInt16LE(32, 34);
  header.write('data', 36); header.writeUInt32LE(data.byteLength, 40);
  await fs.writeFile(file, Buffer.concat([header, Buffer.from(data.buffer)]));
}

// min/max pairs per PEAK_BLOCK frames, int8 scaled by 127, across channels.
export async function writePeaks(wavFile, peaksFile) {
  const { channels, frames } = await readWav(wavFile);
  const blocks = Math.ceil(frames / PEAK_BLOCK);
  const out = new Int8Array(blocks * 2);
  for (let b = 0; b < blocks; b++) {
    let mn = 0, mx = 0;
    const end = Math.min(frames, (b + 1) * PEAK_BLOCK);
    for (const ch of channels) for (let i = b * PEAK_BLOCK; i < end; i++) { const v = ch[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    out[b * 2] = Math.max(-127, Math.round(mn * 127));
    out[b * 2 + 1] = Math.min(127, Math.round(mx * 127));
  }
  await fs.writeFile(peaksFile, Buffer.from(out.buffer));
  let peak = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
  return { peak };
}

// Lossless 24-bit FLAC copy for the browser: same sound, a fraction of the transfer.
// Skipped when the float file goes above full scale (FLAC would clip it).
export async function writePreview(wavFile, flacFile) {
  await ffmpeg(['-i', wavFile, '-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', '-compression_level', '5', flacFile]);
}

// ── analysis ─────────────────────────────────────────────────────────────
const db = (x) => (x > 0 ? Math.round(20 * Math.log10(x) * 100) / 100 : -144);

function slice({ channels, sampleRate, frames }, start = 0, end) {
  const s = Math.max(0, Math.floor(start * sampleRate));
  const e = Math.min(frames, end !== undefined ? Math.ceil(end * sampleRate) : frames);
  return { channels: channels.map((c) => c.subarray(s, e)), sampleRate, frames: Math.max(0, e - s), offset: start };
}

export async function loudness(file, start, end) {
  const args = [];
  if (start) args.push('-ss', String(start));
  if (end !== undefined) args.push('-to', String(end));
  const { stderr } = await ffmpeg(['-nostats', ...args, '-i', file, '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-']);
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const grab = (re) => { const m = summary.match(re); return m ? parseFloat(m[1]) : null; };
  return {
    integratedLufs: grab(/I:\s+(-?[\d.]+|-inf)\s+LUFS/),
    loudnessRangeLu: grab(/LRA:\s+(-?[\d.]+)\s+LU/),
    truePeakDbtp: grab(/Peak:\s+(-?[\d.]+|-inf)\s+dBFS/),
  };
}

export function levels(audio) {
  let peak = 0, sum = 0, n = 0, clipped = 0, dc = 0;
  for (const ch of audio.channels) for (let i = 0; i < ch.length; i++) {
    const v = ch[i], a = Math.abs(v);
    if (a > peak) peak = a;
    if (a >= 0.9999) clipped++;
    sum += v * v; dc += v; n++;
  }
  const out = { samplePeakDbfs: db(peak), rmsDbfs: db(Math.sqrt(sum / Math.max(1, n))), clippedSamples: clipped, dcOffset: n ? Math.round((dc / n) * 1e6) / 1e6 : 0 };
  // Stereo phase: correlation +1 = mono-like, 0 = wide, below 0 = phase problems
  // (cancels when summed to mono). monoLossDb = level change when folded to mono.
  if (audio.channels.length >= 2) {
    const [L, R] = audio.channels;
    let lr = 0, ll = 0, rr = 0, m2 = 0;
    for (let i = 0; i < L.length; i++) { lr += L[i] * R[i]; ll += L[i] * L[i]; rr += R[i] * R[i]; const m = (L[i] + R[i]) / 2; m2 += m * m; }
    out.stereoCorrelation = ll && rr ? Math.round((lr / Math.sqrt(ll * rr)) * 1000) / 1000 : null;
    out.monoLossDb = ll + rr ? Math.round(10 * Math.log10((2 * m2) / ((ll + rr) / 2 + 1e-30) + 1e-30) * 10) / 10 : null;
  }
  return out;
}

export function silences(audio, { thresholdDb = -45, minDuration = 0.5 } = {}) {
  const win = Math.max(1, Math.round(audio.sampleRate * 0.01));
  const thr = Math.pow(10, thresholdDb / 20);
  const out = []; let runStart = -1;
  const nwin = Math.floor(audio.frames / win);
  for (let w = 0; w <= nwin; w++) {
    let quiet = w < nwin;
    if (quiet) {
      let s = 0;
      for (const ch of audio.channels) for (let i = w * win; i < (w + 1) * win; i++) s += ch[i] * ch[i];
      quiet = Math.sqrt(s / (win * audio.channels.length)) < thr;
    }
    if (quiet && runStart < 0) runStart = w;
    if (!quiet && runStart >= 0) {
      // A pause that runs into the end of the material ends exactly there (not on the
      // 10 ms grid), so cutting it never leaves a sliver behind.
      let endFrame = w * win;
      if (w === nwin) {
        let s2 = 0, n2 = 0;
        for (const ch of audio.channels) for (let i = nwin * win; i < audio.frames; i++) { s2 += ch[i] * ch[i]; n2++; }
        if (!n2 || Math.sqrt(s2 / n2) < thr) endFrame = audio.frames;
      }
      const s = (runStart * win) / audio.sampleRate, e = endFrame / audio.sampleRate;
      if (e - s >= minDuration) out.push({ start: r3(s + audio.offset), end: r3(e + audio.offset), duration: r3(e - s) });
      runStart = -1;
    }
  }
  return out;
}
const r3 = (x) => Math.round(x * 1000) / 1000;

// Short-term loudness-ish envelope: RMS dBFS per `step` seconds.
export function envelope(audio, step = 0.25) {
  const win = Math.max(1, Math.round(audio.sampleRate * step));
  const out = [];
  for (let s = 0; s < audio.frames; s += win) {
    let sum = 0, n = 0;
    for (const ch of audio.channels) for (let i = s; i < Math.min(audio.frames, s + win); i++) { sum += ch[i] * ch[i]; n++; }
    out.push(Math.round(db(Math.sqrt(sum / Math.max(1, n))) * 10) / 10);
  }
  return { stepSeconds: step, startSeconds: audio.offset, rmsDbfs: out };
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

export const BANDS = [
  ['sub', 20, 60], ['bass', 60, 250], ['lowMid', 250, 500], ['mid', 500, 2000],
  ['highMid', 2000, 4000], ['presence', 4000, 6000], ['brilliance', 6000, 20000],
];
export function spectrum(audio) {
  const N = 4096, sr = audio.sampleRate;
  const frames = Math.floor(audio.frames / N);
  if (frames < 1) return null;
  const take = Math.min(frames, 300);
  const power = new Float64Array(N / 2);
  const hann = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  for (let f = 0; f < take; f++) {
    const start = Math.floor((f * (frames - 1)) / Math.max(1, take - 1)) * N;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) { let v = 0; for (const ch of audio.channels) v += ch[start + i]; re[i] = (v / audio.channels.length) * hann[i]; }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) power[k] += re[k] * re[k] + im[k] * im[k];
  }
  const binHz = sr / N;
  let total = 0, weighted = 0;
  for (let k = 1; k < N / 2; k++) { total += power[k]; weighted += power[k] * k * binHz; }
  const bands = {};
  for (const [name, lo, hi] of BANDS) {
    let s = 0;
    for (let k = Math.ceil(lo / binHz); k <= Math.min(N / 2 - 1, Math.floor(hi / binHz)); k++) s += power[k];
    bands[name] = Math.round(10 * Math.log10(Math.max(1e-20, s / Math.max(1e-20, total))) * 10) / 10;
  }
  return { bandsRelativeDb: bands, spectralCentroidHz: Math.round(weighted / Math.max(1e-20, total)), note: 'Band energy relative to the total, in dB (0 = all energy in that band).' };
}

export async function analyzeFile(file, { start = 0, end, include = ['loudness', 'levels', 'silences', 'spectrum'], silenceThresholdDb, minSilence, envelopeStep } = {}) {
  const audio = slice(await readWav(file), start, end);
  const out = { start, end: end ?? r3(start + audio.frames / audio.sampleRate), duration: r3(audio.frames / audio.sampleRate), sampleRate: audio.sampleRate, channels: audio.channels.length };
  if (include.includes('loudness')) out.loudness = await loudness(file, start, end);
  if (include.includes('levels')) out.levels = levels(audio);
  if (include.includes('silences')) out.silences = silences(audio, { thresholdDb: silenceThresholdDb, minDuration: minSilence });
  if (include.includes('spectrum')) out.spectrum = spectrum(audio);
  if (include.includes('envelope')) out.envelope = envelope(audio, envelopeStep);
  return out;
}

// ── pictures for multimodal agents (and the UI) ──────────────────────────
export async function image(file, kind, { start, end, width = 1600, height } = {}) {
  const range = [];
  if (start) range.push('-ss', String(start));
  if (end !== undefined) range.push('-to', String(end));
  const filter = kind === 'spectrogram'
    ? `showspectrumpic=s=${width}x${height || 512}:legend=1:fscale=log:color=magma:gain=1.5`
    : `showwavespic=s=${width}x${height || 300}:split_channels=1:colors=0xE8A33D|0x6FB7C9:scale=sqrt`;
  const { stdout } = await ffmpeg([...range, '-i', file, '-lavfi', filter, '-frames:v', '1', '-f', 'image2', '-c:v', 'png', 'pipe:1']);
  return stdout;
}

// ── destructive processing (Audition's "Effects" on the waveform) ─────────
export const PROCESSES = {
  normalize: { description: 'Scale so the sample peak hits a target.', keepsLength: true, params: { peakDb: { type: 'number', minimum: -24, maximum: 0, default: -1 } } },
  loudness: { description: 'EBU R128 loudness normalization (two-pass, linear). Podcasts: -16 LUFS; broadcast: -23.', keepsLength: true, params: { lufs: { type: 'number', minimum: -40, maximum: -5, default: -16 }, truePeak: { type: 'number', minimum: -9, maximum: 0, default: -1.5 } } },
  denoise: { description: 'Broadband noise reduction (FFT). strength 0–1.', keepsLength: true, params: { strength: { type: 'number', minimum: 0, maximum: 1, default: 0.5 }, noiseFloorDb: { type: 'number', minimum: -80, maximum: -20, default: -50 } } },
  dehum: { description: 'Notch out mains hum and its harmonics.', keepsLength: true, params: { frequency: { type: 'number', enum: [50, 60], default: 50 }, harmonics: { type: 'integer', minimum: 1, maximum: 8, default: 4 } } },
  declick: { description: 'Remove clicks and pops.', keepsLength: true, params: {} },
  deess: { description: 'Tame harsh sibilance.', keepsLength: true, params: { intensity: { type: 'number', minimum: 0, maximum: 1, default: 0.5 } } },
  gate: { description: 'Noise gate: mute signal below threshold.', keepsLength: true, params: { thresholdDb: { type: 'number', minimum: -80, maximum: -10, default: -45 }, attackMs: { type: 'number', minimum: 0.1, maximum: 100, default: 5 }, releaseMs: { type: 'number', minimum: 10, maximum: 2000, default: 150 } } },
  level: { description: 'Speech leveler: evens out loud and quiet passages.', keepsLength: true, params: { expansion: { type: 'number', minimum: 1, maximum: 20, default: 6 } } },
  voiceDenoise: { description: 'Neural speech denoiser (RNNoise): removes background noise around voices, including non-steady noise. mix 1 = full effect.', keepsLength: true, params: { mix: { type: 'number', minimum: 0, maximum: 1, default: 0.85 } } },
  mono: { description: 'Mix down to mono.', keepsLength: true, params: {} },
  reverse: { description: 'Play backwards.', keepsLength: true, params: {} },
  removeSilence: { description: 'Shorten every pause longer than minSilence down to keep seconds. Changes length.', keepsLength: false, params: { thresholdDb: { type: 'number', minimum: -80, maximum: -20, default: -45 }, minSilence: { type: 'number', minimum: 0.1, maximum: 10, default: 0.7 }, keep: { type: 'number', minimum: 0, maximum: 5, default: 0.25 } } },
  tempo: { description: 'Change speed without changing pitch. Changes length.', keepsLength: false, params: { factor: { type: 'number', minimum: 0.25, maximum: 4, default: 1.1 } } },
  pitch: { description: 'Shift pitch without changing length.', keepsLength: true, params: { semitones: { type: 'number', minimum: -24, maximum: 24, default: 2 } } },
  pitchCorrect: { description: 'Automatic pitch correction for a solo voice or instrument (WORLD vocoder). key -1 = chromatic (nearest semitone), 0–11 = C…B; scale 0 major, 1 minor. speed = retune time in ms (0 = hard "auto-tune" effect, 50–150 = natural). Only voiced parts change.', keepsLength: true, params: { key: { type: 'integer', minimum: -1, maximum: 11, default: -1 }, scale: { type: 'integer', minimum: 0, maximum: 1, default: 0 }, strength: { type: 'number', minimum: 0, maximum: 1, default: 0.8 }, speed: { type: 'number', minimum: 0, maximum: 400, default: 80 }, maxCorrection: { type: 'number', minimum: 0.1, maximum: 6, default: 2, description: 'Largest correction in semitones' } } },
  declip: { description: 'Repair clipped (flattened) peaks by reconstructing the waveform (Audition: DeClipper).', keepsLength: true, params: { threshold: { type: 'number', minimum: 1, maximum: 100, default: 10, description: 'Detection sensitivity, % below full scale' } } },
  centerExtract: { description: 'Audition Center Channel Extractor (stereo only): per-bin L/R magnitude+phase similarity mask. mode 0 = keep what is panned to the centre (isolate a vocal), 1 = remove the centre (karaoke). Acts only between lowHz and highHz; strength 0–1 = depth.', keepsLength: true, params: { mode: { type: 'integer', minimum: 0, maximum: 1, default: 0, description: '0 extract centre, 1 remove centre' }, lowHz: { type: 'number', minimum: 20, maximum: 20000, default: 80 }, highHz: { type: 'number', minimum: 100, maximum: 24000, default: 16000 }, strength: { type: 'number', minimum: 0, maximum: 1, default: 1 } } },
  dereverb: { description: 'Reduce room reverberation (Audition DeReverb): suppresses the late reverb tail predicted from earlier frames and the room decay time. amount 0–1; rt60 = reverb time in s, 0 = estimate from the decays in the audio. Direct sound and onsets stay; very sustained notes lose a little level at high amounts.', keepsLength: true, params: { amount: { type: 'number', minimum: 0, maximum: 1, default: 0.6 }, rt60: { type: 'number', minimum: 0, maximum: 10, default: 0, description: 'Reverb time in seconds; 0 = automatic' } } },
  soundRemove: { description: 'Audition Sound Remover: learns the spectrum of an unwanted sound (phone ring, siren, beep) from learnStart–learnEnd (source seconds of this asset; choose a clean example) and removes matching sound wherever it occurs, leaving the rest. strength = how much is removed; sensitivity = how readily frames count as the sound.', keepsLength: true, params: { strength: { type: 'number', minimum: 0, maximum: 1, default: 1 }, sensitivity: { type: 'number', minimum: 0, maximum: 1, default: 0.5 }, learnStart: { type: 'number', minimum: 0, default: 0, description: 'Start of an example of the sound (source seconds)' }, learnEnd: { type: 'number', minimum: 0, default: 0, description: 'End of the example (source seconds)' } } },
  phaseAlign: { description: 'Audition Automatic Phase Correction (stereo only): measures the time offset between L and R by cross-correlation (sub-sample, within ±maxShiftMs) and shifts R onto L (centre 0) or both halfway (centre 1). The result reports offsetMs (positive = R was late) and the L/R correlation before/after.', keepsLength: true, params: { maxShiftMs: { type: 'number', minimum: 0.1, maximum: 10, default: 10 }, centre: { type: 'integer', minimum: 0, maximum: 1, default: 0 } } },
  doppler: { description: 'Doppler Shifter: the sound passes by on a straight line at speed m/s, closest approach distance m at passTime s into the processed audio (-1 = middle). Pitch rises before and falls after the pass; volumeChange 1 also fades with distance (1/r).', keepsLength: true, params: { speed: { type: 'number', minimum: 1, maximum: 300, default: 25 }, distance: { type: 'number', minimum: 0.5, maximum: 1000, default: 10 }, passTime: { type: 'number', minimum: -1, maximum: 86400, default: -1, description: 'Seconds into the processed audio; -1 = middle' }, volumeChange: { type: 'integer', minimum: 0, maximum: 1, default: 1 } } },
  pitchBend: { description: 'Pitch Bender (tape-style varispeed): pitch and speed change together, from startSemitones to endSemitones across the file; curve 0 linear, 1 ease-in, 2 ease-out. Changes length (higher = shorter).', keepsLength: false, params: { startSemitones: { type: 'number', minimum: -24, maximum: 24, default: 0 }, endSemitones: { type: 'number', minimum: -24, maximum: 24, default: -12 }, curve: { type: 'integer', minimum: 0, maximum: 2, default: 0 } } },
  trim: { description: 'Keep only [start, end] seconds of the asset. Changes length.', keepsLength: false, params: { start: { type: 'number', minimum: 0, default: 0 }, end: { type: 'number', minimum: 0, default: 0 } } },
};

function filterFor(kind, p, sr) {
  switch (kind) {
    case 'denoise': return `afftdn=nr=${(6 + p.strength * 40).toFixed(1)}:nf=${p.noiseFloorDb}:tn=1`;
    case 'dehum': return Array.from({ length: p.harmonics }, (_, i) => `bandreject=f=${p.frequency * (i + 1)}:width_type=q:w=${20 + i * 5}`).join(',');
    case 'declick': return 'adeclick';
    case 'voiceDenoise': return `aresample=48000,arnndn=m=${RNN_MODEL.replace(/[:\\]/g, '\\$&')}:mix=${p.mix},aresample=${sr}`;
    case 'deess': return `deesser=i=${p.intensity}:m=0.5:f=0.5`;
    case 'gate': return `agate=threshold=${Math.pow(10, p.thresholdDb / 20).toFixed(6)}:attack=${p.attackMs}:release=${p.releaseMs}:range=0.001`;
    case 'level': return `speechnorm=e=${p.expansion}:r=0.0001:l=1`;
    case 'mono': return 'pan=mono|c0=0.5*c0+0.5*c1';
    case 'reverse': return 'areverse';
    case 'removeSilence': return `silenceremove=stop_periods=-1:stop_duration=${p.minSilence}:stop_threshold=${p.thresholdDb}dB:stop_silence=${p.keep}:detection=rms`;
    case 'tempo': return `rubberband=tempo=${p.factor}:pitchq=quality:transients=smooth`;
    case 'pitch': return `rubberband=pitch=${Math.pow(2, p.semitones / 12).toFixed(6)}:pitchq=quality:formant=preserved`;
    case 'declip': return `adeclip=t=${Math.max(1, Math.min(100, p.threshold))}`;
    case 'trim': return `atrim=start=${p.start}:end=${p.end},asetpts=PTS-STARTPTS`;
    default: return null;
  }
}

// ctx.offset: where src starts in the asset (source seconds) when src is an excerpt.
export async function processFile(kind, params, src, dest, sampleRate, ctx = {}) {
  const def = PROCESSES[kind];
  const p = {};
  for (const [k, spec] of Object.entries(def.params)) p[k] = params?.[k] ?? spec.default;
  const out = ['-ar', String(sampleRate), '-c:a', 'pcm_f32le', '-bitexact', dest];
  if (kind === 'pitchCorrect') {
    const py = existsSync(VENV_PY) ? VENV_PY : 'python3';
    await run(py, [PITCH_SCRIPT, src, dest, String(p.key), String(p.scale), String(p.strength), String(p.speed), String(p.maxCorrection)], { timeoutMs: 30 * 60_000 });
  } else if (Object.hasOwn(FX_ARGS, kind)) {
    // Audition-style effects in Python (numpy/scipy). Only finite numbers reach the command line.
    const py = existsSync(VENV_PY) ? VENV_PY : 'python3';
    const nums = [...FX_ARGS[kind].map((k) => Number(p[k])), ...(kind === 'soundRemove' ? [Number(ctx.offset) || 0] : [])];
    if (!nums.every(Number.isFinite)) throw Object.assign(new Error(`${kind}: parameters must be numbers`), { status: 400, code: 'invalid_args' });
    let res;
    try { res = await run(py, [FX_SCRIPT, kind, src, dest, ...nums.map(String)], { timeoutMs: 60 * 60_000 }); }
    catch (err) {
      const m = /KLANG_ERROR (\d{3}) ([^|]*)/.exec(err.message);
      if (m) throw Object.assign(new Error(m[2].trim()), { status: +m[1], code: +m[1] === 400 ? 'invalid_args' : 'unprocessable' });
      throw err;
    }
    try { const report = JSON.parse(res.stdout.toString().trim().split('\n').pop() || '{}'); if (Object.keys(report).length) p.measured = report; } catch {}
  } else if (kind === 'normalize') {
    const audio = await readWav(src);
    const { samplePeakDbfs } = levels({ ...audio, offset: 0 });
    const g = Math.pow(10, (p.peakDb - samplePeakDbfs) / 20);
    for (const ch of audio.channels) for (let i = 0; i < ch.length; i++) ch[i] *= g;
    await writeWav(dest, audio.channels, audio.sampleRate);
  } else if (kind === 'loudness') {
    const target = `I=${p.lufs}:TP=${p.truePeak}:LRA=11`;
    const { stderr } = await ffmpeg(['-i', src, '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-']);
    const m = JSON.parse(stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1));
    if (m.input_i === '-inf') throw Object.assign(new Error('Asset is silent; nothing to normalize'), { status: 422, code: 'silent' });
    await ffmpeg(['-i', src, '-af', `loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`, ...out]);
  } else {
    if (kind === 'trim' && !(p.end > p.start)) throw Object.assign(new Error('trim needs end > start'), { status: 400, code: 'invalid_args' });
    await ffmpeg(['-i', src, '-af', filterFor(kind, p, sampleRate), ...out]);
  }
  return p;
}

// ── offline render of the project through the shared graph ───────────────
// How long effects need to settle (reverb tails, echo feedback, compressor
// envelopes) — the pre-roll each parallel segment renders and then discards.
export function prerollFor(project) {
  let s = 0.5;
  const fxs = [...(project.master?.effects || []), ...project.tracks.flatMap((t) => t.effects || [])].filter((e) => e.enabled !== false);
  for (const e of fxs) {
    const p = { ...effectDefaults(e.type), ...(e.params || {}) };
    if (e.type === 'reverb') s = Math.max(s, p.decay + p.preDelay / 1000 + 0.25);
    else if (e.type === 'delay') s = Math.max(s, (p.time / 1000) * (Math.log(0.0003) / Math.log(Math.max(p.feedback, 0.01)) + 1));
    else if (e.type === 'flanger') s = Math.max(s, ((p.delay + p.depth) / 1000) * (Math.log(0.0003) / Math.log(Math.max(p.feedback, 0.01)) + 1));
    else if (e.type === 'pingpong') s = Math.max(s, (p.time / 1000) * (Math.log(0.0003) / Math.log(Math.max(p.feedback, 0.01)) + 1));
    else if (['compressor', 'limiter', 'gate', 'multiband', 'expander'].includes(e.type)) s = Math.max(s, (p.release / 1000) * 7 + ((p.hold || 0) / 1000) + 0.05);
    else if (e.type === 'transient') s = Math.max(s, 2.5);
    else if (e.type === 'convolution') s = Math.max(s, 8);
    else if (e.type === 'vocalenhancer') s = Math.max(s, 1.1);
    else if (e.type === 'pitchshift' && Math.abs(p.semitones) > 0.01) s = Math.max(s, Math.min(20, 0.2 + (2 * p.window / 1000) / Math.abs(1 - Math.pow(2, p.semitones / 12))));
  }
  return Math.min(s, 20);
}

const THREADS = Number(process.env.KLANG_RENDER_THREADS) || Math.max(1, Math.min(8, os.cpus().length - 1));
let pool = null;
function renderPool() {
  if (pool) return pool;
  pool = { procs: [], idle: [], queue: [], pending: new Map(), seq: 0 };
  // Busy render processes keep the parent alive; idle ones don't (tests, CLI scripts can exit).
  const hold = (w, on) => { try { if (on) { w.ref(); w.channel?.ref(); } else { w.unref(); w.channel?.unref(); } } catch {} };
  const send = (w, job) => { job.proc = w; hold(w, true); pool.pending.set(job.msg.id, job); w.send(job.msg); };
  const spawnProc = () => {
    const w = fork(fileURLToPath(new URL('./render-worker.js', import.meta.url)), [], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    w.on('message', (m) => {
      const job = pool.pending.get(m.id);
      pool.pending.delete(m.id);
      if (!job) return;
      if (m.error) job.reject(Object.assign(new Error(m.error), { status: 422, code: 'render_failed' }));
      else job.resolve(m.channels);
      const next = pool.queue.shift();
      if (next) send(w, next); else { pool.idle.push(w); hold(w, false); }
    });
    w.on('exit', (code, signal) => {
      pool.procs = pool.procs.filter((x) => x !== w);
      pool.idle = pool.idle.filter((x) => x !== w);
      for (const [id, job] of pool.pending) if (job.proc === w) {
        pool.pending.delete(id);
        job.reject(Object.assign(new Error(`Render process stopped (${signal || code}); please try again`), { status: 500, code: 'render_crashed' }));
      }
      // Keep queued work moving on a fresh process.
      if (pool.queue.length) send(spawnProc(), pool.queue.shift());
    });
    pool.procs.push(w);
    return w;
  };
  pool.run = (msg) => new Promise((resolve, reject) => {
    const job = { msg: { ...msg, id: ++pool.seq }, resolve, reject };
    const w = pool.idle.pop() || (pool.procs.length < THREADS ? spawnProc() : null);
    if (w) send(w, job); else pool.queue.push(job);
  });
  return pool;
}

export async function renderMix(project, assetPath, { start = 0, end, tail = 0, threads = THREADS } = {}) {
  const sr = project.sampleRate;
  const contentEnd = end ?? projectEnd(project);
  const to = contentEnd + tail; // the tail only lets effects ring out; no further clips start in it
  const totalF = Math.round((to - start) * sr);
  if (totalF <= 0) throw Object.assign(new Error('Nothing to render: the timeline is empty in that range'), { status: 422, code: 'empty' });
  if (to - start > 4 * 3600) throw Object.assign(new Error('Render range longer than 4 hours'), { status: 422, code: 'too_long' });
  const files = {};
  for (const t of project.tracks) for (const c of t.clips) files[c.assetId] = assetPath(c.assetId);
  for (const list of [project.master?.effects || [], ...project.tracks.map((t) => t.effects || [])]) for (const e of list) if (e.type === 'convolution' && e.params?.ir) files[e.params.ir] = assetPath(e.params.ir);
  // Plugins used by this project travel with the job so the render process can load them.
  const plugins = [];
  for (const list of [project.master?.effects || [], ...project.tracks.map((t) => t.effects || [])]) for (const e of list) {
    const def = EFFECTS[e.type];
    if (def?.plugin && !plugins.some((x) => x.manifest.id === def.plugin)) plugins.push({ manifest: { id: def.plugin, label: def.label, description: def.description, params: def.params }, path: pluginPath(def.plugin) });
  }

  // Everything renders in child processes; short renders are one segment.
  if (threads < 2 || to - start < 40) {
    // Start a little earlier so reverb/echo tails and compressor state from before the
    // range are present, exactly like the parallel segments below.
    const preF = start > 0 ? Math.min(Math.round(start * sr), Math.round(prerollFor(project) * sr)) : 0;
    const ch = await renderPool().run({ project, files, from: start - preF / sr, to, contentEnd, keep: preF, plugins });
    return { channels: ch.map((c) => c.subarray(0, totalF)), sampleRate: sr };
  }
  // Parallel: segments with a settling pre-roll, rendered on all cores, stitched sample-exactly.
  const prerollF = Math.round(prerollFor(project) * sr);
  const chunkF = Math.max(Math.round(15 * sr), Math.ceil(totalF / (threads * 2)));
  const out = Array.from({ length: project.channels === 6 ? 6 : 2 }, () => new Float32Array(totalF));
  const jobs = [];
  for (let k0 = 0; k0 < totalF; k0 += chunkF) {
    const k1 = Math.min(totalF, k0 + chunkF), s0 = Math.max(0, k0 - prerollF);
    jobs.push(renderPool().run({ project, files, from: start + s0 / sr, to: start + k1 / sr, contentEnd, keep: k0 - s0, plugins }).then((ch) => {
      out.forEach((o, c) => o.set(ch[c].subarray(0, k1 - k0), k0));
    }));
  }
  await Promise.all(jobs);
  return { channels: out, sampleRate: sr };
}

export const FORMATS = {
  wav: { ext: 'wav', mime: 'audio/wav', args: (o) => ['-c:a', o.bitDepth === 16 ? 'pcm_s16le' : o.bitDepth === 32 ? 'pcm_f32le' : 'pcm_s24le'] },
  flac: { ext: 'flac', mime: 'audio/flac', args: (o) => ['-c:a', 'flac', '-sample_fmt', o.bitDepth === 16 ? 's16' : 's32', ...(o.bitDepth === 16 ? [] : ['-bits_per_raw_sample', '24'])] },
  mp3: { ext: 'mp3', mime: 'audio/mpeg', args: (o) => ['-c:a', 'libmp3lame', '-b:a', `${o.bitrate || 320}k`] },
  opus: { ext: 'opus', mime: 'audio/ogg', args: (o) => ['-c:a', 'libopus', '-b:a', `${o.bitrate || 160}k`] },
  aac: { ext: 'm4a', mime: 'audio/mp4', args: (o) => ['-c:a', 'aac', '-b:a', `${o.bitrate || 256}k`] },
};

// Title tag plus one chapter per labelled marker (podcast apps show these).
export function ffmetadata({ title, markers = [], start = 0, end, tags = {} }) {
  const esc = (v) => String(v).replace(/[=;#\\\n]/g, (c) => '\\' + c);
  const lines = [';FFMETADATA1', `title=${esc(tags.title || title)}`];
  for (const [k, v] of Object.entries(tags)) if (k !== 'title' && /^[a-z_]+$/.test(k) && v) lines.push(`${k}=${esc(v)}`);
  const ms = markers.filter((m) => m.label && m.time >= start && m.time < end).sort((a, b) => a.time - b.time);
  ms.forEach((m, i) => {
    const s = Math.round((m.time - start) * 1000);
    const e = Math.round(((m.duration ? m.time + m.duration : ms[i + 1]?.time ?? end) - start) * 1000);
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${s}`, `END=${Math.max(s + 1, e)}`, `title=${esc(m.label)}`);
  });
  return { text: lines.join('\n') + '\n', chapters: ms.length };
}

// Integer PCM with an ideal quantiser: round to nearest (24-bit) or TPDF dither + round
// (16-bit). ffmpeg's own float→int conversion truncates, which costs 6 dB of headroom.
export async function writePcmWav(file, channels, sampleRate, bits) {
  const nch = channels.length, frames = channels[0].length, bps = bits / 8;
  const data = Buffer.alloc(frames * nch * bps);
  const full = 2 ** (bits - 1), max = full - 1;
  let seed = 0x9e3779b9;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  for (let i = 0, o = 0; i < frames; i++) for (let c = 0; c < nch; c++, o += bps) {
    let v = channels[c][i] * full;
    if (bits === 16) v += rnd() - rnd(); // TPDF, ±1 LSB
    let q = Math.round(v);
    q = q > max ? max : q < -full ? -full : q;
    if (bits === 24) data.writeIntLE(q, o, 3); else data.writeInt16LE(q, o);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(nch, 22); h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * nch * bps, 28); h.writeUInt16LE(nch * bps, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  await fs.writeFile(file, Buffer.concat([h, data]));
}

export async function encode(srcWav, dest, format, opts = {}) {
  const f = FORMATS[format];
  // Lossless integer exports: float processing in ffmpeg (loudness, rate), then our quantiser.
  if ((format === 'wav' || format === 'flac') && (opts.bitDepth === 16 || opts.bitDepth === 24 || (format === 'wav' && opts.bitDepth !== 32) || (format === 'flac' && opts.bitDepth !== 16))) {
    const bits = opts.bitDepth === 16 ? 16 : 24;
    const stage = `${dest}.stage.wav`, pcm = `${dest}.pcm.wav`;
    try {
      await encode(srcWav, stage, 'wav', { ...opts, bitDepth: 32, metadataFile: undefined, _float: true });
      const a = await readWav(stage);
      await writePcmWav(pcm, a.channels, a.sampleRate, bits);
      const six = a.channels.length === 6 ? ['-channel_layout', '5.1'] : [];
      const meta = opts.metadataFile ? ['-i', opts.metadataFile, '-map', '0:a', '-map_metadata', '1', '-map_chapters', '1'] : [];
      const codec = format === 'wav' ? ['-c:a', 'copy'] : ['-c:a', 'flac', '-compression_level', '8'];
      await ffmpeg(['-i', pcm, ...meta, ...six, ...codec, dest]);
    } finally { await fs.rm(stage, { force: true }); await fs.rm(pcm, { force: true }); }
    return;
  }
  const af = [];
  if (opts.loudness) {
    const target = `I=${opts.loudness.lufs ?? -16}:TP=${opts.loudness.truePeak ?? -1}:LRA=11`;
    const { stderr } = await ffmpeg(['-i', srcWav, '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-']);
    const m = JSON.parse(stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1));
    if (m.input_i !== '-inf') af.push('-af', `loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`);
  }
  const srArgs = format === 'opus' ? ['-ar', '48000'] : opts.sampleRate ? ['-ar', String(opts.sampleRate)] : [];
  // Six channels: tag the layout (loudness, players and AAC need it); MP3 folds down to stereo.
  const six = await probe(srcWav).then((i) => i.channels === 6).catch(() => false);
  const layout = six ? (format === 'mp3' ? ['-ac', '2'] : ['-channel_layout', '5.1']) : [];
  const meta = opts.metadataFile ? ['-i', opts.metadataFile, '-map', '0:a', '-map_metadata', '1', '-map_chapters', '1', ...(format === 'mp3' ? ['-id3v2_version', '3'] : [])] : [];
  await ffmpeg(['-i', srcWav, ...meta, ...af, ...srArgs, ...layout, ...f.args(opts), dest]);
}
