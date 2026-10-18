// Delivery checks: measure the mix against a publishing spec and say exactly what to fix.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderMix, writeWav, readWav, loudness, levels, envelope } from '../audio.js';
import { newId } from '../ops.js';
import { projectEnd } from '../../public/js/engine/graph.js';

export const STANDARDS = {
  podcast: { label: 'Podcast (Apple, Spotify)', lufs: [-17, -15], truePeakMax: -1, lraMax: 12 },
  'podcast-mono': { label: 'Mono podcast', lufs: [-20, -18], truePeakMax: -1, lraMax: 12 },
  ebu: { label: 'Broadcast (EBU R128)', lufs: [-23.5, -22.5], truePeakMax: -1, lraMax: 20 },
  atsc: { label: 'US broadcast (ATSC A/85)', lufs: [-26, -22], truePeakMax: -2 },
  streaming: { label: 'Music streaming (Spotify, YouTube)', lufs: [-15, -13], truePeakMax: -1 },
  acx: { label: 'Audiobook (ACX / Audible)', rms: [-23, -18], samplePeakMax: -3, noiseFloorMax: -60 },
};

const fmt = (v, u) => (v === null || v === undefined ? 'n/a' : `${v.toFixed(1)} ${u}`);

export function evaluate(std, m) {
  const s = STANDARDS[std];
  const checks = [];
  const add = (name, value, ok, target, fix) => checks.push({ name, value, pass: !!ok, target, ...(ok ? {} : { fix }) });
  if (s.lufs) {
    const [lo, hi] = s.lufs, v = m.integratedLufs;
    add('Integrated loudness', fmt(v, 'LUFS'), v !== null && v >= lo && v <= hi, `${lo} to ${hi} LUFS`,
      v === null ? 'The mix is silent.' : `Export with loudness normalisation to ${((lo + hi) / 2).toFixed(0)} LUFS (render {loudness:{lufs:${((lo + hi) / 2).toFixed(0)}, truePeak:${s.truePeakMax}}}).`);
  }
  if (s.truePeakMax !== undefined) {
    add('True peak', fmt(m.truePeakDbtp, 'dBTP'), m.truePeakDbtp !== null && m.truePeakDbtp <= s.truePeakMax, `≤ ${s.truePeakMax} dBTP`,
      `Add a limiter last on the master with ceiling ${(s.truePeakMax - 0.5).toFixed(1)} dB (preset master-podcast), or export with truePeak ${s.truePeakMax}.`);
  }
  if (s.lraMax !== undefined && m.loudnessRangeLu !== null) {
    add('Loudness range', fmt(m.loudnessRangeLu, 'LU'), m.loudnessRangeLu <= s.lraMax, `≤ ${s.lraMax} LU`,
      'Even out loud and quiet passages: compressor on the voice tracks, or the "level" process (speech leveler).');
  }
  if (s.rms) {
    const [lo, hi] = s.rms, v = m.rmsDbfs;
    add('RMS level', fmt(v, 'dBFS'), v >= lo && v <= hi, `${lo} to ${hi} dBFS`,
      v < lo ? `Raise the level by about ${(lo + 2 - v).toFixed(1)} dB (master gain or a compressor with makeup), keeping peaks under ${s.samplePeakMax} dB with a limiter.` : `Lower the level by about ${(v - hi + 1).toFixed(1)} dB.`);
  }
  if (s.samplePeakMax !== undefined) {
    add('Peak level', fmt(m.samplePeakDbfs, 'dBFS'), m.samplePeakDbfs <= s.samplePeakMax, `≤ ${s.samplePeakMax} dBFS`,
      `Limiter last on the master with ceiling ${s.samplePeakMax - 0.5} dB.`);
  }
  if (s.noiseFloorMax !== undefined) {
    add('Noise floor', fmt(m.noiseFloorDbfs, 'dBFS'), m.noiseFloorDbfs !== null && m.noiseFloorDbfs <= s.noiseFloorMax, `≤ ${s.noiseFloorMax} dBFS`,
      'Reduce background noise: noise_reduction with a room-tone range, the voiceDenoise process, or a gate between phrases.');
  }
  add('No clipping', `${m.clippedSamples} clipped samples`, m.clippedSamples === 0, '0', 'Lower the gain before the clipping point or add a limiter.');
  return { standard: std, label: s.label, pass: checks.every((c) => c.pass), checks };
}

export async function register({ api, json, wrap, store, mcpTools, OpError }) {
  async function measure(pid, { start, end } = {}) {
    const p = store.get(pid);
    const s = start ?? 0, e = end ?? projectEnd(p);
    if (!(e > s)) throw new OpError('The timeline is empty', 'empty', 422);
    const mix = await renderMix(p, (aid) => store.assetPath(pid, aid), { start: s, end: e });
    const file = path.join(os.tmpdir(), `klang-${newId('chk')}.wav`);
    try {
      await writeWav(file, mix.channels, mix.sampleRate);
      const L = await loudness(file);
      const audio = { ...(await readWav(file)), offset: 0 };
      const lv = levels(audio);
      // Noise floor: the quietest half-second window that is not digital silence.
      const env = envelope(audio, 0.5).rmsDbfs.filter((v) => v > -120);
      const noiseFloorDbfs = env.length ? Math.min(...env) : null;
      return { ...L, ...lv, noiseFloorDbfs, duration: +(e - s).toFixed(3) };
    } finally { await fs.rm(file, { force: true }); }
  }

  async function check(pid, body = {}) {
    const stds = body.standard ? [body.standard] : Object.keys(STANDARDS);
    for (const st of stds) if (!STANDARDS[st]) throw new OpError(`Unknown standard "${st}". Known: ${Object.keys(STANDARDS).join(', ')}`, 'invalid_args', 400);
    const m = await measure(pid, body);
    return { measurements: m, results: stds.map((st) => evaluate(st, m)) };
  }

  api.get('/standards', (req, res) => res.json(STANDARDS));
  api.post('/projects/:id/check', json, wrap(async (req, res) => res.json(await check(req.params.id, req.body || {}))));

  mcpTools.push({
    name: 'check_delivery',
    description: `Check the mix against a delivery spec and get pass/fail per criterion with a concrete fix for each failure. Standards: ${Object.entries(STANDARDS).map(([k, v]) => `${k} (${v.label})`).join(', ')}. Omit standard to check all. Run this before exporting.`,
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, standard: { type: 'string', enum: Object.keys(STANDARDS) }, start: { type: 'number' }, end: { type: 'number' } }, required: ['projectId'] },
    handler: ({ projectId, ...b }) => check(projectId, b),
  });
}
