import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { existsSync, appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { OPS, newId, OpError } from './ops.js';
import { validate } from './validate.js';

const HISTORY_LIMIT = 200;
const LOG_LIMIT = 500;

// Undo snapshots cover the edit state only; assets live outside history so
// undoing never "loses" an imported or processed file. Asset names are the one
// asset field an op (asset.rename) can change, so they travel with the snapshot.
const snapshot = (p) => { const { assets, ...rest } = p; return structuredClone({ ...rest, assetNames: Object.fromEntries(assets.map((a) => [a.id, a.name])) }); };
const restoreFrom = (cur, state) => {
  const { assetNames = {}, ...rest } = structuredClone(state);
  const assets = cur.assets.map((a) => (Object.hasOwn(assetNames, a.id) ? { ...a, name: assetNames[a.id] } : a));
  return { ...rest, assets, id: cur.id, createdAt: cur.createdAt, rev: cur.rev + 1, updatedAt: new Date().toISOString() };
};

export class Store extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.entries = new Map();
    this.saveTimers = new Map();
  }

  async init() {
    await fs.mkdir(path.join(this.dir, 'projects'), { recursive: true });
    for (const id of await fs.readdir(path.join(this.dir, 'projects'))) {
      const file = path.join(this.dir, 'projects', id, 'project.json');
      if (!existsSync(file)) continue;
      const project = JSON.parse(await fs.readFile(file, 'utf8'));
      let log = [];
      const logFile = path.join(this.dir, 'projects', id, 'activity.jsonl');
      if (existsSync(logFile)) {
        log = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).slice(-LOG_LIMIT).map((l) => JSON.parse(l));
      }
      this.entries.set(id, { project, undo: [], redo: [], log });
    }
  }

  projectDir(id) { return path.join(this.dir, 'projects', id); }
  assetPath(id, assetId) { return path.join(this.projectDir(id), 'assets', `${assetId}.wav`); }
  peaksPath(id, assetId) { return path.join(this.projectDir(id), 'assets', `${assetId}.peaks`); }
  previewPath(id, assetId) { return path.join(this.projectDir(id), 'assets', `${assetId}.preview.flac`); }
  rendersDir(id) { return path.join(this.projectDir(id), 'renders'); }

  list() {
    return [...this.entries.values()].map(({ project: p }) => ({
      id: p.id, name: p.name, sampleRate: p.sampleRate, updatedAt: p.updatedAt, rev: p.rev,
      tracks: p.tracks.length, assets: p.assets.length,
    })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  entry(id) {
    const e = this.entries.get(id);
    if (!e) throw new OpError(`Project ${id} not found`, 'not_found', 404);
    return e;
  }
  get(id) { return this.entry(id).project; }

  async create({ name, sampleRate = 48000 }, actor) {
    const now = new Date().toISOString();
    const project = {
      id: newId('prj'), name: name || 'Untitled session', sampleRate,
      createdAt: now, updatedAt: now, rev: 0,
      assets: [], tracks: [], markers: [], master: { gain: 0, effects: [] },
    };
    await fs.mkdir(path.join(this.projectDir(project.id), 'assets'), { recursive: true });
    await fs.mkdir(this.rendersDir(project.id), { recursive: true });
    this.entries.set(project.id, { project, undo: [], redo: [], log: [] });
    this.log(project.id, { actor, label: 'Created project' });
    await this.persistNow(project.id);
    return project;
  }

  async deleteProject(id) {
    this.entry(id);
    this.entries.delete(id);
    await fs.rm(this.projectDir(id), { recursive: true, force: true });
  }

  /**
   * Apply a batch of ops atomically. All succeed or none do.
   * ops: [{ op, args }]. Returns { rev, results }.
   */
  apply(id, ops, { actor = 'anonymous', label, ifRev } = {}) {
    const e = this.entry(id);
    if (ifRev !== undefined && ifRev !== e.project.rev) {
      throw new OpError(`Project is at rev ${e.project.rev}, you sent ifRev=${ifRev}. Re-read the project and retry.`, 'rev_conflict', 409);
    }
    const before = snapshot(e.project);
    const { draft, results } = this.run(e.project, ops);
    draft.rev = e.project.rev + 1;
    draft.updatedAt = new Date().toISOString();
    e.project = draft;
    e.undo.push({ state: before, label: label || describe(ops), actor });
    if (e.undo.length > HISTORY_LIMIT) e.undo.shift();
    e.redo = [];
    const entry = this.log(id, { actor, label: label || describe(ops), ops });
    this.changed(id, entry);
    return { rev: draft.rev, results };
  }

  // Run ops against a copy of a project without committing anything.
  run(project, ops) {
    if (!Array.isArray(ops) || ops.length === 0) throw new OpError('ops must be a non-empty array', 'invalid_args', 400);
    const draft = structuredClone(project);
    const results = [];
    ops.forEach((o, i) => {
      const def = Object.hasOwn(OPS, o?.op ?? '') ? OPS[o.op] : null;
      if (!def) throw new OpError(`ops[${i}]: unknown op "${o?.op}". GET /api/ops lists them.`, 'unknown_op', 400);
      try {
        const args = resolveRefs(o.args || {}, results, i);
        validate(def.schema, args, `ops[${i}].args`);
        results.push(def.apply(draft, args) || {});
      } catch (err) {
        err.message = ops.length > 1 && !err.message.startsWith('ops[') ? `ops[${i}] (${o.op}): ${err.message}` : err.message;
        throw err;
      }
    });
    snapToSamples(draft);
    return { draft, results };
  }

  // Replace the edit state wholesale (restoring a version), as one undoable step.
  restoreState(id, state, { actor, label }) {
    const e = this.entry(id);
    const have = new Set(e.project.assets.map((a) => a.id));
    const missing = state.tracks.flatMap((t) => t.clips).find((c) => !have.has(c.assetId));
    if (missing) throw new OpError(`This version uses audio (${missing.assetId}) that has since been deleted from the bin`, 'asset_missing', 409);
    e.undo.push({ state: snapshot(e.project), label, actor });
    if (e.undo.length > HISTORY_LIMIT) e.undo.shift();
    e.redo = [];
    e.project = restoreFrom(e.project, state);
    this.changed(id, this.log(id, { actor, label }));
    return { rev: e.project.rev };
  }
  snapshotOf(id) { return snapshot(this.entry(id).project); }

  undo(id, actor) { return this.travel(id, 'undo', 'redo', actor); }
  redo(id, actor) { return this.travel(id, 'redo', 'undo', actor); }
  travel(id, from, to, actor) {
    const e = this.entry(id);
    const step = e[from].pop();
    if (!step) throw new OpError(`Nothing to ${from}`, `nothing_to_${from}`, 409);
    e[to].push({ state: snapshot(e.project), label: step.label, actor: step.actor });
    e.project = restoreFrom(e.project, step.state);
    const entry = this.log(id, { actor, label: `${from === 'undo' ? 'Undid' : 'Redid'}: ${step.label}` });
    this.changed(id, entry);
    return { rev: e.project.rev, label: step.label };
  }

  history(id) {
    const e = this.entry(id);
    return { undo: e.undo.map((s) => ({ label: s.label, actor: s.actor })).reverse(), redo: e.redo.map((s) => ({ label: s.label, actor: s.actor })).reverse() };
  }

  addAsset(id, asset, actor) {
    const e = this.entry(id);
    e.project.assets.push(asset);
    e.project.rev++;
    e.project.updatedAt = new Date().toISOString();
    const entry = this.log(id, { actor, label: asset.derivedFrom ? `Processed audio → “${asset.name}”` : `Imported “${asset.name}”` });
    this.changed(id, entry);
  }

  async removeAsset(id, assetId, actor) {
    const e = this.entry(id);
    const asset = e.project.assets.find((a) => a.id === assetId);
    if (!asset) throw new OpError(`Asset ${assetId} not found`, 'not_found', 404);
    const used = e.project.tracks.some((t) => t.clips.some((c) => c.assetId === assetId))
      || [...e.undo, ...e.redo, ...this.savedVersions(id)].some((s) => s.state?.tracks?.some((t) => t.clips.some((c) => c.assetId === assetId)));
    if (used) throw new OpError('Asset is used by clips (or by clips in undo history or a saved version). Remove those clips first.', 'asset_in_use', 409);
    e.project.assets = e.project.assets.filter((a) => a.id !== assetId);
    e.project.rev++;
    await fs.rm(this.assetPath(id, assetId), { force: true });
    await fs.rm(this.peaksPath(id, assetId), { force: true });
    await fs.rm(this.previewPath(id, assetId), { force: true });
    this.changed(id, this.log(id, { actor, label: `Deleted “${asset.name}” from the bin` }));
  }

  savedVersions(id) {
    try { return JSON.parse(readFileSync(path.join(this.projectDir(id), 'versions.json'), 'utf8')); } catch { return []; }
  }

  log(id, { actor = 'anonymous', label, ops }) {
    const e = this.entry(id);
    const entry = { ts: new Date().toISOString(), rev: e.project.rev, actor, label, ...(ops ? { ops } : {}) };
    e.log.push(entry);
    if (e.log.length > LOG_LIMIT) e.log.shift();
    try { appendFileSync(path.join(this.projectDir(id), 'activity.jsonl'), JSON.stringify(entry) + '\n'); } catch {}
    return entry;
  }
  activity(id, limit = 50) { return this.entry(id).log.slice(-limit).reverse(); }

  // Ephemeral notices (job progress etc.) that should reach live clients.
  notify(id, payload) { this.emit('notice', { projectId: id, ...payload }); }

  changed(id, cause) {
    this.emit('change', { projectId: id, project: this.get(id), cause });
    clearTimeout(this.saveTimers.get(id));
    this.saveTimers.set(id, setTimeout(() => this.persistNow(id).catch((err) => console.error('save failed', id, err)), 150));
  }

  // Saves of one project run one after another, each through its own temp file, so the
  // debounced auto-save and an explicit save (archive, shutdown) can never collide.
  persistNow(id) {
    this.saveChains ||= new Map();
    const next = (this.saveChains.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
      const e = this.entries.get(id);
      if (!e) return;
      const file = path.join(this.projectDir(id), 'project.json');
      const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(e.project, null, 1));
      await fs.rename(tmp, file);
    });
    this.saveChains.set(id, next);
    return next;
  }
}

// Clip positions live on the sample grid, so audio is placed sample-exactly and never
// interpolated between samples (a 10 µs offset would otherwise low-pass the whole clip).
function snapToSamples(p) {
  const sr = p.sampleRate || 48000;
  const q = (x) => Math.round(x * sr) / sr;
  for (const t of p.tracks) for (const c of t.clips) {
    c.start = q(c.start); c.offset = q(c.offset); c.duration = Math.max(1 / sr, q(c.duration));
    if (c.loopLength) c.loopLength = Math.max(1 / sr, q(c.loopLength));
  }
}

// "$2.clipId" inside args refers to the result of ops[2] in the same batch.
function resolveRefs(args, results, i) {
  const fix = (v) => {
    if (typeof v === 'string') {
      const m = v.match(/^\$(\d+)\.(\w+)$/);
      if (!m) return v;
      const r = results[+m[1]];
      if (!r || r[m[2]] === undefined) throw new OpError(`ops[${i}]: reference ${v} does not resolve (only earlier ops' results can be referenced)`, 'invalid_args', 400);
      return r[m[2]];
    }
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)]));
    return v;
  };
  return fix(args);
}

function describe(ops) {
  if (ops.length === 1) return humanize(ops[0]);
  const names = [...new Set(ops.map((o) => o.op))];
  return `${ops.length} edits (${names.join(', ')})`;
}
function humanize({ op, args = {} }) {
  const t = (x) => (typeof x === 'number' ? `${x.toFixed(2)}s` : '');
  switch (op) {
    case 'clip.split': return `Split clip at ${t(args.at)}`;
    case 'range.delete': return `Cut ${t(args.start)}–${t(args.end)}${args.ripple === false ? '' : ' (ripple)'}`;
    case 'range.insertSilence': return `Inserted ${t(args.duration)} gap at ${t(args.at)}`;
    case 'clip.add': return `Placed clip at ${t(args.start || 0)}`;
    case 'clip.update': return args.start !== undefined && Object.keys(args).length === 2 ? `Moved clip to ${t(args.start)}` : 'Edited clip';
    case 'clip.remove': return 'Deleted clip';
    case 'track.add': return `Added track${args.name ? ` “${args.name}”` : ''}`;
    case 'track.update': return 'Changed track ' + Object.keys(args).filter((k) => k !== 'trackId').join(', ');
    case 'effect.add': return `Added ${args.type}`;
    case 'effect.update': return 'Adjusted effect';
    case 'marker.add': return `Marker${args.label ? ` “${args.label}”` : ''} at ${t(args.time)}`;
    case 'project.setLayout': return args.layout === '5.1' ? 'Switched to 5.1 surround' : 'Switched to stereo';
    case 'send.add': return 'Added a send';
    case 'send.update': return 'Adjusted a send';
    case 'preset.apply': return `Applied preset ${args.preset}${args.trackId ? '' : ' to master'}`;
    case 'automation.set': { const what = String(args.param).startsWith('fx:') ? 'effect' : args.param; return args.points?.length ? `Set ${what} automation (${args.points.length} points)` : `Cleared ${what} automation`; }
    case 'automation.addPoint': return `Added ${args.param} automation point`;
    case 'effect.remove': return 'Removed effect';
    case 'effect.move': return 'Reordered effects';
    case 'master.update': return `Master gain ${args.gain} dB`;
    case 'project.rename': return `Renamed session to “${args.name}”`;
    case 'clip.duplicate': return 'Duplicated clip';
    case 'track.remove': return 'Deleted track';
    case 'asset.rename': return `Renamed file to “${args.name}”`;
    default: return op;
  }
}
