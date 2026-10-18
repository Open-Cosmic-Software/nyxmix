// Transcription + text-based editing. Boots its own server (tiny Whisper model) on a
// temp data dir, synthesizes speech with whatever local TTS exists, and edits by text.
import { freePort } from './helpers.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klang-tx-test-'));
const SENTENCE = 'Hello there. Um, the quick brown fox jumps over the lazy dog. Thank you for listening.';

const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
function findPiperVoice() {
  const cands = [process.env.KLANG_TEST_PIPER_VOICE, '/opt/piper-voices', path.join(os.homedir(), '.local/share/piper-voices')].filter(Boolean);
  for (const c of cands) {
    if (c.endsWith('.onnx') && fs.existsSync(c)) return c;
    try { const f = fs.readdirSync(c).find((x) => /^en_.*\.onnx$/.test(x)); if (f) return path.join(c, f); } catch {}
  }
  return null;
}
// Returns a path to a WAV of SENTENCE, or null with a reason.
function synthesize(out) {
  try {
    if (has('espeak-ng')) { execFileSync('espeak-ng', ['-v', 'en-us', '-s', '150', '-w', out, SENTENCE]); return { file: out, tts: 'espeak-ng' }; }
    if (has('espeak')) { execFileSync('espeak', ['-v', 'en-us', '-s', '150', '-w', out, SENTENCE]); return { file: out, tts: 'espeak' }; }
    if (has('pico2wave')) { execFileSync('pico2wave', ['-l', 'en-US', '-w', out, SENTENCE]); return { file: out, tts: 'pico2wave' }; }
    const voice = has('piper') && findPiperVoice();
    if (voice) { execFileSync('piper', ['-m', voice, '-f', out], { input: SENTENCE, stdio: ['pipe', 'ignore', 'ignore'] }); return { file: out, tts: 'piper' }; }
    if (has('flite')) { execFileSync('flite', ['-t', SENTENCE, '-o', out]); return { file: out, tts: 'flite' }; }
  } catch (e) { return { reason: `TTS failed: ${e.message}` }; }
  return { reason: 'no text-to-speech tool found (tried espeak-ng, espeak, pico2wave, piper + voice, flite)' };
}

let skip = null, server, speech;
if (spawnSync('python3', ['-c', 'import faster_whisper']).status !== 0) skip = 'python3 faster_whisper is not importable';
else {
  speech = synthesize(path.join(dir, 'speech.wav'));
  if (!speech.file) skip = speech.reason;
}
if (skip) console.log(`# transcribe tests skipped: ${skip}`);
const t = (name, fn) => test(name, { skip: skip || false, timeout: 600_000 }, fn);

async function j(method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', 'X-Actor': 'agent:test' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
async function mcp(name, args) {
  const r = await j('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return r.data.result;
}
const close = (a, b, eps = 0.002) => Math.abs(a - b) <= eps;
const projectLength = (p) => p.tracks.flatMap((tr) => tr.clips).reduce((n, c) => n + c.duration, 0);

before(async () => {
  if (skip) return;
  server = spawn('node', ['server/index.js'], { env: { ...process.env, PORT, KLANG_DATA: path.join(dir, 'data'), KLANG_WHISPER_MODEL: 'tiny' }, stdio: 'pipe' });
  for (let i = 0; i < 200; i++) {
    try { await fetch(BASE + '/api'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});
after(() => { server?.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

let pid, assetId, trackId, clipId;

t(`transcribe an asset (speech via ${speech?.tts || 'n/a'}, tiny model)`, async () => {
  pid = (await j('POST', '/api/projects', { name: 'Transcript test' })).data.id;
  const res = await fetch(`${BASE}/api/projects/${pid}/assets?name=speech`, { method: 'POST', body: fs.readFileSync(speech.file), headers: { 'Content-Type': 'audio/wav' } });
  assetId = (await res.json()).id;
  const r = await j('POST', `/api/projects/${pid}/ops`, { ops: [
    { op: 'track.add', args: { name: 'Voice' } },
    { op: 'clip.add', args: { trackId: '$0.trackId', assetId, start: 0 } },
  ] });
  trackId = r.data.results[0].trackId; clipId = r.data.results[1].clipId;

  assert.equal((await j('GET', `/api/projects/${pid}/assets/${assetId}/transcript`)).status, 404);
  const tr = await j('POST', `/api/projects/${pid}/assets/${assetId}/transcribe`, { language: 'en' });
  assert.equal(tr.status, 200, JSON.stringify(tr.data));
  assert.equal(tr.data.language, 'en');
  const words = tr.data.segments.flatMap((s) => s.words);
  assert.ok(words.length >= 10, `only ${words.length} words`);
  for (const w of words) assert.ok(w.end >= w.start && typeof w.probability === 'number');
  const text = words.map((w) => w.word).join(' ').toLowerCase();
  assert.match(text, /brown\s+fox/, text);
  assert.ok(fs.existsSync(path.join(dir, 'data', 'projects', pid, 'transcripts', `${assetId}.json`)), 'transcript cached on disk');

  const again = await j('POST', `/api/projects/${pid}/assets/${assetId}/transcribe`, {});
  assert.equal(again.status, 200);
  assert.equal(again.data.cached, true);
  assert.equal((await j('GET', `/api/projects/${pid}/assets/${assetId}/transcript`)).status, 200);
});

t('timeline transcript follows the clip when it moves', async () => {
  const before = (await j('GET', `/api/projects/${pid}/transcript`)).data;
  assert.ok(before.words.length >= 10);
  assert.equal(before.words[0].trackId, trackId);
  assert.equal(before.words[0].clipId, clipId);
  await j('POST', `/api/projects/${pid}/ops/clip.update`, { clipId, start: 2.5 });
  const after = (await j('GET', `/api/projects/${pid}/transcript`)).data;
  assert.equal(after.words.length, before.words.length);
  after.words.forEach((w, i) => assert.ok(close(w.start, before.words[i].start + 2.5), `${w.word}: ${w.start} vs ${before.words[i].start}+2.5`));

  // Trimming the clip drops the words outside it.
  const last = after.words[after.words.length - 1];
  await j('POST', `/api/projects/${pid}/ops/clip.update`, { clipId, duration: last.start - 2.5 - 0.05 });
  const trimmed = (await j('GET', `/api/projects/${pid}/transcript`)).data;
  assert.ok(trimmed.words.length < after.words.length);
  assert.ok(!trimmed.words.some((w) => w.start >= last.start - 1e-6));
  await j('POST', `/api/projects/${pid}/undo`);

  const text = await (await fetch(`${BASE}/api/projects/${pid}/transcript?format=text`)).text();
  assert.match(text, /^\[2\.\d\d–/m, text);
});

t('delete by text cuts exactly the phrase (one undo step)', async () => {
  const tl = (await j('GET', `/api/projects/${pid}/transcript`)).data;
  const p0 = (await j('GET', `/api/projects/${pid}`)).data;
  const idx = tl.words.findIndex((w, i) => /^brown/i.test(w.word) && /^fox/i.test(tl.words[i + 1]?.word || ''));
  assert.ok(idx > 0, 'found "brown fox"');
  const brown = tl.words[idx], fox = tl.words[idx + 1], prev = tl.words[idx - 1], next = tl.words[idx + 2];

  const amb = await j('POST', `/api/projects/${pid}/transcript/delete`, { text: 'the' });
  assert.equal(amb.status, 409, 'phrase occurring twice must be disambiguated');
  assert.match(amb.data.error.message, /occurrence/);
  assert.equal((await j('POST', `/api/projects/${pid}/transcript/delete`, { text: 'purple elephant' })).status, 404);

  const r = await j('POST', `/api/projects/${pid}/transcript/delete`, { text: 'Brown FOX' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.cut.length, 1);
  const span = r.data.cut[0];
  assert.ok(span.start <= brown.start && span.start >= prev.end - 1e-6, `start ${span.start} within [${prev.end}, ${brown.start}]`);
  assert.ok(span.end >= fox.end && span.end <= next.start + 1e-6, `end ${span.end} within [${fox.end}, ${next.start}]`);
  assert.ok(span.end - span.start <= fox.end - brown.start + 0.061, 'padding is at most 30 ms per side');
  assert.match(r.data.label, /brown fox/i);

  const p1 = (await j('GET', `/api/projects/${pid}`)).data;
  assert.ok(close(projectLength(p0) - projectLength(p1), r.data.removedSeconds, 0.003), `removed ${projectLength(p0) - projectLength(p1)} vs ${r.data.removedSeconds}`);
  const tl2 = (await j('GET', `/api/projects/${pid}/transcript`)).data;
  const text2 = tl2.words.map((w) => w.word).join(' ').toLowerCase();
  assert.doesNotMatch(text2, /brown\s+fox/);
  assert.equal(tl2.words.length, tl.words.length - 2);
  // Words before the cut stay put, words after move left by the cut length.
  assert.ok(close(tl2.words[idx - 1].start, prev.start));
  assert.ok(close(tl2.words[idx].start, next.start - r.data.removedSeconds, 0.003), `${tl2.words[idx].word} ${tl2.words[idx].start}`);

  const hist = (await j('GET', `/api/projects/${pid}/history`)).data;
  assert.match(hist.undo[0].label, /from transcript/);
  await j('POST', `/api/projects/${pid}/undo`);
  const back = (await j('GET', `/api/projects/${pid}/transcript`)).data;
  assert.equal(back.words.length, tl.words.length, 'one undo restores the words');
});

t('filler words: detect, then cut in one batch', async () => {
  const det = await j('POST', `/api/projects/${pid}/transcript/filler`, {});
  assert.equal(det.status, 200);
  assert.equal(det.data.applied, false);
  const tl = (await j('GET', `/api/projects/${pid}/transcript`)).data;
  const hasUm = tl.words.some((w) => /^(um|uh|uhm)\W*$/i.test(w.word));
  if (hasUm) assert.ok(det.data.count >= 1, 'the spoken "um" is detected');
  for (const f of det.data.fillers) assert.ok(typeof f.start === 'number' && f.trackId === trackId);

  // A custom list makes the result deterministic regardless of what Whisper heard.
  // Two distinct words Whisper actually wrote (tiny models vary slightly between runs).
  const norm = (w) => w.toLowerCase().replace(/[^\p{L}]/gu, '');
  const counts = new Map();
  for (const w of tl.words) counts.set(norm(w.word), (counts.get(norm(w.word)) || 0) + 1);
  const pick = [...counts].filter(([w, n]) => n === 1 && w.length > 3).map(([w]) => w).slice(0, 2);
  assert.equal(pick.length, 2, `need two unique words in: ${tl.words.map((w) => w.word).join(' ')}`);
  const custom = await j('POST', `/api/projects/${pid}/transcript/filler`, { words: pick, apply: true });
  assert.equal(custom.status, 200, JSON.stringify(custom.data));
  assert.equal(custom.data.count, 2);
  assert.equal(custom.data.applied, true);
  assert.ok(custom.data.cut.length >= 1 && custom.data.cut.length <= 2, 'adjacent words merge into one cut');
  const after = (await j('GET', `/api/projects/${pid}/transcript`)).data.words.map((w) => w.word.toLowerCase());
  assert.ok(!after.some((w) => pick.includes(norm(w))), after.join(' '));
  const hist = (await j('GET', `/api/projects/${pid}/history`)).data;
  assert.match(hist.undo[0].label, /Removed 2 passages|Removed/);
  await j('POST', `/api/projects/${pid}/undo`);
});

t('MCP tools: get_transcript text and cut_transcript', async () => {
  const list = await j('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = list.data.result.tools.map((x) => x.name);
  for (const n of ['transcribe', 'get_transcript', 'cut_transcript', 'remove_filler_words']) assert.ok(names.includes(n), n);

  const done = await mcp('transcribe', { projectId: pid });
  assert.match(done.content[0].text, /already has a transcript/);
  const txt = await mcp('get_transcript', { projectId: pid });
  assert.match(txt.content[0].text, /\[\d+\.\d\d–\d+\.\d\d\] \S+/);
  const words = JSON.parse((await mcp('get_transcript', { projectId: pid, format: 'words' })).content[0].text);
  assert.ok(words.words.length >= 10);
  // Cut two neighbouring words that occur once (whatever the tiny model heard this run).
  const norm = (w) => w.toLowerCase().replace(/[^\p{L}]/gu, '');
  const counts = new Map(); for (const w of words.words) counts.set(norm(w.word), (counts.get(norm(w.word)) || 0) + 1);
  const i = words.words.findIndex((w, k) => k > 0 && k < words.words.length - 1 && counts.get(norm(w.word)) === 1 && counts.get(norm(words.words[k + 1].word)) === 1 && norm(w.word).length > 2);
  assert.ok(i > 0, 'two unique neighbouring words');
  const phrase = `${words.words[i].word} ${words.words[i + 1].word}`;
  const cut = await mcp('cut_transcript', { projectId: pid, text: phrase });
  assert.ok(!cut.isError, cut.content[0].text);
  assert.equal(JSON.parse(cut.content[0].text).cut.length, 1);
  const err = await mcp('cut_transcript', { projectId: pid });
  assert.equal(err.isError, true);
});

// Regression: German "um" is a preposition, not a filler.
const deVoice = fs.existsSync('/opt/piper-voices/de_DE-thorsten-medium.onnx') ? '/opt/piper-voices/de_DE-thorsten-medium.onnx' : null;
test('German "um" is not treated as a filler, "ähm" is', { skip: skip || (!deVoice && 'no German piper voice'), timeout: 600_000 }, async () => {
  const f = path.join(dir, 'de.wav');
  execFileSync('piper', ['-m', deVoice, '-f', f], { input: 'Heute geht es um ein Thema. Ähm, das ist wichtig.', stdio: ['pipe', 'ignore', 'ignore'] });
  const p = (await j('POST', '/api/projects', { name: 'DE' })).data.id;
  const a = await (await fetch(`${BASE}/api/projects/${p}/assets?name=de`, { method: 'POST', body: fs.readFileSync(f) })).json();
  await j('POST', `/api/projects/${p}/ops`, { ops: [{ op: 'track.add', args: {} }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId: a.id } }] });
  const tr = await j('POST', `/api/projects/${p}/assets/${a.id}/transcribe`, { language: 'de' });
  assert.equal(tr.status, 200, JSON.stringify(tr.data).slice(0, 300));
  const r = await j('POST', `/api/projects/${p}/transcript/filler`, {});
  const words = r.data.fillers.map((w) => w.word.toLowerCase().replace(/[^\p{L}]/gu, ''));
  assert.ok(!words.includes('um'), `German "um" flagged: ${JSON.stringify(words)}`);
  assert.ok(r.data.matchedWords.includes('ähm'));
});

test('transcript cuts leave a music track uncut', { skip: skip || false, timeout: 600_000 }, async () => {
  const p = (await j('POST', '/api/projects', { name: 'Bed' })).data.id;
  const up = async (f, n) => (await fetch(`${BASE}/api/projects/${p}/assets?name=${n}`, { method: 'POST', body: fs.readFileSync(f) })).json();
  const v = await up(speech.file, 'voice');
  const mf = path.join(dir, 'bed.wav');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=300:d=12', mf]);
  const m = await up(mf, 'bed');
  await j('POST', `/api/projects/${p}/ops`, { ops: [{ op: 'track.add', args: {} }, { op: 'track.add', args: {} }, { op: 'clip.add', args: { trackId: '$0.trackId', assetId: v.id } }, { op: 'clip.add', args: { trackId: '$1.trackId', assetId: m.id } }] });
  await j('POST', `/api/projects/${p}/assets/${v.id}/transcribe`, {});
  const r = await j('POST', `/api/projects/${p}/transcript/delete`, { text: 'quick brown fox' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const proj = (await j('GET', `/api/projects/${p}`)).data;
  assert.equal(proj.tracks[0].clips.length, 2, 'voice is cut');
  assert.equal(proj.tracks[1].clips.length, 1, 'music bed stays whole');
});
