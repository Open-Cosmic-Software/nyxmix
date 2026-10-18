// Faust plugins: compile Faust DSP source (https://faust.grame.fr) to WebAssembly with
// faustwasm, wrap it in a self-contained AudioWorklet module (WASM embedded as base64,
// no imports, no fetch) and install it through the ordinary plugin path, so the whole
// Faust library world (re.*, co.*, fi.*, ef.*, dm.*, ...) is available as "plugin:<id>".
// The compiler runs in a worker thread with a timeout so a pathological program can
// neither block nor crash the server.
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { installPlugin } from './plugins.js';

const FAUST_DIR = fileURLToPath(new URL('../../node_modules/@grame/faustwasm/', import.meta.url));
const ID = /^[a-z][a-z0-9-]{1,40}$/;

// ---- compiler (worker side) ----
if (!isMainThread && workerData?.faustJob) {
  (async () => {
    const { instantiateFaustModuleFromFile, LibFaust, FaustCompiler } = await import(`${FAUST_DIR}dist/esm/index.js`);
    const compiler = new FaustCompiler(new LibFaust(await instantiateFaustModuleFromFile(`${FAUST_DIR}libfaust-wasm/libfaust-wasm.js`)));
    try {
      const f = await compiler.createMonoDSPFactory(workerData.name, workerData.code, '-ftz 2');
      if (!f) throw new Error(compiler.getErrorMessage() || 'Faust compilation failed');
      parentPort.postMessage({ wasm: Buffer.from(f.code).toString('base64'), json: f.json, version: compiler.version() });
    } catch (err) {
      parentPort.postMessage({ error: compiler.getErrorMessage() || err.message || String(err) });
    }
  })().catch((err) => parentPort.postMessage({ error: `Faust compiler failed to start: ${err.message}` }));
}

function compile(name, code) {
  return new Promise((resolve, reject) => {
    // stderr is piped and dropped: emscripten prints an "Aborted(...)" line on every compile error.
    const w = new Worker(new URL(import.meta.url), { workerData: { faustJob: true, name, code }, stderr: true, stdout: true });
    w.stderr.resume(); w.stdout.resume();
    const timer = setTimeout(() => { w.terminate(); reject(Object.assign(new Error('Faust compilation took longer than 30 s'), { faust: true })); }, 30000);
    w.once('message', (m) => { clearTimeout(timer); w.terminate(); m.error ? reject(Object.assign(new Error(m.error.trim()), { faust: true })) : resolve(m); });
    w.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// ---- manifest from the Faust UI JSON ----
const CONTROLS = new Set(['hslider', 'vslider', 'nentry', 'checkbox', 'button']);
function paramName(label, used) {
  const words = String(label).split(/[^A-Za-z0-9]+/).filter(Boolean);
  let n = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w[0].toLowerCase() + w.slice(1))).join('') || 'param';
  if (!/^[a-zA-Z]/.test(n)) n = `p${n}`;
  n = n.slice(0, 28);
  let out = n;
  for (let k = 2; used.has(out); k++) out = `${n}${k}`;
  used.add(out);
  return out;
}
function deriveParams(dsp) {
  const items = [], used = new Set();
  const walk = (list) => { for (const it of list || []) { if (it.items) walk(it.items); else items.push(it); } };
  walk(dsp.ui);
  if (items.some((it) => it.type === 'soundfile')) throw Object.assign(new Error('soundfile primitives are not supported in NyxMix Faust plugins'), { faust: true });
  const params = {}, table = [];
  for (const it of items) {
    if (!CONTROLS.has(it.type)) continue; // bargraphs are outputs
    const toggle = it.type === 'checkbox' || it.type === 'button';
    const min = toggle ? 0 : Number(it.min), max = toggle ? 1 : Number(it.max);
    const init = toggle ? 0 : Math.min(max, Math.max(min, Number(it.init)));
    if (!(min < max)) continue; // a fixed value, nothing to control
    const name = paramName(it.label, used);
    const meta = Object.assign({}, ...(it.meta || []));
    params[name] = { minimum: min, maximum: max, default: init, ...(meta.unit ? { unit: String(meta.unit) } : {}), description: String(meta.tooltip || `Faust ${it.type} ${it.address}`) };
    table.push([name, it.index, init]);
  }
  return { params, table };
}

// ---- worklet module ----
// Runs in Chrome's AudioWorkletGlobalScope and in node-web-audio-api's worker scope, so it
// relies only on WebAssembly + AudioWorkletProcessor (no atob/TextDecoder/fetch).
const RUNTIME = String.raw`
const B64 = (s) => {
  const T = new Uint8Array(128), A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < 64; i++) T[A.charCodeAt(i)] = i;
  s = s.replace(/=+$/, '');
  const out = new Uint8Array((s.length * 3) >> 2);
  let acc = 0, bits = 0, o = 0;
  for (let i = 0; i < s.length; i++) {
    acc = (acc << 6) | T[s.charCodeAt(i)]; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; acc &= (1 << bits) - 1; }
  }
  return out;
};
const MOD = new WebAssembly.Module(B64(WASM));
const M = Math, rint = (x) => { const r = M.round(x); return (r - x === 0.5 && r % 2) ? r - 1 : r; };
const ENV = { memoryBase: 0, tableBase: 0, _abs: M.abs, _fmodf: (x, y) => x % y, _fmod: (x, y) => x % y,
  _remainderf: (x, y) => x - M.round(x / y) * y, _remainder: (x, y) => x - M.round(x / y) * y,
  _isnanf: Number.isNaN, _isnan: Number.isNaN, _isinff: (x) => !isFinite(x), _isinf: (x) => !isFinite(x),
  _copysignf: (x, y) => (M.sign(x) === M.sign(y) ? x : -x), _copysign: (x, y) => (M.sign(x) === M.sign(y) ? x : -x),
  _rintf: rint, _rint: rint, _exp10f: (x) => 10 ** x, _exp10: (x) => 10 ** x,
  _max_i: M.max, _min_i: M.min, _max_f: M.max, _min_f: M.min, _max_: M.max, _min_: M.min };
for (const im of WebAssembly.Module.imports(MOD)) {
  if (im.kind !== 'function' || ENV[im.name]) continue;
  const f = M[im.name.replace(/^_/, '')] || M[im.name.replace(/^_/, '').replace(/f$/, '')];
  if (!f) throw new Error('Faust plugin needs unsupported math function ' + im.name);
  ENV[im.name] = f;
}
const BLOCK = 128;
class FaustPlugin extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return DSP.params.map(([name, , init, min, max]) => ({ name, defaultValue: init, minValue: min, maxValue: max, automationRate: 'k-rate' }));
  }
  constructor() { super(); this.dsp = []; this.last = new Float64Array(DSP.params.length); }
  make() {
    const e = new WebAssembly.Instance(MOD, { env: ENV }).exports, ni = DSP.inputs, no = DSP.outputs;
    const ins = (DSP.size + 15) & ~15, outs = ins + 4 * ni, data = outs + 4 * no + 16 & ~15;
    const end = data + 4 * BLOCK * (ni + no);
    if (e.memory.buffer.byteLength < end) e.memory.grow(Math.ceil((end - e.memory.buffer.byteLength) / 65536));
    const H32 = new Int32Array(e.memory.buffer), HF = new Float32Array(e.memory.buffer);
    const chan = (k) => data + 4 * BLOCK * k;
    for (let i = 0; i < ni; i++) H32[(ins >> 2) + i] = chan(i);
    for (let o = 0; o < no; o++) H32[(outs >> 2) + o] = chan(ni + o);
    e.init(0, sampleRate);
    this.last.fill(NaN);
    return { e, ins, outs, inBuf: Array.from({ length: ni }, (_, i) => HF.subarray(chan(i) >> 2, (chan(i) >> 2) + BLOCK)), outBuf: Array.from({ length: no }, (_, o) => HF.subarray(chan(ni + o) >> 2, (chan(ni + o) >> 2) + BLOCK)) };
  }
  process(inputs, outputs, p) {
    const out = outputs[0], inp = inputs[0] || [], nch = out.length, G = M.max(1, DSP.outputs), ni = DSP.inputs;
    if (!nch) return true;
    // One DSP instance per group of G output channels (a mono Faust filter runs once per channel).
    while (this.dsp.length < M.ceil(nch / G)) this.dsp.push(this.make());
    for (let k = 0; k < DSP.params.length; k++) {
      const v = p[DSP.params[k][0]][0];
      if (v !== this.last[k]) { this.last[k] = v; for (const d of this.dsp) d.e.setParamValue(0, DSP.params[k][1], v); }
    }
    const n = out[0].length;
    for (let j = 0; j < this.dsp.length; j++) {
      const d = this.dsp[j], base = j * G;
      for (let off = 0; off < n; off += BLOCK) {
        const len = M.min(BLOCK, n - off);
        for (let i = 0; i < ni; i++) {
          const buf = d.inBuf[i];
          if (!inp.length) { buf.fill(0); continue; }
          if (ni === 1 && G > 1) { // mono-in, multi-out (e.g. a mono-to-stereo reverb): feed the group's average
            buf.fill(0);
            let cnt = 0;
            for (let c = base; c < M.min(base + G, M.max(inp.length, 1)); c++) { const x = inp[M.min(c, inp.length - 1)]; for (let t = 0; t < len; t++) buf[t] += x[off + t]; cnt++; }
            if (cnt > 1) for (let t = 0; t < len; t++) buf[t] /= cnt;
          } else {
            const x = inp[M.min(base + i, inp.length - 1)];
            buf.set(len === x.length && off === 0 ? x : x.subarray(off, off + len));
          }
        }
        d.e.compute(0, len, d.ins, d.outs);
        for (let o = 0; o < DSP.outputs && base + o < nch; o++) out[base + o].set(len === BLOCK ? d.outBuf[o] : d.outBuf[o].subarray(0, len), off);
      }
    }
    return true;
  }
}
registerProcessor(PROCESSOR, FaustPlugin);
`;

export async function buildFaustPlugin({ id, label, description, code }) {
  const { wasm, json, version } = await compile(id, code);
  const dsp = JSON.parse(json);
  if (!dsp.outputs) throw Object.assign(new Error('The Faust program has no outputs (process must produce audio)'), { faust: true });
  if (dsp.inputs > 8 || dsp.outputs > 8) throw Object.assign(new Error('Faust plugins may have at most 8 inputs and 8 outputs'), { faust: true });
  const { params, table } = deriveParams(dsp);
  if (Object.keys(params).length > 32) throw Object.assign(new Error(`The Faust program has ${Object.keys(params).length} controls; NyxMix plugins allow up to 32`), { faust: true });
  const meta = { inputs: dsp.inputs, outputs: dsp.outputs, size: dsp.size, params: table.map(([name, index, init]) => [name, index, init, params[name].minimum, params[name].maximum]) };
  const module = `// NyxMix Faust plugin "${String(label).replace(/[\r\n]/g, ' ')}", compiled by faustwasm (Faust ${version}).
// Faust source:
${code.split('\n').map((l) => `//   ${l}`).join('\n')}
/* global registerProcessor, AudioWorkletProcessor, sampleRate */
const PROCESSOR = 'plugin-${id}';
const DSP = ${JSON.stringify(meta)};
const WASM = '${wasm}';
${RUNTIME}`;
  const manifest = { id, label, author: 'Faust', description: description || `Faust DSP (${dsp.inputs} in, ${dsp.outputs} out)`, params };
  return { manifest, code: module, faust: { version, inputs: dsp.inputs, outputs: dsp.outputs, wasmBytes: Math.floor((wasm.length * 3) / 4) } };
}

export async function register({ api, json, wrap, mcpTools, OpError }) {
  async function installFaust(a = {}) {
    if (process.env.KLANG_PLUGINS !== '1') throw new OpError('Installing plugins is disabled on this server (the operator can enable it with KLANG_PLUGINS=1, because plugin code runs on the server).', 'plugins_disabled', 403);
    if (!ID.test(a.id || '')) throw new OpError('id must be lowercase letters, digits and dashes (2–41 chars)', 'invalid_args', 400);
    if (!a.label || String(a.label).length > 60) throw new OpError('label is required (max 60 chars)', 'invalid_args', 400);
    if (typeof a.code !== 'string' || !a.code.trim() || a.code.length > 50_000) throw new OpError('code must be Faust source (max 50 kB), e.g. import("stdfaust.lib"); process = ...;', 'invalid_args', 400);
    let built;
    try { built = await buildFaustPlugin({ id: a.id, label: String(a.label), description: a.description ? String(a.description) : '', code: a.code }); } catch (err) {
      if (err.faust) throw new OpError(err.message, 'faust_compile_error', 400);
      throw err;
    }
    const installed = await installPlugin({ manifest: built.manifest, code: built.code });
    return { ...installed, faust: built.faust };
  }

  api.post('/plugins/faust', json, wrap(async (req, res) => res.status(201).json(await installFaust(req.body || {}))));

  mcpTools.push({
    name: 'install_faust_plugin',
    description: `Install a real-time effect written in Faust (https://faust.grame.fr), compiled to WebAssembly on the server. Example:
  import("stdfaust.lib");
  cutoff = hslider("cutoff [unit:Hz]", 2000, 50, 18000, 1);
  process = par(i, 2, fi.lowpass(4, cutoff));
Every hslider/vslider/nentry/checkbox/button becomes a parameter named after its label in camelCase (e.g. "Wet Dry" → wetDry) with the Faust min/max/init. A mono program runs once per channel; a stereo one (2 in/2 out) on L/R. The full standard library is available: re.zita_rev1_stereo / dm.zita_light (reverb), dm.freeverb_demo, co.compressor_stereo / co.limiter_1176_R4_mono (dynamics), fi.lowpass/highpass/resonlp/peak_eq/low_shelf (filters), ef.cubicnl / ef.echo / ef.transpose (effects), pf.phaser2_stereo / pf.flanger_stereo (modulation), dm.*_demo (complete demo effects with UI). Compile errors come back verbatim; fix and retry. Then use it as effect type "plugin:<id>". Only works if the operator enabled plugins.`,
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'lowercase-dashed id, e.g. "zita-verb"' }, label: { type: 'string' }, description: { type: 'string' }, code: { type: 'string', description: 'Faust source with a process = ... definition' } }, required: ['id', 'label', 'code'] },
    handler: (a) => installFaust(a),
  });
}
