import { freePort } from './helpers.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klang-plugins-'));
const servers = [];
async function boot(env) {
  const PORT = await freePort();
  const s = spawn('node', ['server/index.js'], { env: { ...process.env, PORT, KLANG_DATA: path.join(dir, `data-${PORT}`), ...env }, stdio: 'pipe' });
  servers.push(s);
  const BASE = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 200; i++) { try { await fetch(BASE + '/api'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const j = async (method, url, body) => { const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => null) }; };
  return { BASE, j };
}
after(() => { for (const s of servers) s.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const manifest = JSON.parse(fs.readFileSync('examples/plugins/fuzz.json', 'utf8'));
const code = fs.readFileSync('examples/plugins/fuzz.js', 'utf8');

test('installing plugins is refused unless the operator enables it', async () => {
  const { j } = await boot({});
  const r = await j('POST', '/api/plugins', { manifest, code });
  assert.equal(r.status, 403);
});

test('a plugin installs, renders on the server, and broken ones are rejected', async () => {
  const { BASE, j } = await boot({ KLANG_PLUGINS: '1' });
  const r = await j('POST', '/api/plugins', { manifest, code });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.type, 'plugin:fuzz');
  const p = (await j('POST', '/api/projects', { name: 'Fuzz' })).data;
  const f = path.join(dir, 't.wav');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=220:d=2', f]);
  const a = await (await fetch(`${BASE}/api/projects/${p.id}/assets?name=t`, { method: 'POST', body: fs.readFileSync(f) })).json();
  const ops = await j('POST', `/api/projects/${p.id}/ops`, { ops: [{ op: 'track.add', args: {} }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId: a.id } }, { op: 'effect.add', args: { trackId: '$0.trackId', type: 'plugin:fuzz', params: { drive: 30, mix: 1 } } }] });
  assert.equal(ops.status, 200, JSON.stringify(ops.data));
  const an = await j('POST', `/api/projects/${p.id}/analyze`, { include: ['spectrum'] });
  assert.equal(an.status, 200, JSON.stringify(an.data));
  // Fuzz adds harmonics: energy moves above 500 Hz compared with the clean 220 Hz tone.
  const clean = await j('POST', `/api/projects/${p.id}/analyze`, { target: { assetId: a.id }, include: ['spectrum'] });
  assert.ok(an.data.spectrum.bandsRelativeDb.mid > clean.data.spectrum.bandsRelativeDb.mid + 10, JSON.stringify([an.data.spectrum.bandsRelativeDb, clean.data.spectrum.bandsRelativeDb]));
  const js = await fetch(`${BASE}/api/plugins/fuzz.js`);
  assert.equal(js.status, 200);
  const broken = await j('POST', '/api/plugins', { manifest: { ...manifest, id: 'boom' }, code: code.replace(/plugin-fuzz/g, 'plugin-boom').replace('y[i] = (1 - mix)', 'y[i] = 1e9 * (1 - mix)') });
  assert.equal(broken.status, 422, JSON.stringify(broken.data));
  const inUse = await fetch(`${BASE}/api/plugins/fuzz`, { method: 'DELETE' });
  assert.equal(inUse.status, 409);
});

test('a .nyxmix archive carries the custom plugins it uses and installs them on import', async () => {
  const A = await boot({ KLANG_PLUGINS: '1' });
  assert.equal((await A.j('POST', '/api/plugins', { manifest, code })).status, 201);
  const p = (await A.j('POST', '/api/projects', { name: 'Carry fuzz' })).data;
  const f = path.join(dir, 'c.wav');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=220:d=2', f]);
  const a = await (await fetch(`${A.BASE}/api/projects/${p.id}/assets?name=c`, { method: 'POST', body: fs.readFileSync(f) })).json();
  await A.j('POST', `/api/projects/${p.id}/ops`, { ops: [{ op: 'track.add', args: {} }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId: a.id } }, { op: 'effect.add', args: { trackId: '$0.trackId', type: 'plugin:fuzz', params: { drive: 30, mix: 1 } } }] });
  const tar = Buffer.from(await (await fetch(`${A.BASE}/api/projects/${p.id}/archive`)).arrayBuffer());
  assert.ok(tar.includes(Buffer.from('plugins/fuzz.js')) && tar.includes(Buffer.from('plugins/fuzz.json')), 'archive must contain the plugin');

  // A fresh server without the plugin installs it from the archive and renders the same effect.
  const B = await boot({ KLANG_PLUGINS: '1' });
  assert.equal((await B.j('GET', '/api/plugins')).data.plugins.length, 0);
  const imp = await fetch(`${B.BASE}/api/projects/import`, { method: 'POST', body: tar });
  assert.equal(imp.status, 201, await imp.clone().text());
  const r = await imp.json();
  assert.deepEqual(r.plugins.installed, ['fuzz']);
  assert.ok((await B.j('GET', '/api/plugins')).data.plugins.some((m) => m.id === 'fuzz'));
  const an = await B.j('POST', `/api/projects/${r.id}/analyze`, { include: ['spectrum'] });
  const clean = await B.j('POST', `/api/projects/${r.id}/analyze`, { target: { assetId: a.id }, include: ['spectrum'] });
  assert.ok(an.data.spectrum.bandsRelativeDb.mid > clean.data.spectrum.bandsRelativeDb.mid + 10, 'imported plugin must actually run');
  assert.ok(!fs.readdirSync(path.join(dir, `data-${new URL(B.BASE).port}`, 'projects', r.id)).includes('plugins'), 'plugin files are not left inside the project');

  // Importing again where it already exists: recognised as identical, nothing overwritten.
  const again = await (await fetch(`${B.BASE}/api/projects/import`, { method: 'POST', body: tar })).json();
  assert.deepEqual(again.plugins.alreadyInstalled, ['fuzz']);

  // A server with plugins disabled still opens the session and says why the plugin is missing.
  const C = await boot({});
  const off = await (await fetch(`${C.BASE}/api/projects/import`, { method: 'POST', body: tar })).json();
  assert.equal(off.plugins.skipped[0].id, 'fuzz');
  assert.match(off.plugins.skipped[0].reason, /disabled/);

  // A different plugin under the same id is never overwritten.
  const D = await boot({ KLANG_PLUGINS: '1' });
  const other = code.replace('y[i] = (1 - mix)', 'y[i] = 0.5 * (1 - mix)');
  assert.equal((await D.j('POST', '/api/plugins', { manifest, code: other })).status, 201);
  const clash = await (await fetch(`${D.BASE}/api/projects/import`, { method: 'POST', body: tar })).json();
  assert.match(clash.plugins.skipped[0].reason, /different plugin/);
  assert.equal(await (await fetch(`${D.BASE}/api/plugins/fuzz.js`)).text(), other);
});
