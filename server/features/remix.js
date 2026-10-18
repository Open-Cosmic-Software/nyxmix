// Music remix: fit a music clip to a target length by jumping between musically similar
// beats (Audition's "Remix"), placed as ordinary clips with crossfades so every jump stays editable.
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { run } from '../audio.js';
import { findClip } from '../ops.js';
import { validate } from '../validate.js';

const SCRIPT = fileURLToPath(new URL('../remix.py', import.meta.url));
const VENV = fileURLToPath(new URL('../../.venv/bin/python', import.meta.url));
const XF = 0.04;

export async function register({ api, json, wrap, store, mcpTools, actorOf, OpError }) {
  async function remix(pid, clipId, { duration }, actor) {
    validate({ type: 'object', required: ['duration'], properties: { duration: { type: 'number', minimum: 5, maximum: 3600 } } }, { duration });
    const p = store.get(pid);
    const { track, clip } = findClip(p, clipId);
    const jobId = `job_remix_${clipId}`;
    store.notify(pid, { type: 'job', jobId, status: 'running', label: `Remixing “${clip.name}” to ${duration.toFixed(1)} s`, actor });
    let res;
    try {
      const { stdout } = await run(existsSync(VENV) ? VENV : 'python3', [SCRIPT, store.assetPath(pid, clip.assetId), String(clip.offset), String(clip.offset + clip.duration), String(duration)], { timeoutMs: 10 * 60_000 })
        .catch((err) => { const m = /\{"error": "([^"]+)"\}/.exec(err.message); throw new OpError(m ? m[1] : err.message, 'remix_failed', 422); });
      res = JSON.parse(stdout.toString().trim().split('\n').pop());
    } catch (err) {
      store.notify(pid, { type: 'job', jobId, status: 'failed', label: `Remixing “${clip.name}”`, error: err.message, actor });
      throw err;
    }
    const segs = res.segments;
    const ops = [{ op: 'clip.remove', args: { clipId } }];
    let pos = clip.start;
    segs.forEach(([a, b], k) => {
      const pre = k > 0 ? XF / 2 : 0, post = k < segs.length - 1 ? XF / 2 : 0;
      ops.push({ op: 'clip.add', args: {
        trackId: track.id, assetId: clip.assetId, name: clip.name, gain: clip.gain,
        start: +(pos - pre).toFixed(6), offset: +(a - pre).toFixed(6), duration: +((b - a) + pre + post).toFixed(6),
        ...(k === 0 && clip.fadeIn ? { fadeIn: clip.fadeIn, fadeInShape: clip.fadeInShape } : {}),
        ...(k === segs.length - 1 && clip.fadeOut ? { fadeOut: clip.fadeOut, fadeOutShape: clip.fadeOutShape } : {}),
      } });
      pos += b - a;
    });
    const r = store.apply(pid, ops, { actor, label: `Remixed “${clip.name}” to ${res.achieved.toFixed(1)} s (${res.jumps} jump${res.jumps === 1 ? '' : 's'})` });
    store.notify(pid, { type: 'job', jobId, status: 'done', label: `Remixed “${clip.name}” to ${res.achieved.toFixed(1)} s`, actor });
    return { rev: r.rev, achievedSeconds: +res.achieved.toFixed(3), jumps: res.jumps, tempoBpm: res.tempo && +res.tempo.toFixed(1), clipIds: r.results.slice(1).map((x) => x.clipId), segments: segs };
  }

  api.post('/projects/:id/clips/:clipId/remix', json, wrap(async (req, res) => res.json(await remix(req.params.id, req.params.clipId, req.body || {}, actorOf(req)))));
  mcpTools.push({
    name: 'remix_music',
    description: 'Make a music clip fit a target length by jumping between musically similar beats (like Audition\'s Remix) instead of stretching: tempo and pitch stay untouched. Result is ordinary clips with crossfades at the jumps (one undo step), so a human can adjust them. Typical use: fit a bed to an episode or a 30 s ad. Returns the achieved length (within about a beat of the target).',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, clipId: { type: 'string' }, duration: { type: 'number', description: 'Target length in seconds' } }, required: ['projectId', 'clipId', 'duration'] },
    handler: ({ projectId, clipId, duration }, actor) => remix(projectId, clipId, { duration }, actor),
  });
}
