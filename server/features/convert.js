// Convert a session to another sample rate (Audition: Convert Sample Type), resampling
// every file with SoX's high-quality resampler. Times stay the same, so the edit is intact.
import fs from 'node:fs/promises';
import { run, writePeaks, writePreview } from '../audio.js';
import { validate } from '../validate.js';

export async function register({ api, json, wrap, store, mcpTools, actorOf, OpError }) {
  const busy = new Set();
  async function convert(pid, { sampleRate }, actor) {
    validate({ type: 'object', required: ['sampleRate'], properties: { sampleRate: { type: 'integer', enum: [44100, 48000, 88200, 96000] } } }, { sampleRate });
    const p = store.get(pid);
    if (p.sampleRate === sampleRate) return { sampleRate, converted: 0 };
    if (busy.has(pid)) throw new OpError('A conversion is already running for this session', 'busy', 409);
    busy.add(pid);
    const jobId = `job_sr_${pid}`;
    store.notify(pid, { type: 'job', jobId, status: 'running', label: `Converting to ${sampleRate / 1000} kHz`, actor });
    const done = [];
    try {
      // Resample to temp files first; swap only when every file succeeded.
      for (const a of p.assets) {
        const src = store.assetPath(pid, a.id), tmp = `${src}.${sampleRate}.wav`;
        await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-i', src, '-af', `aresample=${sampleRate}:resampler=soxr:precision=28`, '-c:a', 'pcm_f32le', '-bitexact', tmp], { timeoutMs: 60 * 60_000 });
        done.push([a, src, tmp]);
      }
      for (const [a, src, tmp] of done) {
        await fs.rename(tmp, src);
        const { peak } = await writePeaks(src, store.peaksPath(pid, a.id));
        await fs.rm(store.previewPath(pid, a.id), { force: true });
        if (peak <= 1) await writePreview(src, store.previewPath(pid, a.id)).catch(() => {});
        a.sampleRate = sampleRate;
      }
      const from = p.sampleRate;
      p.sampleRate = sampleRate;
      p.rev++; p.updatedAt = new Date().toISOString();
      store.changed(pid, store.log(pid, { actor, label: `Converted session from ${from / 1000} to ${sampleRate / 1000} kHz` }));
      store.notify(pid, { type: 'job', jobId, status: 'done', label: `Converted to ${sampleRate / 1000} kHz`, actor });
      return { sampleRate, converted: done.length };
    } catch (err) {
      for (const [, , tmp] of done) await fs.rm(tmp, { force: true });
      store.notify(pid, { type: 'job', jobId, status: 'failed', label: 'Sample-rate conversion', error: err.message, actor });
      throw err;
    } finally { busy.delete(pid); }
  }
  api.post('/projects/:id/sample-rate', json, wrap(async (req, res) => res.json(await convert(req.params.id, req.body || {}, actorOf(req)))));
  mcpTools.push({
    name: 'convert_sample_rate',
    description: 'Change the session sample rate (44100, 48000, 88200, 96000): every file is resampled with SoX (high quality); clip times and the arrangement stay the same. Not undoable — save_version first if unsure.',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, sampleRate: { type: 'integer', enum: [44100, 48000, 88200, 96000] } }, required: ['projectId', 'sampleRate'] },
    handler: ({ projectId, sampleRate }, actor) => convert(projectId, { sampleRate }, actor),
  });
}
