// User presets: save a track's (or the master's) effect chain under a name and reuse it
// in any session. Stored server-wide in <data>/presets.json.
import fs from 'node:fs/promises';
import path from 'node:path';
import { newId } from '../ops.js';
import { EFFECTS } from '../../public/js/engine/graph.js';

export async function register({ api, json, wrap, store, mcpTools, actorOf, OpError }) {
  const file = path.join(store.dir, 'presets.json');
  const load = async () => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return []; } };
  const save = (list) => fs.writeFile(file, JSON.stringify(list, null, 1));

  async function create({ projectId, trackId, name, description }, actor) {
    if (!name?.trim()) throw new OpError('name is required', 'invalid_args', 400);
    const p = store.get(projectId);
    const chain = trackId ? p.tracks.find((t) => t.id === trackId)?.effects : p.master.effects;
    if (!chain) throw new OpError(`Track ${trackId} not found`, 'not_found', 404);
    if (!chain.length) throw new OpError('That chain has no effects to save', 'invalid_args', 400);
    const list = await load();
    const preset = {
      id: newId('ups'), name: name.trim().slice(0, 80), description: (description || '').slice(0, 300), target: trackId ? 'track' : 'master',
      effects: chain.map(({ type, enabled, params }) => ({ type, enabled, params: { ...params } })),
      createdAt: new Date().toISOString(), createdBy: actor,
    };
    list.push(preset);
    await save(list);
    return preset;
  }

  async function apply(projectId, presetId, { trackId, replace } = {}, actor) {
    const preset = (await load()).find((x) => x.id === presetId);
    if (!preset) throw new OpError(`Preset ${presetId} not found`, 'not_found', 404);
    const p = store.get(projectId);
    const chain = trackId ? p.tracks.find((t) => t.id === trackId)?.effects : p.master.effects;
    if (!chain) throw new OpError(`Track ${trackId} not found`, 'not_found', 404);
    const ops = [
      ...(replace ? chain.map((e) => ({ op: 'effect.remove', args: { effectId: e.id } })) : []),
      ...preset.effects.filter((e) => EFFECTS[e.type]).map((e) => ({ op: 'effect.add', args: { ...(trackId ? { trackId } : {}), type: e.type, params: e.params } })),
    ];
    const r = store.apply(projectId, ops, { actor, label: `Applied preset “${preset.name}”` });
    return { rev: r.rev, effectIds: r.results.map((x) => x.effectId).filter(Boolean) };
  }

  api.get('/presets/user', wrap(async (req, res) => res.json(await load())));
  api.post('/presets/user', json, wrap(async (req, res) => res.status(201).json(await create(req.body || {}, actorOf(req)))));
  api.delete('/presets/user/:pid', wrap(async (req, res) => {
    const list = await load();
    const next = list.filter((x) => x.id !== req.params.pid);
    if (next.length === list.length) throw new OpError('Preset not found', 'not_found', 404);
    await save(next);
    res.status(204).end();
  }));
  api.post('/projects/:id/presets/user/:pid/apply', json, wrap(async (req, res) => res.json(await apply(req.params.id, req.params.pid, req.body || {}, actorOf(req)))));

  mcpTools.push(
    {
      name: 'save_preset',
      description: 'Save the effect chain of a track (or the master, without trackId) as a named preset that works in every session — e.g. after dialling in a voice sound the human likes.',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, trackId: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } }, required: ['projectId', 'name'] },
      handler: (a, actor) => create(a, actor),
    },
    {
      name: 'list_user_presets',
      description: 'Presets people and agents have saved (built-in ones are applied with preset_apply).',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => (await load()).map(({ effects, ...m }) => ({ ...m, effects: effects.map((e) => e.type) })),
    },
    {
      name: 'apply_user_preset',
      description: 'Add a saved preset\'s effects to a track (or the master). replace:true clears the chain first. One undo step.',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, presetId: { type: 'string' }, trackId: { type: 'string' }, replace: { type: 'boolean' } }, required: ['projectId', 'presetId'] },
      handler: ({ projectId, presetId, ...o }, actor) => apply(projectId, presetId, o, actor),
    },
  );
}
