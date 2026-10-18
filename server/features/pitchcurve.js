// Manual pitch correction: shift a voice by a hand-drawn curve (cents over time), WORLD vocoder.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { run, readWav, writeWav } from '../audio.js';
import { newId } from '../ops.js';
import { validate } from '../validate.js';

const SCRIPT = fileURLToPath(new URL('../pitchcorrect.py', import.meta.url));
const VENV = fileURLToPath(new URL('../../.venv/bin/python', import.meta.url));
const schema = { type: 'object', required: ['points'], properties: {
  points: { type: 'array', items: { type: 'object', required: ['time', 'cents'], properties: { time: { type: 'number', minimum: 0 }, cents: { type: 'number', minimum: -1200, maximum: 1200 } } } },
  replaceInClips: { type: 'boolean' },
} };

export async function register({ api, json, wrap, store, actions, mcpTools, actorOf, OpError }) {
  async function apply(pid, assetId, body, actor) {
    validate(schema, body);
    const p = store.get(pid);
    const asset = p.assets.find((a) => a.id === assetId);
    if (!asset) throw new OpError(`Asset ${assetId} not found`, 'not_found', 404);
    const pts = [...body.points].sort((a, b) => a.time - b.time);
    if (!pts.length) throw new OpError('Give at least one point', 'invalid_args', 400);
    // Only the span the curve covers (plus a margin) is resynthesised; the rest stays bit-identical.
    const s0 = Math.max(0, pts[0].time - 0.3), s1 = Math.min(asset.duration, pts[pts.length - 1].time + 0.3);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'klang-pc-'));
    try {
      const full = await readWav(store.assetPath(pid, assetId));
      const a = Math.floor(s0 * full.sampleRate), b = Math.ceil(s1 * full.sampleRate);
      await writeWav(path.join(tmp, 'in.wav'), full.channels.map((c) => c.slice(a, b)), full.sampleRate);
      await fs.writeFile(path.join(tmp, 'curve.json'), JSON.stringify(pts.map((x) => [x.time - s0, x.cents])));
      await run(existsSync(VENV) ? VENV : 'python3', [SCRIPT, path.join(tmp, 'in.wav'), path.join(tmp, 'out.wav'), '--curve', path.join(tmp, 'curve.json')], { timeoutMs: 30 * 60_000 });
      const seg = await readWav(path.join(tmp, 'out.wav'));
      const xf = Math.round(0.01 * full.sampleRate);
      const out = full.channels.map((c, ci) => {
        const o = Float32Array.from(c), pc = seg.channels[Math.min(ci, seg.channels.length - 1)];
        for (let i = a; i < Math.min(b, a + pc.length); i++) { const w = Math.min(1, (i - a) / xf, (b - 1 - i) / xf); o[i] = (1 - w) * c[i] + w * pc[i - a]; }
        return o;
      });
      const file = path.join(tmp, 'result.wav');
      await writeWav(file, out, full.sampleRate);
      // Reuse the regular import path (peaks, preview, bin entry), then swap into clips.
      const created = await actions.importFromFile(pid, file, { name: `${asset.name} · pitch curve`, actor });
      if (body.replaceInClips !== false && p.tracks.some((t) => t.clips.some((c) => c.assetId === assetId))) {
        store.apply(pid, [{ op: 'asset.replaceInClips', args: { fromAssetId: assetId, toAssetId: created.id } }], { actor, label: `Applied a pitch curve to “${asset.name}”` });
      }
      return { asset: created, span: [s0, s1] };
    } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  }

  api.post('/projects/:id/assets/:aid/pitch-curve', json, wrap(async (req, res) => res.status(201).json(await apply(req.params.id, req.params.aid, req.body || {}, actorOf(req)))));
  mcpTools.push({
    name: 'pitch_curve',
    description: 'Manual pitch correction: shift a voice by a curve of points {time (asset/source seconds), cents} — linear between points, 0 outside, so put 0-cent points around the part you fix. E.g. a note 30 cents flat from 12.40–12.90 s: [{time:12.3,cents:0},{time:12.4,cents:30},{time:12.9,cents:30},{time:13.0,cents:0}]. Use get_pitch first to see where the voice is off. Formants are kept (WORLD vocoder); only the covered span is resynthesised.',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, assetId: { type: 'string' }, points: schema.properties.points, replaceInClips: { type: 'boolean' } }, required: ['projectId', 'assetId', 'points'] },
    handler: ({ projectId, assetId, ...b }, actor) => apply(projectId, assetId, b, actor),
  });
}
