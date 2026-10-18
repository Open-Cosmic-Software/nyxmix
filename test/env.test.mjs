import { freePort } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('npx nyxmix: NYXMIX_TOKEN and --data are honoured', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyxmix-bin-'));
  const PORT = await freePort();
  const s = spawn('node', ['bin/nyxmix.js', '--port', String(PORT), '--data', path.join(dir, 'd')], { env: { ...process.env, NYXMIX_TOKEN: 'tok', KLANG_TOKEN: '' }, stdio: 'pipe' });
  try {
    const BASE = `http://127.0.0.1:${PORT}`;
    for (let i = 0; i < 200; i++) { try { await fetch(BASE + '/api'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    assert.equal((await fetch(BASE + '/api/projects')).status, 401);
    const ok = await fetch(BASE + '/api/projects', { method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: '{"name":"x"}' });
    assert.equal(ok.status, 201);
    assert.ok(fs.existsSync(path.join(dir, 'd', 'projects')));
  } finally { s.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('nyxmix --help exits cleanly', async () => {
  const s = spawn('node', ['bin/nyxmix.js', '--help'], { stdio: 'pipe' });
  let out = ''; s.stdout.on('data', (d) => (out += d));
  const code = await new Promise((r) => s.on('exit', r));
  assert.equal(code, 0); assert.match(out, /npx nyxmix/);
});
