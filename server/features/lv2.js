// Native LV2 plugin hosting. Browsers cannot load native plugins, so LV2 effects run on
// the server through ffmpeg's lv2 filter: as destructive (optionally ranged) processes on
// an asset, with a short audible preview. The catalog of usable effects is built once at
// startup from lv2ls/lv2info (plus each plugin's Turtle file for classes and units), every
// candidate is test-run through ffmpeg, and the result is cached in <data>/lv2-catalog.json
// until the installed plugin set changes.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { newId } from '../ops.js';
import { validate } from '../validate.js';
import * as audio from '../audio.js';
import { buildVst3Catalog, runVst3 } from '../vst3-host.js';

const CATALOG_VERSION = 3;
const tmpFile = (ext = '') => path.join(os.tmpdir(), `klang-${newId('lv2')}${ext}`);
const LV2 = 'http://lv2plug.in/ns/lv2core#';
const SYMBOL = /^[A-Za-z0-9_]{1,127}$/; // what ffmpeg's lv2 "controls" parser accepts
const SAFE_URI = /^[A-Za-z0-9:/._#~+-]{1,300}$/;

// ── lv2info parsing ──────────────────────────────────────────────────────
export function parseLv2info(text) {
  const out = { ports: [], requiredFeatures: [], dataUris: [] };
  let key = null, port = null, inScale = false;
  for (const raw of text.split('\n')) {
    let m;
    if ((m = raw.match(/^\tPort (\d+):/))) { port = { index: +m[1], types: [], properties: [], scalePoints: [] }; out.ports.push(port); key = null; inScale = false; continue; }
    if (!port) {
      if ((m = raw.match(/^\t([A-Za-z][A-Za-z ]*):(?:\s+(.*))?$/))) {
        key = m[1].trim(); const v = (m[2] || '').trim();
        if (key === 'Name') out.name = v;
        else if (key === 'Class') out.class = v;
        else if (key === 'Author') out.author = v;
        else if (key === 'Has latency') out.latency = v.startsWith('yes');
        else if (key === 'Required Features' && v) out.requiredFeatures.push(v);
        else if (key === 'Data URIs' && v) out.dataUris.push(v);
      } else if ((m = raw.match(/^\t\s+(\S.*)$/)) && !raw.startsWith('\t\t')) {
        if (key === 'Required Features') out.requiredFeatures.push(m[1].trim());
        else if (key === 'Data URIs') out.dataUris.push(m[1].trim());
      } else if ((m = raw.match(/^\t {10,}(\S.*)$/))) {
        if (key === 'Required Features') out.requiredFeatures.push(m[1].trim());
        else if (key === 'Data URIs') out.dataUris.push(m[1].trim());
      }
      continue;
    }
    if ((m = raw.match(/^\t\t\t(-?[\d.eE+-]+) = "(.*)"\s*$/)) && inScale) { port.scalePoints.push({ value: +m[1], label: m[2] }); continue; }
    if ((m = raw.match(/^\t\t([A-Za-z][A-Za-z ]*):(?:\s+(.*))?$/))) {
      key = m[1].trim(); const v = (m[2] || '').trim(); inScale = key === 'Scale Points';
      if (key === 'Type') port.types.push(v);
      else if (key === 'Properties') port.properties.push(v);
      else if (key === 'Symbol') port.symbol = v;
      else if (key === 'Name') port.name = v;
      else if (key === 'Designation') port.designation = v;
      else if (key === 'Minimum') port.min = parseFloat(v);
      else if (key === 'Maximum') port.max = parseFloat(v);
      else if (key === 'Default') port.default = parseFloat(v);
      continue;
    }
    if ((m = raw.match(/^\t\t\s+(\S.*)$/)) && !inScale) {
      if (key === 'Type') port.types.push(m[1].trim());
      else if (key === 'Properties') port.properties.push(m[1].trim());
    }
  }
  return out;
}

// ── Turtle: the plugin's own statement (classes) and per-port units ──────
function statementFor(ttl, uri) {
  const prefixes = {};
  for (const m of ttl.matchAll(/@prefix\s+([A-Za-z0-9_-]*):\s*<([^>]*)>\s*\./g)) prefixes[m[1]] = m[2];
  const forms = [`<${uri}>`];
  for (const [p, ns] of Object.entries(prefixes)) if (uri.startsWith(ns) && /^[A-Za-z0-9_.-]*$/.test(uri.slice(ns.length))) forms.push(`${p}:${uri.slice(ns.length)}`);
  for (const f of forms) {
    const re = new RegExp(`(^|\\n)\\s*${f.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s+a\\s`, 'g');
    const m = re.exec(ttl);
    if (!m) continue;
    let i = m.index + m[0].length, depth = 0, str = false;
    for (; i < ttl.length; i++) {
      const c = ttl[i];
      if (str) { if (c === '\\') i++; else if (c === '"') str = false; continue; }
      if (c === '"') str = true;
      else if (c === '#' && depth >= 0 && /\s/.test(ttl[i - 1] || ' ')) { const nl = ttl.indexOf('\n', i); i = nl < 0 ? ttl.length : nl; }
      else if (c === '[' || c === '(') depth++;
      else if (c === ']' || c === ')') depth--;
      else if (c === '.' && depth === 0 && /\s/.test(ttl[i + 1] || ' ')) break;
    }
    return ttl.slice(m.index, i);
  }
  return null;
}
function unitsFromStatement(st) {
  const units = {};
  for (const m of st.matchAll(/lv2:symbol\s+"([^"]+)"/g)) {
    // Walk out to the enclosing [ … ] of this port.
    let s = m.index, d = 0;
    for (; s > 0; s--) { const c = st[s]; if (c === ']') d++; else if (c === '[') { if (d === 0) break; d--; } }
    let e = m.index; d = 0;
    for (; e < st.length; e++) { const c = st[e]; if (c === '[') d++; else if (c === ']') { if (d === 0) break; d--; } }
    const block = st.slice(s, e);
    const u = block.match(/[\w-]*:unit\s+[\w-]*:(\w+)\s*[;\]]/) || block.match(/[\w-]*:unit\s+<[^>]*#(\w+)>/);
    const sym = block.match(/units:symbol\s+"([^"]*)"/);
    const UNIT = { hz: 'Hz', HZ: 'Hz', khz: 'kHz', db: 'dB', ms: 'ms', s: 's', pc: '%', bpm: 'BPM', semitone12TET: 'st', cent: 'cents', coef: '', frame: 'samples', degree: '°', m: 'm', cm: 'cm', mm: 'mm', km: 'km', oct: 'oct', min: 'min' };
    const unit = u ? UNIT[u[1]] ?? u[1] : sym ? sym[1] : undefined;
    if (unit) units[m[1]] = unit;
  }
  return units;
}

// ── classification ───────────────────────────────────────────────────────
const CLASS_CATEGORY = [
  ['LimiterPlugin', 'Limiter'], ['GatePlugin', 'Gate'], ['ExpanderPlugin', 'Expander'], ['CompressorPlugin', 'Compressor'],
  ['ParaEQPlugin', 'EQ'], ['MultiEQPlugin', 'EQ'], ['EQPlugin', 'EQ'],
  ['LowpassPlugin', 'Filter'], ['HighpassPlugin', 'Filter'], ['BandpassPlugin', 'Filter'], ['AllpassPlugin', 'Filter'], ['CombPlugin', 'Filter'], ['FilterPlugin', 'Filter'],
  ['ReverbPlugin', 'Reverb'], ['DelayPlugin', 'Delay'],
  ['FlangerPlugin', 'Modulation'], ['PhaserPlugin', 'Modulation'], ['ChorusPlugin', 'Modulation'], ['ModulatorPlugin', 'Modulation'],
  ['DistortionPlugin', 'Distortion'], ['WaveshaperPlugin', 'Distortion'], ['SimulatorPlugin', 'Distortion'],
  ['SpatialPlugin', 'Spatial'], ['PitchPlugin', 'Pitch'], ['SpectralPlugin', 'Spectral'],
  ['EnvelopePlugin', 'Dynamics'], ['DynamicsPlugin', 'Dynamics'],
  ['AmplifierPlugin', 'Utility'], ['MixerPlugin', 'Utility'], ['ConverterPlugin', 'Utility'], ['UtilityPlugin', 'Utility'], ['FunctionPlugin', 'Utility'],
];
const SKIP_CLASSES = new Set(['AnalyserPlugin', 'InstrumentPlugin', 'MIDIPlugin', 'GeneratorPlugin', 'OscillatorPlugin', 'ConstantPlugin']);
const NAME_CATEGORY = [
  [/limit/i, 'Limiter'], [/\bgate\b/i, 'Gate'], [/expand/i, 'Expander'], [/compress|darc|\bcomp\b/i, 'Compressor'],
  [/equali[sz]er|\beq\b/i, 'EQ'], [/filter|crossover/i, 'Filter'], [/reverb/i, 'Reverb'], [/delay|echo/i, 'Delay'],
  [/chorus|flanger|phaser|tremolo|vibrato|rotary|pulsator|modul/i, 'Modulation'],
  [/distort|saturat|exciter|enhancer|crusher|tape|tube|clipper|overdrive/i, 'Distortion'],
  [/stereo|width|haas|balance|phase/i, 'Spatial'], [/pitch/i, 'Pitch'], [/dynamic|autogain|breather|deesser/i, 'Dynamics'],
];
// Not effects for an editor: meters, analysers, test tools, samplers, IR loaders (need files).
const SKIP_NAMES = /meter|analy[sz]|scope|tuner|tester|trigger|sampler|oscillator|generator|profiler|detector|test ?signal|midi|impulse|convol|room builder|monosynth|organ|fluidsynth|wavetable|vinyl|mixer x|latency/i;
const brandOf = (uri, author) => (uri.includes('lsp-plug.in') ? 'LSP' : uri.includes('gareus.org') ? 'x42' : uri.includes('calf.sourceforge.net') ? 'Calf' : (author || 'Other').split(/[ ,]/)[0]);

function categorize(classes, name) {
  for (const [c, cat] of CLASS_CATEGORY) if (classes.includes(c)) return cat;
  for (const [re, cat] of NAME_CATEGORY) if (re.test(name)) return cat;
  return 'Utility';
}

function toEntry(uri, info, ttlInfo) {
  const has = (p, t) => p.types.some((x) => x.endsWith(t));
  const audioIn = info.ports.filter((p) => has(p, 'AudioPort') && has(p, 'InputPort'));
  const audioOut = info.ports.filter((p) => has(p, 'AudioPort') && has(p, 'OutputPort'));
  const why = (reason) => ({ skip: reason });
  if (!info.name) return why('no name');
  if (info.ports.some((p) => has(p, 'CVPort'))) return why('CV ports');
  if (audioIn.some((p) => /^sc|side ?chain|sidechain/i.test(`${p.symbol} ${p.name}`) || /side ?chain/i.test(p.name || ''))) return why('needs a sidechain input');
  if (audioIn.length < 1 || audioIn.length > 2 || audioOut.length < 1 || audioOut.length > 2) return why(`${audioIn.length} in / ${audioOut.length} out`);
  const classes = ttlInfo.classes || [];
  if (classes.some((c) => SKIP_CLASSES.has(c))) return why(`class ${classes.join(',')}`);
  if (SKIP_NAMES.test(info.name) || SKIP_NAMES.test(uri)) return why('not an effect');
  if (!SAFE_URI.test(uri)) return why('unusual uri');
  const params = [];
  for (const p of info.ports) {
    if (!(has(p, 'ControlPort') && has(p, 'InputPort'))) continue;
    const props = p.properties.map((x) => x.split('#').pop());
    const desig = (p.designation || '').split('#').pop();
    if (['enabled', 'freeWheeling', 'latency', 'sampleRate'].includes(desig) || props.includes('notOnGUI')) continue;
    // Controls for the plugin's own GUI (graphs, meters, zoom) mean nothing offline.
    if (/visibility|graph|peak ?hold|reset peak|^(pause|clear|freeze)\b|zoom|display|analy[sz]|meter/i.test(p.name || '')) continue;
    if (!SYMBOL.test(p.symbol || '') || !Number.isFinite(p.min) || !Number.isFinite(p.max) || !(p.max > p.min)) continue;
    const toggle = props.includes('toggled');
    const integer = toggle || props.includes('integer') || props.includes('enumeration');
    let def = Number.isFinite(p.default) ? p.default : p.min;
    def = Math.min(p.max, Math.max(p.min, def));
    const param = { symbol: p.symbol, name: p.name || p.symbol, min: p.min, max: p.max, default: integer ? Math.round(def) : def };
    const unit = ttlInfo.units?.[p.symbol];
    if (unit) param.unit = unit;
    if (toggle) param.toggle = true;
    else if (integer) param.integer = true;
    if (props.includes('enumeration') && p.scalePoints.length) param.enum = p.scalePoints.map((s) => ({ value: s.value, label: s.label })).sort((a, b) => a.value - b.value);
    else if (p.scalePoints.length && !toggle) param.scalePoints = p.scalePoints.map((s) => ({ value: s.value, label: s.label }));
    if (props.includes('logarithmic') || (unit === 'Hz' && p.min > 0 && p.max / p.min >= 20)) param.log = true;
    params.push(param);
  }
  return {
    uri, name: info.name, brand: brandOf(uri, info.author), author: info.author, category: categorize(classes, info.name),
    lv2Classes: classes, channels: { in: audioIn.length, out: audioOut.length }, latency: !!info.latency, params,
  };
}

// ── ffmpeg plumbing ──────────────────────────────────────────────────────
const fmtNum = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(9).replace(/0+$/, '').replace(/\.$/, ''));
const escUri = (uri) => uri.replace(/:/g, '\\\\:'); // option-level "\:" then graph-level "\\"

function lv2Filter(entry, controls) {
  const parts = Object.entries(controls || {}).map(([k, v]) => `${k}=${fmtNum(v)}`);
  return `lv2=p=${escUri(entry.uri)}${parts.length ? `:c=${parts.join('|')}` : ''}`;
}
// Fit the asset's channel layout to the plugin and back. A mono plugin on stereo audio runs
// twice (dual mono); otherwise up/down-mix around it. The result keeps the asset's layout.
export function filterGraph(entry, controls, assetCh, { padSamples = 0 } = {}) {
  const { in: pin, out: pout } = entry.channels;
  const fx = lv2Filter(entry, controls);
  const pad = padSamples > 0 ? `apad=pad_len=${padSamples},` : '';
  const trim = padSamples > 0 ? `,atrim=start_sample=${padSamples},asetpts=PTS-STARTPTS` : '';
  const toLayout = (ch) => (ch === 2 ? 'pan=stereo|c0=c0|c1=c0' : 'pan=mono|c0=0.5*c0+0.5*c1');
  if (assetCh === 2 && pin === 1 && pout === 1) {
    return `[0:a]${pad}aformat=sample_fmts=fltp,channelsplit=channel_layout=stereo[L][R];[L]${fx}[l];[R]${fx}[r];[l][r]join=inputs=2:channel_layout=stereo${trim}[out]`;
  }
  const chain = [pad ? pad.slice(0, -1) : null, pin === assetCh ? `aformat=channel_layouts=${pin === 2 ? 'stereo' : 'mono'}` : toLayout(pin), fx, pout === assetCh ? null : toLayout(assetCh), trim ? trim.slice(1) : null].filter(Boolean);
  return `[0:a]${chain.join(',')}[out]`;
}

async function ffRun(args, timeoutMs) {
  const t0 = Date.now();
  try { return await audio.run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...args], { timeoutMs }); }
  catch (err) {
    if (Date.now() - t0 >= timeoutMs - 50) throw Object.assign(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`), { timedOut: true });
    throw err;
  }
}

const concurrently = async (items, n, fn) => {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
};

// Test-run a candidate with its defaults on a short tone+noise signal: it must load in
// ffmpeg, not crash, produce finite samples and not fall silent.
async function probeEntry(entry) {
  const ch = entry.channels.in;
  const src = `aevalsrc=exprs=0.25*sin(2*PI*440*t)+0.1*(random(0)-0.5)${ch === 2 ? '|0.25*sin(2*PI*660*t)+0.1*(random(1)-0.5)' : ''}:s=48000:d=0.6`;
  try {
    const { stdout } = await ffRun(['-f', 'lavfi', '-i', src, '-filter_complex', filterGraph(entry, {}, ch), '-map', '[out]', '-f', 'f32le', '-ac', '1', 'pipe:1'], 15000);
    const f = new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + (stdout.length & ~3)));
    if (f.length < 1000) return 'no output';
    let sum = 0;
    for (const v of f) { if (!Number.isFinite(v)) return 'non-finite output'; sum += v * v; }
    if (Math.sqrt(sum / f.length) < 1e-5) return 'silent with default settings';
    return null;
  } catch (err) { return err.timedOut ? 'timed out' : 'failed to run in ffmpeg'; }
}

async function lv2Dirs() {
  const home = os.homedir();
  const list = (process.env.LV2_PATH || `${home}/.lv2:/usr/local/lib/lv2:/usr/lib/lv2:/usr/lib/x86_64-linux-gnu/lv2`).split(':').filter(Boolean);
  const sig = [];
  for (const d of list) {
    const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) { const st = await fs.stat(path.join(d, e.name)).catch(() => null); if (st) sig.push(`${d}/${e.name}:${Math.round(st.mtimeMs)}`); }
  }
  return sig.sort();
}

async function buildCatalog(cacheFile, log = () => {}) {
  const t0 = Date.now();
  const { stdout } = await audio.run('lv2ls', [], { timeoutMs: 30000 });
  const uris = stdout.toString().split('\n').map((s) => s.trim()).filter(Boolean).sort();
  const signature = createHash('sha1').update(JSON.stringify({ v: CATALOG_VERSION, uris, dirs: await lv2Dirs() })).digest('hex');
  try {
    const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    if (cached.signature === signature) return cached;
  } catch {}
  const ttlCache = new Map();
  const readTtl = (u) => { const f = u.replace(/^file:\/\//, ''); if (!ttlCache.has(f)) ttlCache.set(f, fs.readFile(decodeURIComponent(f), 'utf8').catch(() => '')); return ttlCache.get(f); };
  const skipped = {};
  const candidates = (await concurrently(uris, 8, async (uri) => {
    let info;
    try { info = parseLv2info((await audio.run('lv2info', [uri], { timeoutMs: 20000 })).stdout.toString()); } catch { skipped[uri] = 'lv2info failed'; return null; }
    const ttlInfo = { classes: [], units: {} };
    for (const d of info.dataUris.filter((x) => !x.endsWith('/manifest.ttl'))) {
      const st = statementFor(await readTtl(d), uri);
      if (st) {
        const a = st.match(/\sa\s+([^;]+);/);
        if (a) ttlInfo.classes.push(...a[1].split(',').map((s) => s.trim().replace(/^lv2:/, '').replace(/^<.*#(\w+)>$/, '$1')).filter((c) => /Plugin$/.test(c) && c !== 'Plugin'));
        Object.assign(ttlInfo.units, unitsFromStatement(st));
      }
    }
    const e = toEntry(uri, info, ttlInfo);
    if (e.skip) { skipped[uri] = e.skip; return null; }
    return e;
  })).filter(Boolean);
  const problems = await concurrently(candidates, Math.max(2, Math.min(8, os.cpus().length - 1)), probeEntry);
  // A busy machine can make a probe time out: retry those one at a time, and if any still
  // does, do not cache the result so the next start tries again.
  for (const [i, e] of candidates.entries()) if (problems[i] === 'timed out') problems[i] = await probeEntry(e);
  const complete = !problems.includes('timed out');
  const plugins = candidates.filter((e, i) => { if (problems[i]) skipped[e.uri] = problems[i]; return !problems[i]; });
  plugins.sort((a, b) => a.category.localeCompare(b.category) || a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name));
  plugins.forEach((p, i) => { p.index = i; });
  const catalog = { version: CATALOG_VERSION, signature, builtAt: new Date().toISOString(), installed: uris.length, plugins, skipped };
  if (complete) await fs.writeFile(cacheFile, JSON.stringify(catalog)).catch(() => {});
  log(`LV2: ${plugins.length} of ${uris.length} installed plugins usable as effects (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  return catalog;
}

// ── feature ──────────────────────────────────────────────────────────────
const applySchema = {
  type: 'object', additionalProperties: false, required: ['uri'],
  properties: {
    uri: { type: 'string', maxLength: 300, description: 'Plugin URI from list_lv2_plugins' },
    controls: { type: 'object', description: 'Control values by port symbol, numbers only, each within the plugin\'s min/max (toggles 0/1, enums one of the listed values). Unset controls keep their defaults.' },
    start: { type: 'number', minimum: 0, description: 'Only process from here (asset/source seconds). Edges are crossfaded.' },
    end: { type: 'number', minimum: 0, description: 'Only process until here (asset/source seconds)' },
    replaceInClips: { type: 'boolean', description: 'Swap the result into every clip using the asset (default true; one undo step)' },
  },
};

export async function register({ api, json, wrap, store, mcpTools, actorOf, OpError }) {
  const cacheFile = path.join(store.dir, 'lv2-catalog.json');
  let catalog = null, failure = null;
  // VST3 bundles (Linux builds) join the same catalog after the LV2 plugins.
  // The scan takes minutes and depends only on the machine, so its cache is machine-wide.
  const cacheDir = process.env.KLANG_CACHE || path.join(os.homedir(), '.cache', 'klang');
  await fs.mkdir(cacheDir, { recursive: true }).catch(() => {});
  const vst3 = buildVst3Catalog(path.join(cacheDir, 'vst3-catalog.json'), (m) => console.log(m))
    .catch((err) => { console.error(`VST3 catalog unavailable: ${err.message}`); return { plugins: [], skipped: {}, installed: 0 }; });
  const ready = Promise.all([buildCatalog(cacheFile, (m) => console.log(m)), vst3])
    .then(([c, v]) => {
      const plugins = [...c.plugins, ...v.plugins].map((p, index) => ({ ...p, format: p.format || 'lv2', index }));
      catalog = { ...c, installed: c.installed + v.installed, plugins, skipped: { ...c.skipped, ...v.skipped }, formats: { lv2: c.plugins.length, vst3: v.plugins.length } };
      return catalog;
    })
    .catch((err) => { failure = err; console.error(`LV2 catalog unavailable: ${err.message}`); return { plugins: [], skipped: {}, installed: 0 }; });
  const getCatalog = async () => { const c = catalog || await ready; return c; };

  async function findPlugin(ref) {
    const c = await getCatalog();
    if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
      const p = c.plugins[+ref];
      if (!p) throw new OpError(`No LV2 plugin at index ${ref} (catalog has ${c.plugins.length})`, 'not_found', 404);
      return p;
    }
    const p = c.plugins.find((x) => x.uri === ref);
    if (!p) {
      const why = c.skipped?.[ref];
      throw new OpError(why ? `LV2 plugin ${ref} is installed but not usable here: ${why}` : `Unknown LV2 plugin ${ref}${failure ? ' (LV2 catalog unavailable on this server)' : ''}. Use list_lv2_plugins / GET /api/lv2.`, 'invalid_args', 400);
    }
    return p;
  }

  // Strict numeric validation: these values end up in an ffmpeg filter string.
  function checkControls(plugin, controls = {}) {
    if (!controls || typeof controls !== 'object' || Array.isArray(controls)) throw new OpError('controls must be an object of { symbol: number }', 'invalid_args', 400);
    const out = {};
    for (const [sym, raw] of Object.entries(controls)) {
      const p = plugin.params.find((x) => x.symbol === sym);
      if (!p) throw new OpError(`Unknown control "${sym}" for ${plugin.name}. Controls: ${plugin.params.map((x) => x.symbol).join(', ')}`, 'invalid_args', 400);
      const v = typeof raw === 'boolean' && p.toggle ? +raw : raw;
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new OpError(`controls.${sym} must be a finite number`, 'invalid_args', 400);
      if (v < p.min || v > p.max) throw new OpError(`controls.${sym} must be between ${p.min} and ${p.max}${p.unit ? ` ${p.unit}` : ''}`, 'invalid_args', 400);
      if ((p.integer || p.toggle) && !Number.isInteger(v)) throw new OpError(`controls.${sym} must be an integer`, 'invalid_args', 400);
      if (p.enum && !p.enum.some((e) => e.value === v)) throw new OpError(`controls.${sym} must be one of ${p.enum.map((e) => `${e.value} (${e.label})`).join(', ')}`, 'invalid_args', 400);
      out[sym] = v;
    }
    return out;
  }

  const failed = (plugin, err) => new OpError(`${plugin.format === 'vst3' ? 'VST3' : 'LV2'} plugin “${plugin.name}” ${err.timedOut ? err.message : `failed: ${String(err.message || err).replace(/^\S+ failed \(\w+\): ?/, '') || 'crashed'}`}`, 'plugin_failed', 422);

  // Plugins that report latency (look-ahead limiters, linear-phase EQs) delay the signal;
  // measure it with an impulse through the same settings and compensate.
  async function latencyOf(plugin, controls, sr) {
    if (!plugin.latency || plugin.format === 'vst3') return 0; // the VST3 host compensates itself
    const at = Math.round(sr * 0.1), ch = plugin.channels.in;
    const imp = `if(eq(n\\,${at})\\,0.5\\,0)`;
    const src = `aevalsrc=exprs=${imp}${ch === 2 ? `|${imp}` : ''}:s=${sr}:d=1.2`;
    try {
      const { stdout } = await ffRun(['-f', 'lavfi', '-i', src, '-filter_complex', filterGraph(plugin, controls, ch), '-map', '[out]', '-f', 'f32le', '-ac', '1', 'pipe:1'], 20000);
      const f = new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + (stdout.length & ~3)));
      let mx = 0; for (const v of f) mx = Math.max(mx, Math.abs(v));
      if (!(mx > 1e-6)) return 0;
      const i = f.findIndex((v) => Math.abs(v) >= 0.5 * mx);
      return Math.max(0, Math.min(Math.round(sr * 0.9), i - at));
    } catch { return 0; }
  }

  async function runPlugin(plugin, controls, src, dest, sampleRate) {
    const info = await audio.probe(src);
    const ch = info.channels >= 2 ? 2 : 1;
    const lat = await latencyOf(plugin, controls, sampleRate);
    const timeoutMs = Math.min(30 * 60_000, 60_000 + info.duration * 4000);
    try {
      if (plugin.format === 'vst3') await runVst3(plugin, controls, src, dest, timeoutMs);
      else await ffRun(['-i', src, '-filter_complex', filterGraph(plugin, controls, ch, { padSamples: lat }), '-map', '[out]', '-ar', String(sampleRate), '-c:a', 'pcm_f32le', '-bitexact', dest], timeoutMs);
    } catch (err) { throw failed(plugin, err); }
    const out = await audio.readWav(dest);
    for (const c of out.channels) for (let i = 0; i < c.length; i++) if (!Number.isFinite(c[i])) throw failed(plugin, new Error('produced invalid (NaN/infinite) samples with these settings'));
    return { latencySamples: lat, channels: out.channels.length };
  }

  // Process only [start, end): render the span plus context, splice back with crossfades.
  async function runRange(plugin, controls, src, dest, sampleRate, start, end) {
    const full = await audio.readWav(src);
    const sr = full.sampleRate, margin = 0.25, xf = Math.round(0.012 * sr);
    const s = Math.max(0, Math.floor(start * sr)), e = Math.min(full.frames, Math.ceil(end * sr));
    if (e - s < 2 * xf) throw new OpError('Range is too short to process (needs at least 25 ms)', 'invalid_args', 400);
    const ms = Math.max(0, s - Math.round(margin * sr)), me = Math.min(full.frames, e + Math.round(margin * sr));
    const segIn = tmpFile('.wav'), segOut = tmpFile('.wav');
    try {
      await audio.writeWav(segIn, full.channels.map((c) => c.slice(ms, me)), sr);
      const r = await runPlugin(plugin, controls, segIn, segOut, sampleRate);
      const proc = await audio.readWav(segOut);
      const out = full.channels.map((c, ci) => {
        const o = Float32Array.from(c);
        const pc = proc.channels[Math.min(ci, proc.channels.length - 1)];
        for (let i = s; i < e; i++) {
          const k = i - ms;
          const w = Math.min(1, (i - s) / xf, (e - 1 - i) / xf);
          const ww = Math.sin((Math.PI / 2) * Math.max(0, w)) ** 2;
          o[i] = (1 - ww) * c[i] + ww * (k < pc.length ? pc[k] : c[i]);
        }
        return o;
      });
      await audio.writeWav(dest, out, sr);
      return r;
    } finally { await fs.rm(segIn, { force: true }); await fs.rm(segOut, { force: true }); }
  }

  async function registerAsset(pid, wavFile, { name, actor, derivedFrom, process }) {
    const p = store.get(pid);
    const id = newId('ast');
    const dest = store.assetPath(pid, id);
    await fs.rename(wavFile, dest).catch(async () => { await fs.copyFile(wavFile, dest); await fs.rm(wavFile, { force: true }); });
    try {
      const info = await audio.probe(dest);
      const { peak } = await audio.writePeaks(dest, store.peaksPath(pid, id));
      if (peak <= 1) await audio.writePreview(dest, store.previewPath(pid, id)).catch(() => fs.rm(store.previewPath(pid, id), { force: true }));
      const asset = { id, name, duration: Math.round(info.duration * 1e6) / 1e6, sampleRate: p.sampleRate, channels: info.channels, createdAt: new Date().toISOString(), createdBy: actor, derivedFrom, process };
      store.addAsset(pid, asset, actor);
      return asset;
    } catch (err) {
      for (const f of [dest, store.peaksPath(pid, id), store.previewPath(pid, id)]) await fs.rm(f, { force: true });
      throw err;
    }
  }

  function prepare(pid, assetId, body) {
    validate(applySchema, body, 'body');
    const p = store.get(pid);
    const asset = p.assets.find((a) => a.id === assetId);
    if (!asset) throw new OpError(`Asset ${assetId} not found`, 'not_found', 404);
    return { p, asset };
  }

  async function apply(pid, assetId, body = {}, actor) {
    const { p, asset } = prepare(pid, assetId, body);
    const plugin = await findPlugin(body.uri);
    const controls = checkControls(plugin, body.controls);
    let { start, end } = body;
    const ranged = start !== undefined || end !== undefined;
    if (ranged) {
      start = Math.max(0, start ?? 0); end = Math.min(asset.duration, end ?? asset.duration);
      if (!(end > start)) throw new OpError('end must be greater than start', 'invalid_args', 400);
    }
    const jobId = newId('job');
    const label = `${plugin.name} on “${asset.name}”${ranged ? ` (${start.toFixed(2)}–${end.toFixed(2)} s)` : ''}`;
    store.notify(pid, { type: 'job', jobId, status: 'running', label, actor });
    const out = tmpFile('.wav');
    try {
      const src = store.assetPath(pid, assetId);
      const r = ranged ? await runRange(plugin, controls, src, out, p.sampleRate, start, end) : await runPlugin(plugin, controls, src, out, p.sampleRate);
      const short = plugin.name.replace(/^(LSP|Calf|x42-?\w*)\s*-?\s*/i, '').slice(0, 40) || plugin.name;
      const created = await registerAsset(pid, out, { name: `${asset.name} · ${short}`, actor, derivedFrom: assetId, process: { kind: plugin.format === 'vst3' ? 'vst3' : 'lv2', params: { uri: plugin.uri, name: plugin.name, controls }, ...(ranged ? { start, end } : {}) } });
      let clipsUpdated = 0;
      if (body.replaceInClips !== false && store.get(pid).tracks.some((t) => t.clips.some((c) => c.assetId === assetId))) {
        const res = store.apply(pid, [{ op: 'asset.replaceInClips', args: { fromAssetId: assetId, toAssetId: created.id } }], { actor, label: `Applied ${plugin.name} to “${asset.name}”` });
        clipsUpdated = res.results[0].clipsUpdated;
      }
      store.notify(pid, { type: 'job', jobId, status: 'done', label, actor });
      return { asset: created, clipsUpdated, plugin: { uri: plugin.uri, name: plugin.name }, controls, latencyCompensatedSamples: r.latencySamples || 0 };
    } catch (err) {
      store.notify(pid, { type: 'job', jobId, status: 'failed', label, error: err.message, actor });
      throw err;
    } finally { await fs.rm(out, { force: true }); }
  }

  async function preview(pid, assetId, body = {}) {
    const { start: s0 = 0, end: e0, ...rest } = body;
    const { asset } = prepare(pid, assetId, rest);
    if (typeof s0 !== 'number' || !Number.isFinite(s0) || (e0 !== undefined && (typeof e0 !== 'number' || !Number.isFinite(e0)))) throw new OpError('start/end must be numbers', 'invalid_args', 400);
    const plugin = await findPlugin(rest.uri);
    const controls = checkControls(plugin, rest.controls);
    const start = Math.max(0, s0), end = Math.min(asset.duration, e0 ?? start + 8, start + 20);
    if (!(end > start)) throw new OpError('end must be greater than start', 'invalid_args', 400);
    const full = await audio.readWav(store.assetPath(pid, assetId));
    const s = Math.floor(start * full.sampleRate), e = Math.ceil(end * full.sampleRate);
    const segIn = tmpFile('.wav'), segOut = tmpFile('.wav');
    try {
      await audio.writeWav(segIn, full.channels.map((c) => c.slice(s, e)), full.sampleRate);
      await runPlugin(plugin, controls, segIn, segOut, store.get(pid).sampleRate);
      return await fs.readFile(segOut);
    } finally { await fs.rm(segIn, { force: true }); await fs.rm(segOut, { force: true }); }
  }

  const compact = (p) => ({ index: p.index, uri: p.uri, format: p.format, name: p.name, brand: p.brand, category: p.category, channels: p.channels, params: p.params.length });
  async function search({ q, category, brand, format } = {}) {
    const c = await getCatalog();
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const list = c.plugins.filter((p) => (!category || p.category.toLowerCase() === String(category).toLowerCase())
      && (!brand || p.brand.toLowerCase() === String(brand).toLowerCase())
      && (!format || p.format === String(format).toLowerCase())
      && words.every((w) => `${p.name} ${p.brand} ${p.category} ${p.format} ${p.uri} ${p.lv2Classes.join(' ')}`.toLowerCase().includes(w)));
    const count = (key) => c.plugins.reduce((m, p) => ((m[p[key]] = (m[p[key]] || 0) + 1), m), {});
    return { installed: c.installed, available: c.plugins.length, formats: c.formats, categories: count('category'), brands: count('brand'), plugins: list };
  }

  // ── REST ──
  api.get('/lv2', wrap(async (req, res) => {
    const r = await search(req.query);
    res.json({ ...r, plugins: r.plugins.map(compact) });
  }));
  api.get('/lv2/:index', wrap(async (req, res) => res.json(await findPlugin(/^\d+$/.test(req.params.index) ? +req.params.index : req.params.index))));
  api.post('/projects/:id/assets/:aid/lv2', json, wrap(async (req, res) => res.json(await apply(req.params.id, req.params.aid, req.body || {}, actorOf(req)))));
  api.post('/projects/:id/assets/:aid/lv2-preview', json, wrap(async (req, res) => {
    const wav = await preview(req.params.id, req.params.aid, req.body || {});
    res.type('audio/wav').send(wav);
  }));

  // ── MCP ──
  const fmtParam = (x) => `${x.symbol} “${x.name}” ${x.toggle ? 'toggle 0/1' : x.enum ? `enum ${x.enum.map((e) => `${e.value}=${e.label}`).join(', ')}` : `${x.min}…${x.max}${x.unit ? ` ${x.unit}` : ''}${x.integer ? ' (integer)' : ''}${x.log ? ' (log)' : ''}`}, default ${x.default}`;
  mcpTools.push({
    name: 'list_lv2_plugins',
    description: 'Search the native effect plugins installed on the server — LV2 and VST3 (LSP, x42, Calf, ZAM, Dragonfly, DISTRHO, MDA, …: EQs, compressors, limiters, gates, reverbs, delays, filters, distortion, modulation, stereo tools). They run server-side as destructive processes via apply_lv2_plugin. Filter by free text (all words must match name/brand/category/uri) and/or category; with no filters returns category counts plus the first results. Output: one line per plugin "#index [Category] Name (brand, in→out channels, N controls) uri".',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, category: { type: 'string', description: 'e.g. EQ, Compressor, Limiter, Gate, Expander, Dynamics, Filter, Reverb, Delay, Modulation, Distortion, Spatial, Pitch, Utility' }, brand: { type: 'string', description: 'e.g. LSP, x42, Calf, ZAM, Dragonfly, DISTRHO, MDA' }, format: { type: 'string', enum: ['lv2', 'vst3'] }, limit: { type: 'integer', minimum: 1, maximum: 400, description: 'default 60' } } },
    handler: async ({ query, category, brand, format, limit = 60 }) => {
      const r = await search({ q: query, category, brand, format });
      const lines = r.plugins.slice(0, limit).map((p) => `#${p.index} [${p.category}] ${p.name} (${p.format.toUpperCase()}, ${p.brand}, ${p.channels.in}→${p.channels.out} ch, ${p.params.length} controls) ${p.uri}`);
      return `${r.plugins.length} matching of ${r.available} usable LV2/VST3 effects (categories: ${Object.entries(r.categories).map(([k, v]) => `${k} ${v}`).join(', ')}).${r.plugins.length > limit ? ` Showing ${limit}; narrow with query/category.` : ''}\n${lines.join('\n')}\nNext: lv2_plugin_info for controls, then apply_lv2_plugin.`;
    },
  });
  mcpTools.push({
    name: 'lv2_plugin_info',
    description: 'Controls of one LV2 or VST3 plugin (by uri or #index from list_lv2_plugins): symbol, label, range, unit, default, toggles and enumerations. Pass values by symbol in apply_lv2_plugin.controls; anything not passed keeps its default.',
    inputSchema: { type: 'object', properties: { uri: { type: 'string' }, index: { type: 'integer', minimum: 0 } } },
    handler: async ({ uri, index }) => {
      const p = await findPlugin(uri ?? index ?? '');
      return `#${p.index} ${p.name} — ${p.format.toUpperCase()}, ${p.category}, ${p.brand}, ${p.channels.in} in → ${p.channels.out} out${p.latency ? ', latency compensated' : ''}\nuri: ${p.uri}\nControls:\n${p.params.map((x) => `  ${fmtParam(x)}`).join('\n') || '  (none)'}`;
    },
  });
  mcpTools.push({
    name: 'apply_lv2_plugin',
    description: 'Run a native LV2 or VST3 effect plugin over an asset on the server (destructive, like process_audio): creates a new asset and, by default, swaps it into every clip using the original (one undo step; undo restores the original). Length is kept; mono assets stay mono (stereo plugins get a dual-mono feed and are folded back), stereo assets stay stereo (mono plugins run per channel). Plugin latency is compensated. start/end (asset seconds) restrict it to a range with crossfaded edges. controls: { symbol: number } validated against lv2_plugin_info ranges. Returns the new asset id. Check the result with analyze.',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, assetId: { type: 'string' }, ...applySchema.properties }, required: ['projectId', 'assetId', 'uri'] },
    handler: ({ projectId, assetId, ...body }, actor) => apply(projectId, assetId, body, actor),
  });
}

export const _test = { parseLv2info, statementFor, unitsFromStatement, buildCatalog };
