// Proposals (agents suggest, humans decide) and named versions of a session.
import fs from 'node:fs/promises';
import path from 'node:path';
import { newId } from '../ops.js';

export async function register({ api, json, wrap, store, mcpTools, actorOf, OpError }) {
  const file = (pid, kind) => path.join(store.projectDir(pid), `${kind}.json`);
  const load = async (pid, kind) => { store.get(pid); try { return JSON.parse(await fs.readFile(file(pid, kind), 'utf8')); } catch { return []; } };
  // Atomic write (a concurrent load must never see a half-written file and treat it as empty).
  const save = async (pid, kind, list) => { const f = file(pid, kind), tmp = `${f}.${newId('tmp')}`; await fs.writeFile(tmp, JSON.stringify(list, null, 1)); await fs.rename(tmp, f); };
  // Read-modify-write of the lists is serialized per project, so two requests can't both
  // accept the same proposal (applying its ops twice) or drop each other's additions.
  const locks = new Map();
  const locked = (pid, fn) => { const run = (locks.get(pid) || Promise.resolve()).then(fn, fn); locks.set(pid, run.catch(() => {})); return run; };

  // ── proposals ────────────────────────────────────────────────────────
  const propose = (pid, body, actor) => locked(pid, () => proposeNow(pid, body, actor));
  async function proposeNow(pid, { ops, label, rationale }, actor) {
    if (!label) throw new OpError('label is required: one line the human will read', 'invalid_args', 400);
    const p = store.get(pid);
    store.run(p, ops); // validate now so the human never sees a broken proposal
    const list = await load(pid, 'proposals');
    const prop = { id: newId('prp'), status: 'open', label, rationale: rationale || '', ops, baseRev: p.rev, createdAt: new Date().toISOString(), createdBy: actor };
    list.push(prop);
    await save(pid, 'proposals', list);
    store.notify(pid, { type: 'proposal', proposal: prop });
    store.log(pid, { actor, label: `Proposed: ${label}` });
    store.changed(pid, { actor, label: `Proposed: ${label}`, ts: new Date().toISOString(), rev: p.rev });
    return prop;
  }
  const decide = (pid, propId, accept, actor, force) => locked(pid, () => decideNow(pid, propId, accept, actor, force));
  async function decideNow(pid, propId, accept, actor, force) {
    const list = await load(pid, 'proposals');
    const prop = list.find((x) => x.id === propId);
    if (!prop) throw new OpError(`Proposal ${propId} not found`, 'not_found', 404);
    if (prop.status !== 'open') throw new OpError(`Proposal is already ${prop.status}`, 'conflict', 409);
    // Times in a proposal refer to the session as it was; refuse silently-shifted edits.
    if (accept && !force && store.get(pid).rev !== prop.baseRev) {
      throw new OpError(`The session changed since this was proposed (rev ${prop.baseRev} → ${store.get(pid).rev}); its times may no longer line up. Preview it again and accept with force, or ask for a fresh proposal.`, 'stale_proposal', 409);
    }
    let result = null;
    if (accept) result = store.apply(pid, prop.ops, { actor, label: `Accepted ${prop.createdBy.replace(/^agent:/, '')}’s proposal: ${prop.label}` });
    prop.status = accept ? 'accepted' : 'rejected';
    prop.decidedBy = actor; prop.decidedAt = new Date().toISOString();
    await save(pid, 'proposals', list);
    if (!accept) store.changed(pid, store.log(pid, { actor, label: `Rejected proposal: ${prop.label}` }));
    store.notify(pid, { type: 'proposal', proposal: prop });
    return { proposal: prop, ...(result ? { rev: result.rev } : {}) };
  }

  api.get('/projects/:id/proposals', wrap(async (req, res) => {
    const list = await load(req.params.id, 'proposals');
    res.json(req.query.all ? list : list.filter((x) => x.status === 'open'));
  }));
  api.post('/projects/:id/proposals', json, wrap(async (req, res) => res.status(201).json(await propose(req.params.id, req.body || {}, actorOf(req)))));
  api.get('/projects/:id/proposals/:pid/preview', wrap(async (req, res) => {
    const prop = (await load(req.params.id, 'proposals')).find((x) => x.id === req.params.pid);
    if (!prop) throw new OpError('Proposal not found', 'not_found', 404);
    const { draft } = store.run(store.get(req.params.id), prop.ops);
    res.json(draft);
  }));
  api.post('/projects/:id/proposals/:pid/accept', wrap(async (req, res) => res.json(await decide(req.params.id, req.params.pid, true, actorOf(req), req.query.force === '1'))));
  api.post('/projects/:id/proposals/:pid/reject', wrap(async (req, res) => res.json(await decide(req.params.id, req.params.pid, false, actorOf(req)))));

  // ── versions ─────────────────────────────────────────────────────────
  const saveVersion = (pid, name, actor) => locked(pid, () => saveVersionNow(pid, name, actor));
  async function saveVersionNow(pid, name, actor) {
    const list = await load(pid, 'versions');
    const p = store.get(pid);
    const v = { id: newId('ver'), name: name || `Version ${list.length + 1}`, rev: p.rev, createdAt: new Date().toISOString(), createdBy: actor, state: store.snapshotOf(pid) };
    list.push(v);
    await save(pid, 'versions', list);
    store.changed(pid, store.log(pid, { actor, label: `Saved version “${v.name}”` }));
    const { state, ...meta } = v;
    return meta;
  }
  api.get('/projects/:id/versions', wrap(async (req, res) => res.json((await load(req.params.id, 'versions')).map(({ state, ...m }) => m).reverse())));
  api.post('/projects/:id/versions', json, wrap(async (req, res) => res.status(201).json(await saveVersion(req.params.id, req.body?.name, actorOf(req)))));
  api.post('/projects/:id/versions/:vid/restore', wrap(async (req, res) => {
    const v = (await load(req.params.id, 'versions')).find((x) => x.id === req.params.vid);
    if (!v) throw new OpError('Version not found', 'not_found', 404);
    res.json(store.restoreState(req.params.id, v.state, { actor: actorOf(req), label: `Restored version “${v.name}”` }));
  }));

  const pid = { projectId: { type: 'string' } };
  mcpTools.push(
    {
      name: 'propose_edits',
      description: 'Suggest a batch of edits WITHOUT applying them. The human hears a preview and accepts or rejects it in the UI. Use this for anything subjective or destructive-feeling (big cuts, re-ordering, heavy processing choices) or when the human asked to review first. Same op format as `edit`. label = one line the human reads; rationale = why (short). Returns the proposal; check its status later with list_proposals.',
      inputSchema: { type: 'object', properties: { ...pid, label: { type: 'string' }, rationale: { type: 'string' }, ops: { type: 'array', items: { type: 'object', properties: { op: { type: 'string' }, args: { type: 'object' } }, required: ['op'] } } }, required: ['projectId', 'label', 'ops'] },
      handler: ({ projectId, ...b }, actor) => propose(projectId, b, actor),
    },
    {
      name: 'list_proposals',
      description: 'Proposals for a session with their status (open, accepted, rejected) and who decided.',
      inputSchema: { type: 'object', properties: { ...pid, all: { type: 'boolean', description: 'Include decided ones (default true)' } }, required: ['projectId'] },
      handler: async ({ projectId, all = true }) => (await load(projectId, 'proposals')).filter((x) => all || x.status === 'open').map(({ ops, ...m }) => ({ ...m, opCount: ops.length })),
    },
    {
      name: 'save_version',
      description: 'Save a named snapshot of the session (e.g. before a risky pass) that the human can return to.',
      inputSchema: { type: 'object', properties: { ...pid, name: { type: 'string' } }, required: ['projectId'] },
      handler: ({ projectId, name }, actor) => saveVersion(projectId, name, actor),
    },
  );
}
