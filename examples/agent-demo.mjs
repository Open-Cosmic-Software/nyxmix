// An agent producing a podcast episode in NyxMix, using nothing but MCP.
// Usage: node examples/agent-demo.mjs [http://127.0.0.1:3950]
// Generates a rough German "recording" (TTS + hum + hiss + fillers + long pauses)
// and a music bed, then cleans, mixes and masters it the way an agent would.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:3950';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klang-demo-'));
const sh = (cmd, args, input) => execFileSync(cmd, args, { input, stdio: ['pipe', 'pipe', 'pipe'] });

// ── 1. A rough recording ────────────────────────────────────────────────
const lines = [
  'Hallo und herzlich willkommen zu einer neuen Folge.',
  'Ähm, heute geht es um ein Thema, das mich, ähm, schon lange beschäftigt.',
  'Wie klingt eigentlich ein guter Podcast?',
  'Also, ähm, die wichtigste Regel ist: Die Stimme muss klar sein.',
  'Danke fürs Zuhören, bis zum nächsten Mal.',
];
const parts = [];
lines.forEach((t, i) => {
  const f = path.join(tmp, `l${i}.wav`);
  sh('piper', ['-m', '/opt/piper-voices/de_DE-thorsten-medium.onnx', '-f', f, '--sentence-silence', '0.2'], t);
  parts.push(f);
  const gap = path.join(tmp, `g${i}.wav`);
  sh('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `anullsrc=r=22050:cl=mono:d=${[1.8, 0.4, 2.6, 0.5, 0.1][i]}`, gap]);
  parts.push(gap);
});
const list = path.join(tmp, 'list.txt');
fs.writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
const voice = path.join(tmp, 'aufnahme.wav');
sh('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
  '-f', 'lavfi', '-i', 'anoisesrc=c=pink:a=0.012:d=60', '-f', 'lavfi', '-i', 'sine=f=50:d=60',
  '-filter_complex', '[0]volume=0.6[v];[2]volume=0.02[h];[v][1][h]amix=3:duration=first:normalize=0', '-ar', '44100', voice]);
const music = path.join(tmp, 'musik.wav');
sh('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=220:d=40', '-f', 'lavfi', '-i', 'sine=f=277:d=40', '-f', 'lavfi', '-i', 'sine=f=330:d=40',
  '-filter_complex', 'amix=3,volume=2,tremolo=f=2:d=0.4,aecho=0.8:0.6:300:0.3', '-ac', '2', music]);

// ── 2. MCP client ───────────────────────────────────────────────────────
let sid, id = 0;
async function rpc(method, params) {
  const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(sid ? { 'Mcp-Session-Id': sid } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  sid ||= res.headers.get('mcp-session-id');
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
async function tool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = r.content.find((c) => c.type === 'text')?.text;
  if (r.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}
const say = (s) => console.log(`\n▸ ${s}`);

await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude' }, capabilities: {} });
const { tools } = await rpc('tools/list', {});
say(`Connected: ${tools.length} tools`);

const p = await tool('create_project', { name: 'Folge 12: Wie klingt ein guter Podcast?' });
const pid = p.id;
console.log(`  ${BASE}/#/p/${pid}`);
const b64 = (f) => fs.readFileSync(f).toString('base64');
const va = await tool('import_audio', { projectId: pid, base64: b64(voice), name: 'Aufnahme Host' });
const ma = await tool('import_audio', { projectId: pid, base64: b64(music), name: 'Intro-Musik' });

say('Arrange: voice on a track, music bed under it');
const arr = await tool('edit', { projectId: pid, label: 'Grundgerüst angelegt', ops: [
  { op: 'track.add', args: { name: 'Host' } },
  { op: 'track.add', args: { name: 'Musik' } },
  { op: 'clip.add', args: { trackId: '$0.trackId', assetId: va.id, start: 3 } },
  { op: 'clip.add', args: { trackId: '$1.trackId', assetId: ma.id, start: 0, fadeIn: 1.5 } },
] });
const [hostId, musicId] = [arr.results[0].trackId, arr.results[1].trackId];

say('Listen: measure the raw recording');
const raw = await tool('analyze', { projectId: pid, target: { assetId: va.id }, include: ['loudness', 'spectrum'] });
console.log(`  ${raw.loudness.integratedLufs} LUFS, bands: ${JSON.stringify(raw.spectrum.bandsRelativeDb)}`);

say('Restore: hum, then the AI voice cleanup');
await tool('process_audio', { projectId: pid, assetId: va.id, kind: 'dehum', params: { frequency: 50, harmonics: 4 } });
let cur = (await tool('get_project', { projectId: pid, format: 'json' })).tracks[0].clips[0].assetId;
await tool('process_audio', { projectId: pid, assetId: cur, kind: 'voiceDenoise', params: { mix: 0.9 } });

say('Edit by text: transcribe, remove filler words');
await tool('transcribe', { projectId: pid, language: 'de' });
console.log((await tool('get_transcript', { projectId: pid, format: 'text' })).toString().split('\n').slice(0, 6).map((l) => '  ' + l).join('\n'));
const fill = await tool('remove_filler_words', { projectId: pid, apply: true });
console.log(`  removed ${fill.cut?.length ?? fill.removed ?? JSON.stringify(fill).slice(0, 80)} fillers`);

say('Tighten long pauses on the voice track');
const an = await tool('analyze', { projectId: pid, include: ['silences'], minSilence: 1.2, silenceThresholdDb: -45 });
const pauses = (an.silencesTimeline || []).filter((s) => s.start > 3.5 && s.end < 60);
const cuts = pauses.sort((a, b) => b.start - a.start).map((s) => ({ op: 'range.delete', args: { start: +(s.start + 0.35).toFixed(3), end: +(s.end - 0.35).toFixed(3), trackIds: [hostId] } }));
if (cuts.length) await tool('edit', { projectId: pid, label: `${cuts.length} lange Pausen gekürzt`, ops: cuts });

say('Mix: voice preset, master preset, duck the music');
await tool('preset_apply', { projectId: pid, trackId: hostId, preset: 'podcast-voice' });
await tool('preset_apply', { projectId: pid, preset: 'master-podcast' });
const d = await tool('auto_duck', { projectId: pid, musicTrackId: musicId, amount: -16 });
console.log(`  ducked under ${d.speechRegions.length} speech passages`);
const end = (await tool('get_project', { projectId: pid, format: 'json' })).tracks[0].clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
const mclip = (await tool('get_project', { projectId: pid, format: 'json' })).tracks[1].clips[0];
await tool('clip_update', { projectId: pid, clipId: mclip.id, duration: Math.min(mclip.duration, end + 2.5), fadeOut: 3 });

say('Leave a note and propose a judgement call instead of just doing it');
await tool('marker_add', { projectId: pid, time: 3, label: 'Einstieg prüfen: Musik vielleicht 1 s früher ausblenden?' });
await tool('propose_edits', { projectId: pid, label: 'Intro-Musik 1 Sekunde kürzer', rationale: 'Die Stimme setzt bei 3 s ein; mit 2 s Vorlauf kommt man schneller zum Punkt.', ops: [{ op: 'range.delete', args: { start: 0, end: 1 } }] });

say('Master check and export');
const mix = await tool('analyze', { projectId: pid, include: ['loudness', 'levels'] });
console.log(`  mix before export: ${mix.loudness.integratedLufs} LUFS, true peak ${mix.loudness.truePeakDbtp} dBTP`);
const out = await tool('render', { projectId: pid, format: 'mp3', bitrate: 192, loudness: { lufs: -16, truePeak: -1 } });
console.log(`  ${out.url}\n  ${out.loudness.integratedLufs} LUFS, true peak ${out.loudness.truePeakDbtp} dBTP`);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nOpen the session: ${BASE}/#/p/${pid}`);
