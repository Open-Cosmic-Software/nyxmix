// Standards-based conformance suite: EBU Tech 3341 / 3342 loudness, ITU-R BS.1770-4 true peak,
// null tests, sample-rate conversion, export quantisation and dither. The signals, measurements
// and tolerances live in conformance-report.mjs (shared with the markdown report generator);
// every tolerance comes from the cited standard. A failing check here is a real finding — its
// root cause is documented next to the check and in docs/conformance.md. Do not loosen them.
import { freePort } from './helpers.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHECKS } from './conformance-report.mjs';

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klang-conformance-'));
const env = { base: BASE, dir, data: path.join(dir, 'data') };
let server;

before(async () => {
  server = spawn('node', ['server/index.js'], { env: { ...process.env, PORT, KLANG_DATA: env.data }, stdio: 'pipe' });
  server.stdout.resume(); server.stderr.resume();
  for (let i = 0; i < 300; i++) { try { await fetch(BASE + '/api'); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  throw new Error('server did not start');
});
after(() => { server.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

for (const c of CHECKS) {
  test(`[${c.standard}] ${c.metric}`, { timeout: 5 * 60_000 }, async (t) => {
    const r = await c.run(env);
    if (r.skip) return t.skip(r.skip);
    assert.ok(r.pass, `measured ${r.measured}; required ${c.tolerance}${c.why ? `\n${c.why}` : ''}`);
  });
}
