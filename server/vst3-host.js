// Native VST3 hosting (Linux builds) through pedalboard/JUCE in the Python venv. Entries
// take the same shape as LV2 catalog entries (format: 'vst3'), so the plugin browser,
// REST and MCP tools serve both. Every plugin is scanned in its own process — some crash
// on load — and the catalog is cached until the installed bundles change.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as audio from './audio.js';

const VERSION = 1;
const HELPER = fileURLToPath(new URL('./vst3.py', import.meta.url));
const VENV_PY = fileURLToPath(new URL('../.venv/bin/python', import.meta.url));
const py = () => (existsSync(VENV_PY) ? VENV_PY : 'python3');

export const vst3Dirs = () => (process.env.VST3_PATH || `${os.homedir()}/.vst3:/usr/local/lib/vst3:/usr/lib/vst3`).split(':').filter(Boolean);

const NAME_CATEGORY = [
  [/limit|maxim/i, 'Limiter'], [/\bgate\b|gatex/i, 'Gate'], [/expand/i, 'Expander'], [/compress|\bcomp|multicomp/i, 'Compressor'],
  [/equali[sz]er|\beq|geq|3bandeq/i, 'EQ'], [/filter|crossover|splitter/i, 'Filter'], [/reverb|verb|reflections/i, 'Reverb'], [/delay|echo/i, 'Delay'],
  [/chorus|flanger|phaser|tremolo|vibrato|rotary|pulsator|modul|cycleshifter|pingpong/i, 'Modulation'],
  [/distort|saturat|exciter|enhancer|crush|tape|tube|clipper|overdrive|autosat|soulforce|phono/i, 'Distortion'],
  [/stereo|width|haas|balance|phase|head/i, 'Spatial'], [/pitch/i, 'Pitch'], [/dynamic|autogain|deesser|imposer/i, 'Dynamics'],
];
// Same exclusions as LV2: meters, analysers, synths, file-based loaders, visualisers.
const SKIP_NAMES = /meter|analy[sz]|scope|tuner|tester|trigger|sampler|oscillator|generator|profiler|detector|test ?signal|midi|impulse|convol|room builder|synth|organ|wavetable|vinyl|mixer x|latency|glbars|grains|kars|nekobi/i;
const GUI_PARAM = /visibility|graph|peak ?hold|reset peak|^(pause|clear|freeze)\b|zoom|display|analy[sz]|meter|bypass|gain reduction|output level$/i;

function brandOf(file, name) {
  const b = path.basename(file, '.vst3');
  if (/^lsp/i.test(b)) return 'LSP';
  if (/^za/i.test(b)) return 'ZAM';
  if (/^dragonfly/i.test(b)) return 'Dragonfly';
  if (/^Ma[A-Z]/.test(b)) return 'MDA';
  return /^(3Band|Amplitude|CycleShifter|PingPong|SoulForce|MVerb|ProM|Kars|Nekobi|glBars)/.test(b) ? 'DISTRHO' : name.split(' ')[0];
}

function toEntry(file, raw) {
  const params = [];
  for (const p of raw.params) {
    if (GUI_PARAM.test(p.name || '') || GUI_PARAM.test(p.symbol)) continue;
    const base = { symbol: p.symbol, name: p.name || p.symbol };
    if (p.unit) base.unit = p.unit;
    if (p.enum) {
      // The browser and the API speak numbers: enumerations become indices.
      const def = Math.max(0, p.enum.indexOf(p.default));
      params.push({ ...base, min: 0, max: p.enum.length - 1, default: def, integer: true, enum: p.enum.map((label, value) => ({ value, label })), vstEnum: p.enum });
    } else if (p.toggle) params.push({ ...base, min: 0, max: 1, default: p.default, toggle: true });
    else if (p.min <= -1e8 || p.max >= 1e8) {
      // Unbounded ranges (gain from −∞ dB) get a usable floor; anything else stays default.
      if (p.unit === 'dB' && p.max < 1e8) params.push({ ...base, min: -96, max: p.max, default: Math.max(-96, Math.min(p.max, p.default)) });
    } else if (p.max > p.min) params.push({ ...base, min: p.min, max: p.max, default: Math.min(p.max, Math.max(p.min, p.default)), ...(p.unit === 'Hz' && p.min > 0 && p.max / p.min >= 20 ? { log: true } : {}) });
  }
  const brand = brandOf(file, raw.name);
  return {
    format: 'vst3', uri: `vst3:${file}#${raw.name}`, file, vstName: raw.name,
    name: raw.name, brand, author: brand, category: NAME_CATEGORY.find(([re]) => re.test(`${raw.name} ${path.basename(file)}`))?.[1] || 'Utility',
    lv2Classes: [], channels: { in: raw.channels, out: raw.channels }, latency: false, params,
  };
}

const concurrently = async (items, n, fn) => {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
};

async function bundles() {
  const out = [];
  for (const d of vst3Dirs()) for (const e of await fs.readdir(d).catch(() => [])) {
    if (!e.endsWith('.vst3')) continue;
    const st = await fs.stat(path.join(d, e)).catch(() => null);
    if (st) out.push({ file: path.join(d, e), sig: `${d}/${e}:${Math.round(st.mtimeMs)}` });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

export async function buildVst3Catalog(cacheFile, log = () => {}) {
  const t0 = Date.now();
  const list = await bundles();
  const signature = createHash('sha1').update(JSON.stringify({ v: VERSION, b: list.map((x) => x.sig) })).digest('hex');
  try { const c = JSON.parse(await fs.readFile(cacheFile, 'utf8')); if (c.signature === signature) return c; } catch {}
  const skipped = {};
  const jobs = [];
  for (const { file } of list) {
    let names = [];
    try { names = JSON.parse((await audio.run(py(), [HELPER, 'names', file], { timeoutMs: 60000 })).stdout.toString()); } catch { skipped[`vst3:${file}`] = 'failed to load'; continue; }
    for (const n of names) {
      if (SKIP_NAMES.test(n) || SKIP_NAMES.test(path.basename(file))) { skipped[`vst3:${file}#${n}`] = 'not an effect'; continue; }
      jobs.push({ file, name: n });
    }
  }
  const results = await concurrently(jobs, Math.max(2, Math.min(8, os.cpus().length - 1)), async ({ file, name }) => {
    try { return toEntry(file, JSON.parse((await audio.run(py(), [HELPER, 'scan', file, name], { timeoutMs: 60000 })).stdout.toString())); }
    catch (err) { skipped[`vst3:${file}#${name}`] = /not an effect|silent|non-finite/.exec(err.message)?.[0] || 'failed or crashed in the test run'; return null; }
  });
  const plugins = results.filter(Boolean);
  const catalog = { version: VERSION, signature, plugins, skipped, installed: jobs.length };
  await fs.writeFile(cacheFile, JSON.stringify(catalog)).catch(() => {});
  log(`VST3: ${plugins.length} of ${jobs.length} installed plugins usable as effects (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  return catalog;
}

/** Run a VST3 entry over src (float WAV) into dest. controls are validated numbers. */
export async function runVst3(entry, controls, src, dest, timeoutMs) {
  const values = {};
  for (const [sym, v] of Object.entries(controls)) {
    const p = entry.params.find((x) => x.symbol === sym);
    values[sym] = p.vstEnum ? p.vstEnum[v] : p.toggle ? !!v : v;
  }
  const pf = path.join(os.tmpdir(), `klang-vst3-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await fs.writeFile(pf, JSON.stringify(values));
  try { await audio.run(py(), [HELPER, 'run', entry.file, entry.vstName, pf, src, dest], { timeoutMs }); }
  finally { await fs.rm(pf, { force: true }); }
}
