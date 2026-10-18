// Batch helpers for agents: process many files at once, stretch clips to a length.
import { validate } from '../validate.js';

export async function register({ api, json, wrap, store, actions, mcpTools, actorOf, OpError }) {
  async function batch(pid, { assetIds, kind, params, replaceInClips = true }, actor) {
    const p = store.get(pid);
    const ids = assetIds?.length ? assetIds : [...new Set(p.tracks.flatMap((t) => t.clips.map((c) => c.assetId)))];
    if (!ids.length) throw new OpError('No files to process', 'empty', 422);
    const results = [];
    for (const id of ids) {
      try { const r = await actions.processAsset(pid, id, { kind, params, replaceInClips }, actor); results.push({ assetId: id, newAssetId: r.asset.id, clipsUpdated: r.clipsUpdated }); }
      catch (err) { results.push({ assetId: id, error: err.message }); }
    }
    return { processed: results.filter((r) => !r.error).length, failed: results.filter((r) => r.error).length, results };
  }
  const stretchSchema = { type: 'object', properties: { duration: { type: 'number', minimum: 0.05 }, ratio: { type: 'number', minimum: 0.25, maximum: 4 } } };

  api.post('/projects/:id/batch-process', json, wrap(async (req, res) => res.json(await batch(req.params.id, req.body || {}, actorOf(req)))));
  api.post('/projects/:id/clips/:clipId/stretch', json, wrap(async (req, res) => {
    validate(stretchSchema, req.body || {});
    res.json(await actions.stretchClip(req.params.id, req.params.clipId, req.body || {}, actorOf(req)));
  }));

  mcpTools.push(
    {
      name: 'batch_process',
      description: 'Run one destructive process (see process_audio kinds, e.g. loudness, denoise, voiceDenoise, declip) on several files — by default every file used on the timeline. Each result is swapped into its clips when the length stays the same. Returns per-file results.',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, assetIds: { type: 'array', items: { type: 'string' } }, kind: { type: 'string' }, params: { type: 'object' }, replaceInClips: { type: 'boolean' } }, required: ['projectId', 'kind'] },
      handler: ({ projectId, ...b }, actor) => batch(projectId, b, actor),
    },
    {
      name: 'stretch_clip',
      description: 'Time-stretch one clip to an exact length (duration in seconds) or by a ratio, keeping its pitch (Rubber Band, high quality) — e.g. fit a music bed to 30.0 s. Creates a new file and points the clip at it; one undo step.',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, clipId: { type: 'string' }, duration: { type: 'number' }, ratio: { type: 'number' } }, required: ['projectId', 'clipId'] },
      handler: ({ projectId, clipId, ...b }, actor) => { validate(stretchSchema, b); return actions.stretchClip(projectId, clipId, b, actor); },
    },
  );
}
