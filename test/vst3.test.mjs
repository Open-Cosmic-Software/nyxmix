// Native VST3 hosting (Linux builds via pedalboard/JUCE): VST3 effects share the plugin
// catalog, REST and MCP tools with LV2, and run as destructive processes on assets.
import { freePort } from './helpers.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klang-vst3-'));
let server, BASE, catalog, pid, lowHigh, monoTone;
const j = async (method, url, body) => {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const buf = Buffer.from(await r.arrayBuffer());
  let data = null; try { data = JSON.parse(buf.toString()); } catch {}
  return { status: r.status, data, buf };
};
async function upload(name, lavfi) {
  const f = path.join(dir, `${name}.wav`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', lavfi, '-c:a', 'pcm_f32le', f]);
  return (await fetch(`${BASE}/api/projects/${pid}/assets?name=${name}`, { method: 'POST', body: fs.readFileSync(f) })).json();
}
const analyze = async (target, include = ['levels', 'spectrum']) => {
  const r = await j('POST', `/api/projects/${pid}/analyze`, { target, include });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};
const plugin = (name) => { const p = catalog.plugins.find((x) => x.format === 'vst3' && x.name === name); assert.ok(p, `VST3 ${name} missing`); return p; };
const hasVst3 = fs.existsSync('/usr/lib/vst3/lsp-plugins.vst3') && fs.existsSync('/usr/lib/vst3/ZamComp.vst3');

before(async () => {
  const PORT = await freePort();
  server = spawn('node', ['server/index.js'], { env: { ...process.env, PORT, KLANG_DATA: path.join(dir, 'data') }, stdio: 'pipe' });
  BASE = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 200; i++) { try { await fetch(BASE + '/api'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  catalog = (await j('GET', '/api/lv2?format=vst3')).data;
  pid = (await j('POST', '/api/projects', { name: 'VST3' })).data.id;
  lowHigh = await upload('lowhigh', 'aevalsrc=exprs=0.3*sin(2*PI*200*t)+0.3*sin(2*PI*6000*t)|0.3*sin(2*PI*200*t)+0.3*sin(2*PI*6000*t):s=48000:d=3');
  monoTone = await upload('mono', 'aevalsrc=exprs=0.3*sin(2*PI*100*t)+0.3*sin(2*PI*3000*t):s=48000:d=3');
});
after(() => { server?.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('catalog hosts VST3 effects next to LV2', { skip: !hasVst3 && 'no VST3 bundles installed' }, async () => {
  assert.ok(catalog.formats.vst3 >= 80, `only ${catalog.formats.vst3} VST3 effects`);
  assert.ok(catalog.plugins.every((p) => p.format === 'vst3'));
  for (const b of ['LSP', 'ZAM', 'Dragonfly']) assert.ok(catalog.brands[b] > 0, `no ${b}`);
  for (const c of ['EQ', 'Compressor', 'Limiter', 'Gate', 'Reverb']) assert.ok(catalog.categories[c] > 0, `no ${c}`);
  const d = await j('GET', `/api/lv2/${plugin('Filter Stereo').index}`);
  const type = d.data.params.find((p) => p.symbol === 'filter_type');
  assert.equal(type.enum.find((e) => e.label === 'Hi-pass').value, 1);
  assert.ok(d.data.params.find((p) => p.symbol === 'frequency_hz').log);
});

test('LSP Filter (VST3) low-pass removes the highs and swaps into clips', { skip: !hasVst3 }, async () => {
  await j('POST', `/api/projects/${pid}/ops`, { ops: [{ op: 'track.add', args: {} }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId: lowHigh.id } }] });
  const before = await analyze({ assetId: lowHigh.id });
  const r = await j('POST', `/api/projects/${pid}/assets/${lowHigh.id}/lv2`, { uri: plugin('Filter Stereo').uri, controls: { filter_type: 0, frequency_hz: 1000, filter_slope: 3 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.clipsUpdated, 1);
  assert.equal(r.data.asset.channels, 2);
  assert.ok(Math.abs(r.data.asset.duration - 3) < 0.01);
  const after = await analyze({ assetId: r.data.asset.id });
  const drop = before.spectrum.bandsRelativeDb.brilliance - after.spectrum.bandsRelativeDb.brilliance;
  assert.ok(drop > 25, `6 kHz only dropped ${drop} dB`);
  const p = (await j('GET', `/api/projects/${pid}`)).data;
  assert.equal(p.assets.find((a) => a.id === r.data.asset.id).process.kind, 'vst3');
});

test('a mono-only VST3 (ZamComp) runs per channel; mono assets stay mono', { skip: !hasVst3 }, async () => {
  const zc = plugin('ZamComp');
  assert.equal(zc.channels.in, 1);
  const r = await j('POST', `/api/projects/${pid}/assets/${monoTone.id}/lv2`, { uri: zc.uri, controls: { threshold_db: -30, ratio: 10 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.asset.channels, 1);
  const s = await j('POST', `/api/projects/${pid}/assets/${lowHigh.id}/lv2`, { uri: zc.uri, controls: { threshold_db: -30, ratio: 10 } });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.equal(s.data.asset.channels, 2);
  const a = await analyze({ assetId: lowHigh.id, start: 1 }, ['levels']), b = await analyze({ assetId: s.data.asset.id, start: 1 }, ['levels']);
  assert.ok(a.levels.rmsDbfs - b.levels.rmsDbfs > 6, `compression only ${a.levels.rmsDbfs - b.levels.rmsDbfs} dB`);
});

test('look-ahead limiter (VST3) is latency compensated', { skip: !hasVst3 }, async () => {
  const loud = await upload('loud', 'aevalsrc=exprs=0.9*sin(2*PI*220*t)|0.9*sin(2*PI*220*t):s=48000:d=2');
  const r = await j('POST', `/api/projects/${pid}/assets/${loud.id}/lv2`, { uri: plugin('Limiter Stereo').uri, controls: { threshold_db: -12, lookahead_ms: 10, gain_boost: 0 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const after = await analyze({ assetId: r.data.asset.id, start: 0.3 }, ['levels']);
  assert.ok(after.levels.samplePeakDbfs < -11, `peak ${after.levels.samplePeakDbfs} dBFS`);
  const head = await analyze({ assetId: r.data.asset.id, start: 0, end: 0.004 }, ['levels']);
  assert.ok(head.levels.samplePeakDbfs > -30, `onset delayed by look-ahead: ${head.levels.samplePeakDbfs} dBFS`);
});

test('VST3 controls are validated; enums take their listed indices', { skip: !hasVst3 }, async () => {
  const f = plugin('Filter Stereo').uri, url = `/api/projects/${pid}/assets/${monoTone.id}/lv2`;
  for (const body of [{ uri: f, controls: { frequency_hz: 99999 } }, { uri: f, controls: { filter_type: 99 } }, { uri: f, controls: { filter_type: 'Hi-pass' } }, { uri: f, controls: { nope: 1 } }, { uri: 'vst3:/etc/passwd#x' }]) {
    const r = await j('POST', url, body);
    assert.equal(r.status, 400, `${JSON.stringify(body)} → ${r.status}`);
  }
});

test('MCP lists VST3 plugins by format and applies one', { skip: !hasVst3 }, async () => {
  const mcp = async (name, args) => (await j('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).data;
  const list = (await mcp('list_lv2_plugins', { format: 'vst3', category: 'Reverb' })).result.content[0].text;
  assert.match(list, /\(VST3, Dragonfly/);
  const ok = await mcp('apply_lv2_plugin', { projectId: pid, assetId: monoTone.id, uri: plugin('Dragonfly Room Reverb').uri });
  assert.ok(!ok.result.isError, JSON.stringify(ok));
});
