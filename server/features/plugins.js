// Plugin management. Installing runs foreign code on this server (inside the render
// processes), so it is off unless the operator sets KLANG_PLUGINS=1.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { registerPlugin, pluginType } from '../../public/js/engine/plugins.js';
import { EFFECTS } from '../../public/js/engine/graph.js';
import { setPluginDir, renderMix, writeWav } from '../audio.js';
import { newId } from '../ops.js';

const ID = /^[a-z][a-z0-9-]{1,40}$/;
// The install path (validate, write, test-render), for other features that generate plugins (faust.js).
export let installPlugin = () => { throw new Error('plugins feature not registered yet'); };

export async function register({ api, json, wrap, store, mcpTools, OpError }) {
  const dir = path.join(store.dir, 'plugins');
  await fs.mkdir(dir, { recursive: true });
  setPluginDir(dir);
  const enabled = () => process.env.KLANG_PLUGINS === '1';
  const list = async () => {
    const out = [];
    for (const f of (await fs.readdir(dir)).filter((x) => x.endsWith('.json'))) out.push(JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')));
    return out;
  };
  for (const m of await list()) registerPlugin(m);

  function checkManifest(m, code) {
    if (!m || typeof m !== 'object') throw new OpError('manifest is required', 'invalid_args', 400);
    if (!ID.test(m.id || '')) throw new OpError('manifest.id must be lowercase letters, digits and dashes (2–41 chars)', 'invalid_args', 400);
    if (!m.label || String(m.label).length > 60) throw new OpError('manifest.label is required (max 60 chars)', 'invalid_args', 400);
    if (!m.params || typeof m.params !== 'object' || Object.keys(m.params).length > 32) throw new OpError('manifest.params must describe up to 32 parameters', 'invalid_args', 400);
    for (const [k, p] of Object.entries(m.params)) {
      if (!/^[a-zA-Z]\w{0,30}$/.test(k)) throw new OpError(`Bad parameter name "${k}"`, 'invalid_args', 400);
      const ok = [p?.minimum, p?.maximum, p?.default].every((v) => typeof v === 'number' && Number.isFinite(v)) && p.minimum < p.maximum && p.default >= p.minimum && p.default <= p.maximum;
      if (!ok) throw new OpError(`Parameter "${k}" needs numeric minimum < maximum and a default inside`, 'invalid_args', 400);
    }
    if (typeof code !== 'string' || !code.length || code.length > 200_000) throw new OpError('code must be the worklet module source (max 200 kB)', 'invalid_args', 400);
    if (!code.includes(`'plugin-${m.id}'`) && !code.includes(`"plugin-${m.id}"`)) throw new OpError(`code must call registerProcessor('plugin-${m.id}', …)`, 'invalid_args', 400);
    return { id: m.id, label: String(m.label), author: String(m.author || '').slice(0, 80), description: String(m.description || '').slice(0, 300), params: Object.fromEntries(Object.entries(m.params).map(([k, p]) => [k, { type: 'number', minimum: p.minimum, maximum: p.maximum, default: p.default, ...(p.unit ? { unit: String(p.unit).slice(0, 8) } : {}), ...(p.description ? { description: String(p.description).slice(0, 200) } : {}) }])) };
  }

  // Render one second of noise through the plugin in a render process; must give finite, bounded output.
  async function smokeTest(manifest) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'klang-plugin-'));
    try {
      const sr = 48000, n = sr;
      const noise = Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.05) * 0.5 + (Math.random() - 0.5) * 0.2);
      await writeWav(path.join(tmp, 'ast_test.wav'), [noise], sr);
      const project = { sampleRate: sr, master: { gain: 0, effects: [] }, markers: [], tracks: [{ id: 'trk_test', gain: 0, pan: 0, sends: [], clips: [{ id: 'clp_test', assetId: 'ast_test', start: 0, offset: 0, duration: 1, gain: 0, fadeIn: 0, fadeOut: 0 }], effects: [{ id: 'fx_test', type: pluginType(manifest.id), enabled: true, params: Object.fromEntries(Object.entries(manifest.params).map(([k, p]) => [k, p.default])) }] }] };
      const { channels } = await Promise.race([
        renderMix(project, (id) => path.join(tmp, `${id}.wav`), { start: 0, end: 1, threads: 1 }),
        new Promise((_, rej) => setTimeout(() => rej(new OpError('Plugin test render took longer than 20 s', 'plugin_failed', 422)), 20000)),
      ]);
      for (const ch of channels) for (const v of ch) if (!Number.isFinite(v) || Math.abs(v) > 64) throw new OpError('Plugin produced non-finite or runaway output in the test render', 'plugin_failed', 422);
    } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  }

  async function install({ manifest, code }) {
    if (!enabled()) throw new OpError('Installing plugins is disabled on this server (the operator can enable it with KLANG_PLUGINS=1, because plugin code runs on the server).', 'plugins_disabled', 403);
    const m = checkManifest(manifest, code);
    const prev = EFFECTS[pluginType(m.id)];
    await fs.writeFile(path.join(dir, `${m.id}.js`), code);
    registerPlugin(m);
    try { await smokeTest(m); } catch (err) {
      if (prev) EFFECTS[pluginType(m.id)] = prev; else delete EFFECTS[pluginType(m.id)];
      await fs.rm(path.join(dir, `${m.id}.js`), { force: true });
      throw Object.assign(err, { status: err.status || 422, code: err.code || 'plugin_failed', message: `Plugin test failed: ${err.message}` });
    }
    await fs.writeFile(path.join(dir, `${m.id}.json`), JSON.stringify(m, null, 1));
    return { ...m, type: pluginType(m.id) };
  }

  installPlugin = install;
  api.get('/plugins', wrap(async (req, res) => res.json({ installEnabled: enabled(), plugins: (await list()).map((m) => ({ ...m, type: pluginType(m.id) })) })));
  api.get('/plugins/:file', wrap(async (req, res) => {
    const id = req.params.file.replace(/\.js$/, '');
    if (!ID.test(id)) throw new OpError('Plugin not found', 'not_found', 404);
    res.type('text/javascript').sendFile(path.join(dir, `${id}.js`), (e) => e && !res.headersSent && res.status(404).json({ error: { code: 'not_found', message: 'Plugin not found' } }));
  }));
  api.post('/plugins', json, wrap(async (req, res) => res.status(201).json(await install(req.body || {}))));
  api.delete('/plugins/:id', wrap(async (req, res) => {
    if (!enabled()) throw new OpError('Plugin management is disabled on this server', 'plugins_disabled', 403);
    if (!ID.test(req.params.id)) throw new OpError('Plugin not found', 'not_found', 404);
    const used = store.list().filter((s) => { const p = store.get(s.id); return [p.master, ...p.tracks].some((o) => o.effects.some((e) => e.type === pluginType(req.params.id))); });
    if (used.length) throw new OpError(`Plugin is used in ${used.map((x) => `“${x.name}”`).join(', ')}; remove it there first`, 'in_use', 409);
    await fs.rm(path.join(dir, `${req.params.id}.js`), { force: true });
    await fs.rm(path.join(dir, `${req.params.id}.json`), { force: true });
    delete EFFECTS[pluginType(req.params.id)];
    res.status(204).end();
  }));

  mcpTools.push(
    { name: 'list_plugins', description: 'Installed effect plugins (use them with effect.add type "plugin:<id>") and whether installing is enabled here.', inputSchema: { type: 'object', properties: {} }, handler: async () => ({ installEnabled: enabled(), plugins: (await list()).map((m) => ({ type: pluginType(m.id), label: m.label, description: m.description, params: m.params })) }) },
    {
      name: 'install_plugin',
      description: 'Install a custom real-time effect: manifest {id, label, description, params:{name:{minimum,maximum,default,unit}}} plus code = an AudioWorklet module that calls registerProcessor("plugin-<id>", Class) with one k-rate AudioParam per param. It is test-rendered before it is accepted, then usable everywhere as effect type "plugin:<id>" (preview and export). Only works if the operator enabled plugins.',
      inputSchema: { type: 'object', properties: { manifest: { type: 'object' }, code: { type: 'string' } }, required: ['manifest', 'code'] },
      handler: (a) => install(a),
    },
  );
}
