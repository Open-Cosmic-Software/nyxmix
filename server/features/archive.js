// Session archives (.nyxmix = tar; old .klang files still import): everything needed to move a session to another
// NyxMix server — project, lossless assets, transcripts, noise prints, versions.
// Streamed both ways, so multi-gigabyte sessions never sit in memory.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { newId } from '../ops.js';
import { writePeaks, writePreview } from '../audio.js';
import { installPlugin } from './plugins.js';

const KEEP_DIRS = ['assets', 'transcripts', 'noiseprints', 'video', 'plugins'];
const PLUGIN_ID = /^[a-z][a-z0-9-]{1,40}$/;

// Custom plugins (installed per server) that this session uses, now or in a saved version.
// LV2/VST3 are applied offline and their output is already an asset WAV, so only "plugin:<id>" effects matter.
async function usedPlugins(dir) {
  const ids = new Set();
  for (const f of ['project.json', 'versions.json']) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    for (const m of (await fsp.readFile(p, 'utf8')).matchAll(/"plugin:([a-z][a-z0-9-]{1,40})"/g)) ids.add(m[1]);
  }
  return [...ids];
}
const KEEP_FILES = ['project.json', 'versions.json', 'activity.jsonl', 'video.json'];

function header(name, size) {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
  h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

async function* tarEntries(dir, pluginDir) {
  for (const f of KEEP_FILES) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) yield { name: f, file: p };
  }
  for (const d of KEEP_DIRS) {
    const p = path.join(dir, d);
    if (!fs.existsSync(p)) continue;
    for (const f of await fsp.readdir(p)) {
      if (d === 'assets' && !f.endsWith('.wav')) continue; // peaks and previews are rebuilt on import
      yield { name: `${d}/${f}`, file: path.join(p, f) };
    }
  }
  if (!pluginDir) return;
  for (const id of await usedPlugins(dir)) {
    const js = path.join(pluginDir, `${id}.js`), manifest = path.join(pluginDir, `${id}.json`);
    if (fs.existsSync(js) && fs.existsSync(manifest)) { yield { name: `plugins/${id}.json`, file: manifest }; yield { name: `plugins/${id}.js`, file: js }; }
  }
}

async function* tarStream(dir, pluginDir) {
  for await (const { name, file } of tarEntries(dir, pluginDir)) {
    const { size } = await fsp.stat(file);
    yield header(name, size);
    for await (const chunk of fs.createReadStream(file)) yield chunk;
    if (size % 512) yield Buffer.alloc(512 - (size % 512));
  }
  yield Buffer.alloc(1024);
}

// Minimal streaming tar reader: regular files only, names validated.
async function untar(stream, destDir, maxBytes) {
  let buf = Buffer.alloc(0), cur = null, total = 0;
  const files = [];
  const safe = (n) => {
    const norm = path.posix.normalize(n);
    const ok = (KEEP_FILES.includes(norm) || KEEP_DIRS.some((d) => norm.startsWith(d + '/') && !norm.slice(d.length + 1).includes('/')))
      && !norm.includes('..') && /^[\w./-]+$/.test(norm);
    return ok ? norm : null;
  };
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error('Archive too large'), { status: 413, code: 'too_large' });
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (cur) {
        const take = Math.min(cur.left, buf.length);
        if (take) { if (cur.fd) fs.writeSync(cur.fd, buf, 0, take); cur.left -= take; buf = buf.subarray(take); }
        if (cur.left > 0) break;
        if (cur.fd) fs.closeSync(cur.fd);
        const pad = (512 - (cur.size % 512)) % 512;
        cur = { pad };
      }
      if (cur?.pad !== undefined) {
        if (buf.length < cur.pad) break;
        buf = buf.subarray(cur.pad); cur = null;
      }
      if (buf.length < 512) break;
      const h = buf.subarray(0, 512);
      if (h.every((b) => b === 0)) return files;
      const name = h.toString('utf8', 0, 100).replace(/\0.*$/s, '');
      const size = parseInt(h.toString('ascii', 124, 136).replace(/\0.*$/s, '').trim() || '0', 8);
      const type = String.fromCharCode(h[156] || 48);
      buf = buf.subarray(512);
      const rel = type === '0' ? safe(name) : null;
      let fd = null;
      if (rel) {
        const out = path.join(destDir, rel);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fd = fs.openSync(out, 'w');
        files.push(rel);
      }
      cur = { left: size, size, fd };
      if (size === 0) { if (fd) fs.closeSync(fd); cur = null; }
    }
  }
  return files;
}

export async function register({ api, wrap, store, mcpTools, actorOf, OpError }) {
  const pluginDir = path.join(store.dir, 'plugins');

  // Plugins shipped inside an archive: identical ones are already there, missing ones are installed
  // (same checks and test render as a normal install, and only if the operator enabled plugins),
  // a different plugin under the same id is never overwritten.
  async function restorePlugins(dir) {
    const out = { included: [], installed: [], alreadyInstalled: [], skipped: [] };
    const src = path.join(dir, 'plugins');
    if (!fs.existsSync(src)) return out;
    for (const f of (await fsp.readdir(src)).filter((x) => x.endsWith('.json'))) {
      const id = f.slice(0, -5);
      if (!PLUGIN_ID.test(id)) continue;
      out.included.push(id);
      const codeFile = path.join(src, `${id}.js`);
      if (!fs.existsSync(codeFile)) { out.skipped.push({ id, reason: 'plugin code missing in the archive' }); continue; }
      let manifest, code;
      try { manifest = JSON.parse(await fsp.readFile(path.join(src, f), 'utf8')); code = await fsp.readFile(codeFile, 'utf8'); } catch { out.skipped.push({ id, reason: 'unreadable plugin files' }); continue; }
      if (manifest?.id !== id) { out.skipped.push({ id, reason: 'manifest id does not match' }); continue; }
      const here = path.join(pluginDir, `${id}.js`);
      if (fs.existsSync(here)) {
        if ((await fsp.readFile(here, 'utf8')) === code) out.alreadyInstalled.push(id);
        else out.skipped.push({ id, reason: 'a different plugin with this id is already installed here' });
        continue;
      }
      try { await installPlugin({ manifest, code }); out.installed.push(id); } catch (err) { out.skipped.push({ id, reason: err.message }); }
    }
    await fsp.rm(src, { recursive: true, force: true });
    return out;
  }

  api.get('/projects/:id/archive', wrap(async (req, res) => {
    const p = store.get(req.params.id);
    await store.persistNow(p.id);
    res.setHeader('Content-Type', 'application/x-tar');
    res.setHeader('Content-Disposition', `attachment; filename="${p.name.replace(/[^\w .-]+/g, '_').trim() || 'session'}.nyxmix"`);
    await pipeline(tarStream(store.projectDir(p.id), pluginDir), res);
  }));

  async function importArchive(stream, actor) {
    const id = newId('prj');
    const dir = store.projectDir(id);
    await fsp.mkdir(dir, { recursive: true });
    try {
      const files = await untar(stream, dir, 20 * 1024 ** 3);
      if (!files.includes('project.json')) throw new OpError('Not a NyxMix archive (no project.json)', 'invalid_archive', 400);
      const project = JSON.parse(await fsp.readFile(path.join(dir, 'project.json'), 'utf8'));
      if (!Array.isArray(project.tracks) || !Array.isArray(project.assets)) throw new OpError('Archive project.json is malformed', 'invalid_archive', 400);
      project.id = id;
      project.updatedAt = new Date().toISOString();
      const assetIds = new Set(project.assets.map((a) => a.id));
      const finite = (...v) => v.every((x) => x === undefined || (typeof x === 'number' && Number.isFinite(x)));
      for (const t of project.tracks) {
        if (!/^trk_[a-f0-9]+$/.test(t.id) || !Array.isArray(t.clips || []) || !Array.isArray(t.effects || [])) throw new OpError('Archive contains an invalid track', 'invalid_archive', 400);
        for (const c of t.clips || []) {
          if (!/^clp_[a-f0-9]+$/.test(c.id) || !assetIds.has(c.assetId) || !finite(c.start, c.offset, c.duration, c.gain, c.fadeIn, c.fadeOut)) throw new OpError('Archive contains a clip with an invalid reference', 'invalid_archive', 400);
        }
      }
      for (const a of project.assets) {
        if (!/^ast_[a-f0-9]+$/.test(a.id)) throw new OpError('Archive contains an invalid asset id', 'invalid_archive', 400);
        const wav = store.assetPath(id, a.id);
        if (!fs.existsSync(wav)) throw new OpError(`Archive is missing audio for “${a.name}”`, 'invalid_archive', 400);
        const { peak } = await writePeaks(wav, store.peaksPath(id, a.id));
        if (peak <= 1) await writePreview(wav, store.previewPath(id, a.id)).catch(() => {});
      }
      const plugins = await restorePlugins(dir);
      await fsp.mkdir(store.rendersDir(id), { recursive: true });
      await fsp.writeFile(path.join(dir, 'project.json'), JSON.stringify(project, null, 1));
      store.entries.set(id, { project, undo: [], redo: [], log: [] });
      store.log(id, { actor, label: `Imported session “${project.name}” from an archive${plugins.installed.length ? ` (installed plugins: ${plugins.installed.join(', ')})` : ''}` });
      return { id, name: project.name, assets: project.assets.length, tracks: project.tracks.length, plugins };
    } catch (err) {
      store.entries.delete(id);
      await fsp.rm(dir, { recursive: true, force: true });
      throw err;
    }
  }

  api.post('/projects/import', wrap(async (req, res) => res.status(201).json(await importArchive(req, actorOf(req)))));

  mcpTools.push({
    name: 'archive_url',
    description: 'Get a download URL for a .nyxmix archive of the session (project, lossless audio, transcripts, versions, and the custom plugins it uses) — for backups or moving the session to another NyxMix server, where POST /api/projects/import restores it.',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] },
    handler: async ({ projectId }, _actor, req) => { store.get(projectId); return { url: `${process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`}/api/projects/${projectId}/archive` }; },
  });
}
