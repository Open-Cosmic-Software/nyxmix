// CD layout (Audition: CD Layout): export a Red Book–ready image — 44.1 kHz / 16-bit stereo
// WAV plus a CUE sheet where every labelled marker starts a track (CD frames: 75 per second).
import fs from 'node:fs/promises';
import path from 'node:path';
import { newId } from '../ops.js';
import { renderMix, writeWav, run } from '../audio.js';
import { projectEnd } from '../../public/js/engine/graph.js';

const cueTime = (sec) => { const f = Math.round(sec * 75); return `${String(Math.floor(f / 4500)).padStart(2, '0')}:${String(Math.floor(f / 75) % 60).padStart(2, '0')}:${String(f % 75).padStart(2, '0')}`; };
const cueText = (s) => String(s).replace(/["\r\n]/g, "'").slice(0, 80);

export async function register({ api, json, wrap, store, mcpTools, actorOf, OpError }) {
  async function exportCd(pid, { performer } = {}, actor) {
    const p = store.get(pid);
    const end = projectEnd(p);
    if (!(end > 0)) throw new OpError('The timeline is empty', 'empty', 422);
    if (end > 79.8 * 60) throw new OpError(`Too long for a CD: ${(end / 60).toFixed(1)} min (max ~79.8)`, 'too_long', 422);
    // Track starts: 0 plus every labelled marker, snapped to CD frames; at least 4 s apart (Red Book).
    const starts = [{ time: 0, title: p.markers.find((m) => m.time < 0.5 && m.label)?.label || p.name }];
    for (const m of [...p.markers].sort((a, b) => a.time - b.time)) {
      if (!m.label || m.time < 0.5) continue;
      if (m.time - starts[starts.length - 1].time < 4) continue;
      starts.push({ time: Math.round(m.time * 75) / 75, title: m.label });
    }
    if (starts.length > 99) throw new OpError('A CD holds at most 99 tracks', 'too_many', 422);
    const dir = store.rendersDir(pid);
    await fs.mkdir(dir, { recursive: true });
    const id = newId('rnd');
    const mix = await renderMix(p, (aid) => store.assetPath(pid, aid), { start: 0, end });
    const tmp = path.join(dir, `${id}.f32.wav`);
    await writeWav(tmp, mix.channels.slice(0, 2), mix.sampleRate);
    const wav = `${id}.wav`;
    try {
      await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-i', tmp, '-af', 'aresample=44100:resampler=soxr:dither_method=triangular', '-ac', '2', '-c:a', 'pcm_s16le', path.join(dir, wav)]);
    } finally { await fs.rm(tmp, { force: true }); }
    const lines = [`PERFORMER "${cueText(performer || p.metadata?.artist || '')}"`, `TITLE "${cueText(p.metadata?.album || p.name)}"`, `FILE "${p.name.replace(/[^\w .-]+/g, '_')}.wav" WAVE`];
    starts.forEach((s, i) => lines.push(`  TRACK ${String(i + 1).padStart(2, '0')} AUDIO`, `    TITLE "${cueText(s.title)}"`, `    INDEX 01 ${cueTime(s.time)}`));
    const cue = `${id}.cue`;
    await fs.writeFile(path.join(dir, cue), lines.join('\r\n') + '\r\n');
    const base = `/api/projects/${pid}/renders/`;
    const meta = { id, format: 'cd', name: p.name, tracks: starts.map((s, i) => ({ number: i + 1, start: s.time, title: s.title })), wav: { file: wav, url: base + wav }, cue: { file: cue, url: base + cue }, createdAt: new Date().toISOString(), createdBy: actor };
    await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify({ ...meta, file: wav, url: base + wav, bytes: (await fs.stat(path.join(dir, wav))).size }));
    store.log(pid, { actor, label: `Exported a CD image with ${starts.length} track${starts.length > 1 ? 's' : ''}` });
    return meta;
  }
  api.post('/projects/:id/cd', json, wrap(async (req, res) => res.status(201).json(await exportCd(req.params.id, req.body || {}, actorOf(req)))));
  mcpTools.push({
    name: 'export_cd',
    description: 'Export a CD image (Audition: CD Layout): 44.1 kHz/16-bit dithered WAV plus a CUE sheet. Every labelled marker starts a CD track (titles from labels, min 4 s apart, up to 99). Burn the .cue with any burning program.',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, performer: { type: 'string' } }, required: ['projectId'] },
    handler: ({ projectId, ...b }, actor) => exportCd(projectId, b, actor),
  });
}
