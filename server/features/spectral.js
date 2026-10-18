// Spectral editing and noise-print noise reduction (Audition's restoration
// workflow): attenuate / heal on a time×frequency box, a lasso polygon or brush
// strokes (spot healing brush = heal + strokes), a pitch (f0) track, capture a
// noise print from room tone and reduce noise with it, and a spectrogram PNG
// with an exact pixel→(time, Hz) mapping. Heavy work runs in worker threads.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { newId, findClip, OpError } from '../ops.js';
import { validate } from '../validate.js';
import * as audio from '../audio.js';
import { describeProfile, summarizePitch, pitchPoints, regionShape } from './spectral-dsp.js';

const WORKER = new URL('./spectral-worker.js', import.meta.url);
const MAX_WORKERS = Math.max(2, Math.min(4, os.cpus().length - 1));
const tmpFile = (ext = '') => path.join(os.tmpdir(), `klang-${newId('tmp')}${ext}`);

// ── worker pool (one short-lived worker per job, bounded concurrency) ─────
let running = 0;
const queue = [];
function runJob(job) {
  return new Promise((resolve, reject) => { queue.push({ job, resolve, reject }); pump(); });
}
function pump() {
  while (running < MAX_WORKERS && queue.length) {
    const { job, resolve, reject } = queue.shift();
    running++;
    let settled = false;
    const w = new Worker(WORKER, { workerData: { klangSpectral: job } });
    w.once('message', (m) => {
      settled = true;
      if (m.ok) resolve(m.result);
      else reject(new OpError(m.error.message, m.error.code || 'spectral_failed', m.error.status || 422));
    });
    w.once('error', (e) => { if (!settled) { settled = true; reject(e); } });
    w.once('exit', (code) => {
      running--;
      if (!settled) reject(new OpError(`Spectral worker exited (${code})`, 'spectral_failed', 500));
      pump();
    });
  }
}

// ── schemas ─────────────────────────────────────────────────────────────
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const POINT = { type: 'array', items: { type: 'number' }, description: '[t, hz]: source seconds, Hz' };
const MAX_POINTS = 20000;
const EDIT_PROPS = {
  action: { type: 'string', enum: ['attenuate', 'heal'], description: 'attenuate = scale the region by gainDb (smooth raised-cosine edges). heal = rebuild the region from the audio just before and after it at each frequency (removes coughs, clicks, chair squeaks, phone rings while keeping tones/voice that run through it). heal + strokes = spot healing brush.' },
  start: num('Box: region start, seconds in asset/source time', { minimum: 0 }),
  end: num('Box: region end, seconds in asset/source time', { minimum: 0 }),
  lowHz: num('Box: lower frequency edge in Hz (default 0)', { minimum: 0 }),
  highHz: num('Box: upper frequency edge in Hz (default Nyquist = sampleRate/2)', { minimum: 0 }),
  polygon: { type: 'array', items: POINT, description: 'Lasso instead of a box: closed outline [[t, hz], …] (≥ 3 points, source seconds + Hz, closes automatically, even-odd fill). Edges fade over `feather` seconds and 1/6 octave outside the outline.' },
  strokes: {
    type: 'array', description: 'Brush instead of a box: painted strokes, applied in order. Each stroke is a polyline of [t, hz] points swept by an ellipse of radiusMs × radiusSemitones (soft rim ≈ 35% of the radius). erase:true removes paint from earlier strokes. A single point paints a dot (e.g. one click).',
    items: {
      type: 'object', required: ['points'], additionalProperties: false,
      properties: {
        points: { type: 'array', items: POINT, description: '[[t, hz], …] along the stroke' },
        radiusMs: num('Brush radius in time, ms (default 20; ≥ ~6 ms is enforced so a dot never falls between STFT frames)', { minimum: 0.1, maximum: 5000 }),
        radiusSemitones: num('Brush radius in frequency, semitones (default 2). Below ~300 Hz the axis turns linear, so it never shrinks below ~1.5 FFT bins.', { minimum: 0.05, maximum: 120 }),
        erase: { type: 'boolean', description: 'Erase instead of paint' },
      },
    },
  },
  gainDb: num('attenuate only: gain inside the region in dB (default -20; -100 … +24)', { minimum: -100, maximum: 24 }),
  feather: num('Time feather in seconds for box and lasso edges (default 0.01). Frequency edges always fade over 1/6 octave.', { minimum: 0, maximum: 1 }),
  replaceInClips: { type: 'boolean', description: 'Swap the result into every clip using the asset (default true; one undo step)' },
};
const DENOISE_PROPS = {
  start: num('Optional: start of a noise-only stretch (room tone), seconds in asset/source time. With end, the noise print is learned from here first (on profileFrom when given, else on this asset).', { minimum: 0 }),
  end: num('Optional: end of the noise-only stretch, seconds in asset/source time', { minimum: 0 }),
  profileFrom: { type: 'string', description: 'Use the noise print stored on this asset id instead (e.g. room tone recorded separately)' },
  reductionDb: num('How far noise is pushed down, dB (default 18; 6–24 natural, up to 60)', { minimum: 0, maximum: 60 }),
  sensitivity: num('0–10, default 5. Over-subtraction: each step ≈ +1 dB of threshold above the print. Higher removes more but can dull quiet detail.', { minimum: 0, maximum: 10 }),
  smoothing: num('0–1, default 0.5. Gain-mask smoothing over time and frequency (fights "musical noise").', { minimum: 0, maximum: 1 }),
  replaceInClips: { type: 'boolean', description: 'Swap the result into clips using the asset (default true)' },
};
const PRINT_PROPS = { start: EDIT_PROPS.start, end: EDIT_PROPS.end };

export async function register({ api, json, wrap, store, mcpTools, actorOf }) {
  const findAsset = (pid, aid) => {
    const a = store.get(pid).assets.find((x) => x.id === aid);
    if (!a) throw new OpError(`Asset ${aid} not found`, 'not_found', 404);
    return a;
  };
  const printDir = (pid) => path.join(store.projectDir(pid), 'noiseprints');
  const printFile = (pid, aid) => path.join(printDir(pid), `${aid}.json`);

  // Noise print stored on the asset or (following derivedFrom) on the asset it was made from.
  async function loadPrint(pid, aid) {
    const assets = store.get(pid).assets;
    let a = assets.find((x) => x.id === aid);
    for (let hops = 0; a && hops < 64; hops++) {
      const txt = await fs.readFile(printFile(pid, a.id), 'utf8').catch(() => null);
      if (txt) return { profile: JSON.parse(txt), storedOn: a.id };
      a = a.derivedFrom && assets.find((x) => x.id === a.derivedFrom);
    }
    return null;
  }

  async function registerAsset(pid, wavFile, { name, actor, derivedFrom, process }) {
    const p = store.get(pid);
    const id = newId('ast');
    const dest = store.assetPath(pid, id);
    await fs.rename(wavFile, dest).catch(async () => { await fs.copyFile(wavFile, dest); await fs.rm(wavFile, { force: true }); });
    const info = await audio.probe(dest);
    await audio.writePeaks(dest, store.peaksPath(pid, id));
    const asset = {
      id, name, duration: Math.round(info.duration * 1e6) / 1e6, sampleRate: p.sampleRate, channels: info.channels,
      createdAt: new Date().toISOString(), createdBy: actor, derivedFrom, process,
    };
    store.addAsset(pid, asset, actor);
    return asset;
  }

  const suffixed = (name, suffix) => (name.endsWith(` · ${suffix}`) ? name : `${name} · ${suffix}`);

  // Shared flow: run a worker job that writes a new WAV, register it, swap it into clips.
  async function produce(pid, asset, { label, suffix, job, process, replaceInClips = true }, actor) {
    const jobId = newId('job');
    store.notify(pid, { type: 'job', jobId, status: 'running', label, actor });
    const out = tmpFile('.wav');
    try {
      const stats = await runJob({ ...job, src: store.assetPath(pid, asset.id), dest: out });
      const created = await registerAsset(pid, out, { name: suffixed(asset.name, suffix), actor, derivedFrom: asset.id, process });
      let clipsUpdated = 0;
      if (replaceInClips !== false && store.get(pid).tracks.some((t) => t.clips.some((c) => c.assetId === asset.id))) {
        const r = store.apply(pid, [{ op: 'asset.replaceInClips', args: { fromAssetId: asset.id, toAssetId: created.id } }], { actor, label: `${label}` });
        clipsUpdated = r.results[0].clipsUpdated;
      }
      store.notify(pid, { type: 'job', jobId, status: 'done', label, actor });
      return { asset: created, clipsUpdated, stats };
    } catch (err) {
      store.notify(pid, { type: 'job', jobId, status: 'failed', label, error: err.message, actor });
      throw err;
    } finally {
      await fs.rm(out, { force: true });
    }
  }

  const r3 = (v) => Math.round(v * 1000) / 1000;

  const bad = (msg) => new OpError(msg, 'invalid_args', 400);
  const checkPoint = (pt, where, nyq) => {
    if (pt.length !== 2) throw bad(`${where} must be [t, hz]`);
    if (pt[0] < 0) throw bad(`${where}: time must be >= 0`);
    if (pt[1] < 0) throw bad(`${where}: hz must be >= 0`);
    return [Math.round(pt[0] * 1e5) / 1e5, Math.round(Math.min(pt[1], nyq) * 100) / 100];
  };

  // Normalise the region part of a spectral edit body: exactly one of box (start/end), polygon, strokes.
  function regionParams(body, asset, nyq) {
    const shapes = [body.start !== undefined || body.end !== undefined ? 'box' : null, body.polygon ? 'polygon' : null, body.strokes ? 'strokes' : null].filter(Boolean);
    if (shapes.length !== 1) throw bad('Give exactly one region: start/end (box, with optional lowHz/highHz), polygon, or strokes');
    const feather = body.feather ?? 0.01;
    if (shapes[0] === 'box') {
      if (body.start === undefined || body.end === undefined) throw bad('A box needs both start and end');
      const start = body.start, end = Math.min(body.end, asset.duration);
      const lowHz = Math.min(body.lowHz ?? 0, nyq), highHz = Math.min(body.highHz ?? nyq, nyq);
      if (!(end > start)) throw bad(`end must be greater than start (asset is ${asset.duration} s long)`);
      if (!(highHz > lowHz)) throw bad('highHz must be greater than lowHz');
      return { start, end, lowHz, highHz, feather };
    }
    if (body.lowHz !== undefined || body.highHz !== undefined) throw bad('lowHz/highHz only apply to a box; a polygon or strokes carry their own frequencies');
    if (shapes[0] === 'polygon') {
      const pts = body.polygon;
      if (pts.length < 3) throw bad('polygon needs at least 3 points');
      if (pts.length > MAX_POINTS) throw bad(`polygon has more than ${MAX_POINTS} points`);
      return { polygon: pts.map((pt, i) => checkPoint(pt, `polygon[${i}]`, nyq)), feather };
    }
    if (!body.strokes.length) throw bad('strokes needs at least one stroke');
    let total = 0;
    const strokes = body.strokes.map((st, i) => {
      if (!st.points.length) throw bad(`strokes[${i}].points is empty`);
      total += st.points.length;
      return { points: st.points.map((pt, j) => checkPoint(pt, `strokes[${i}].points[${j}]`, nyq)), radiusMs: st.radiusMs ?? 20, radiusSemitones: st.radiusSemitones ?? 2, ...(st.erase ? { erase: true } : {}) };
    });
    if (total > MAX_POINTS) throw bad(`strokes have more than ${MAX_POINTS} points in total`);
    if (strokes.every((st) => st.erase)) throw bad('strokes only erase; paint at least one stroke');
    return { strokes };
  }

  // Time/frequency bounding box of a polygon or strokes region (for labels and the response).
  function regionBounds(p) {
    if (regionShape(p) === 'box') return { start: p.start, end: p.end, lowHz: p.lowHz, highHz: p.highHz };
    const pts = p.polygon || p.strokes.filter((st) => !st.erase).flatMap((st) => st.points);
    const ts = pts.map((x) => x[0]), fs2 = pts.map((x) => x[1]);
    const pad = p.strokes ? Math.max(...p.strokes.map((st) => st.radiusMs)) / 1000 : 0;
    return { start: r3(Math.max(0, Math.min(...ts) - pad)), end: r3(Math.max(...ts) + pad), lowHz: Math.round(Math.min(...fs2)), highHz: Math.round(Math.max(...fs2)) };
  }

  async function spectralEdit(pid, aid, body, actor) {
    validate({ type: 'object', properties: EDIT_PROPS, required: ['action'], additionalProperties: false }, body, 'body');
    const asset = findAsset(pid, aid), sr = store.get(pid).sampleRate, nyq = sr / 2;
    const region = regionParams(body, asset, nyq), shape = regionShape(region), bounds = regionBounds(region);
    if (bounds.start >= asset.duration) throw bad(`The region starts after the end of the asset (${asset.duration} s)`);
    const params = { ...region, ...(body.action === 'attenuate' ? { gainDb: body.gainDb ?? -20 } : {}) };
    const tool = shape === 'box' ? '' : shape === 'polygon' ? ' (lasso)' : body.action === 'heal' ? ' (spot heal brush)' : ' (brush)';
    const what = body.action === 'heal' ? 'Spectral heal' : `Spectral ${params.gainDb} dB`;
    const label = `${what}${tool} ${r3(bounds.start)}–${r3(bounds.end)} s, ${Math.round(bounds.lowHz)}–${Math.round(bounds.highHz)} Hz on “${asset.name}”`;
    const r = await produce(pid, asset, { label, suffix: 'spectral edit', job: { op: body.action, params }, process: { kind: 'spectral', params: { action: body.action, shape, ...params } }, replaceInClips: body.replaceInClips }, actor);
    return { asset: r.asset, clipsUpdated: r.clipsUpdated, region: { action: body.action, shape, bounds, ...params } };
  }

  async function pitch(pid, aid, q = {}) {
    const asset = findAsset(pid, aid);
    const n = (v, d) => (v === undefined || v === '' || !Number.isFinite(+v) ? d : +v);
    const start = Math.max(0, n(q.start, 0)), end = Math.min(asset.duration, n(q.end, asset.duration));
    if (!(end > start)) throw bad('end must be greater than start');
    if (end - start > 3600) throw bad('At most one hour per pitch request');
    const minHz = Math.max(20, n(q.minHz, 50)), maxHz = Math.min(4000, n(q.maxHz, 1000));
    if (!(maxHz > minHz * 1.5)) throw bad('maxHz must be at least 1.5 × minHz');
    const track = await runJob({ op: 'pitch', src: store.assetPath(pid, aid), opts: { start, end, minHz, maxHz, hop: 0.01 } });
    const maxPoints = Math.max(10, Math.round(n(q.maxPoints, Infinity)));
    const points = pitchPoints(track, maxPoints);
    return {
      assetId: aid, start: r3(start), end: r3(end), hop: 0.01, method: 'yin', search: { minHz, maxHz },
      summary: summarizePitch(track),
      pointHop: Math.round(((end - start) / Math.max(1, points.length)) * 1e4) / 1e4,
      track: points,
    };
  }

  async function learnPrint(pid, aid, body, actor) {
    validate({ type: 'object', properties: PRINT_PROPS, required: ['start', 'end'], additionalProperties: false }, body, 'body');
    const asset = findAsset(pid, aid);
    const end = Math.min(body.end, asset.duration);
    if (!(end > body.start)) throw new OpError(`end must be greater than start (asset is ${asset.duration} s long)`, 'invalid_args', 400);
    const profile = await runJob({ op: 'learn', src: store.assetPath(pid, aid), start: body.start, end });
    profile.assetId = aid; profile.createdAt = new Date().toISOString(); profile.createdBy = actor;
    await fs.mkdir(printDir(pid), { recursive: true });
    await fs.writeFile(printFile(pid, aid), JSON.stringify(profile));
    return { noisePrint: { assetId: aid, storedOn: aid, createdAt: profile.createdAt, createdBy: actor, ...describeProfile(profile) } };
  }

  async function getPrint(pid, aid) {
    findAsset(pid, aid);
    const found = await loadPrint(pid, aid);
    if (!found) return { noisePrint: null };
    const p = found.profile;
    return { noisePrint: { assetId: aid, storedOn: found.storedOn, createdAt: p.createdAt, createdBy: p.createdBy, ...describeProfile({ ...p, channels: p.channels }) } };
  }

  async function denoisePrint(pid, aid, body, actor) {
    validate({ type: 'object', properties: DENOISE_PROPS, additionalProperties: false }, body, 'body');
    const asset = findAsset(pid, aid);
    if ((body.start === undefined) !== (body.end === undefined)) throw new OpError('Give both start and end of the noise-only stretch, or neither', 'invalid_args', 400);
    let learned;
    if (body.start !== undefined) learned = (await learnPrint(pid, body.profileFrom || aid, { start: body.start, end: body.end }, actor)).noisePrint;
    const found = await loadPrint(pid, body.profileFrom ? findAsset(pid, body.profileFrom).id : aid);
    if (!found) throw new OpError('No noise print yet. Learn one first (POST …/noiseprint {start,end} on a noise-only stretch), or pass start/end here.', 'no_noiseprint', 409);
    const params = { reductionDb: body.reductionDb ?? 18, sensitivity: body.sensitivity ?? 5, smoothing: body.smoothing ?? 0.5 };
    const label = `Noise reduction −${params.reductionDb} dB on “${asset.name}”`;
    const r = await produce(pid, asset, {
      label, suffix: 'noise reduction',
      job: { op: 'denoise', profile: found.profile, params },
      process: { kind: 'noiseReduction', params: { ...params, noisePrint: { assetId: found.storedOn, start: found.profile.start, end: found.profile.end } } },
      replaceInClips: body.replaceInClips,
    }, actor);
    return {
      asset: r.asset, clipsUpdated: r.clipsUpdated, params,
      noisePrint: { storedOn: found.storedOn, start: r3(found.profile.start), end: r3(found.profile.end), ...(learned ? { learnedNow: true, character: learned.character } : {}) },
      measured: { noisePrintRangeDbfs: r.stats.noisePrintRangeDbfs, overallRmsDbfs: r.stats.overallRmsDbfs },
    };
  }

  async function spectrogram(pid, aid, q = {}) {
    const asset = findAsset(pid, aid), sr = store.get(pid).sampleRate, nyq = sr / 2;
    const n = (v, d) => (v === undefined || v === '' || !Number.isFinite(+v) ? d : +v);
    const start = Math.max(0, n(q.start, 0)), end = Math.min(asset.duration, n(q.end, asset.duration));
    if (!(end > start)) throw new OpError('end must be greater than start', 'invalid_args', 400);
    const width = Math.round(Math.min(4000, Math.max(16, n(q.width, 1200))));
    const height = Math.round(Math.min(2000, Math.max(16, n(q.height, 256))));
    const maxHz = Math.min(nyq, Math.max(2, n(q.maxHz, nyq)));
    const minHz = Math.min(maxHz / 2, Math.max(1, n(q.minHz, 30)));
    const minDb = n(q.minDb, -110), maxDb = n(q.maxDb, -10);
    const png = await runJob({ op: 'spectrogram', src: store.assetPath(pid, aid), opts: { start, end, width, height, minHz, maxHz, minDb: Math.min(minDb, maxDb - 6), maxDb } });
    return { png: Buffer.from(png.buffer, png.byteOffset, png.byteLength), meta: { start, end, width, height, minHz, maxHz, minDb, maxDb } };
  }

  const mappingText = (m) => `Spectrogram ${m.width}×${m.height}px. x → source time: t = ${m.start} + (x / ${m.width}) × ${r3(m.end - m.start)} s. y (0 = top) → frequency, log scale: f = ${m.maxHz} × (${m.minHz} / ${m.maxHz})^(y / ${m.height}) Hz. Colour: ${m.minDb}…${m.maxDb} dBFS per bin, dark → bright (inferno).`;

  // ── REST ───────────────────────────────────────────────────────────────
  api.post('/projects/:id/assets/:aid/spectral', json, wrap(async (req, res) => {
    res.status(201).json(await spectralEdit(req.params.id, req.params.aid, req.body || {}, actorOf(req)));
  }));
  api.get('/projects/:id/assets/:aid/noiseprint', wrap(async (req, res) => res.json(await getPrint(req.params.id, req.params.aid))));
  api.post('/projects/:id/assets/:aid/noiseprint', json, wrap(async (req, res) => {
    res.status(201).json(await learnPrint(req.params.id, req.params.aid, req.body || {}, actorOf(req)));
  }));
  api.delete('/projects/:id/assets/:aid/noiseprint', wrap(async (req, res) => {
    findAsset(req.params.id, req.params.aid);
    await fs.rm(printFile(req.params.id, req.params.aid), { force: true });
    res.status(204).end();
  }));
  api.post('/projects/:id/assets/:aid/denoise-print', json, wrap(async (req, res) => {
    res.status(201).json(await denoisePrint(req.params.id, req.params.aid, req.body || {}, actorOf(req)));
  }));
  api.get('/projects/:id/assets/:aid/pitch', wrap(async (req, res) => res.json(await pitch(req.params.id, req.params.aid, req.query))));
  api.get('/projects/:id/assets/:aid/spectrogram', wrap(async (req, res) => {
    const { png, meta } = await spectrogram(req.params.id, req.params.aid, req.query);
    res.set({
      'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Freq-Min': String(meta.minHz), 'X-Freq-Max': String(meta.maxHz), 'X-Freq-Scale': 'log',
      'X-Time-Start': String(meta.start), 'X-Time-End': String(meta.end),
      'Access-Control-Expose-Headers': 'X-Freq-Min, X-Freq-Max, X-Freq-Scale, X-Time-Start, X-Time-End',
    });
    res.send(png);
  }));

  // ── MCP ────────────────────────────────────────────────────────────────
  const target = {
    projectId: { type: 'string', description: 'Project id (prj_…)' },
    assetId: { type: 'string', description: 'Asset to edit (ast_…). Or give clipId to use that clip\'s asset.' },
    clipId: { type: 'string', description: 'Alternative to assetId: the clip whose asset is edited. Times stay in asset/source seconds.' },
  };
  const resolveAsset = (a) => {
    if (a.assetId) return a.assetId;
    if (a.clipId) return findClip(store.get(a.projectId), a.clipId).clip.assetId;
    throw new OpError('Give assetId or clipId', 'invalid_args', 400);
  };
  const strip = (a, keys) => Object.fromEntries(Object.entries(a).filter(([k, v]) => !keys.includes(k) && v !== undefined));
  const TIME_NOTE = 'All times are seconds in asset/source time, not timeline time. A clip maps source to timeline as timeline = clip.start + (source − clip.offset), i.e. source = clip.offset + (timeline − clip.start).';

  mcpTools.push({
    name: 'spectral_edit',
    description: `Audition-style spectral editing of an asset on a time × frequency region. The region is ONE of: a box (start, end, optional lowHz/highHz); a lasso polygon ([[t, hz], …], for shapes that follow a sweep or a slanted chirp); or brush strokes ({points:[[t, hz], …], radiusMs, radiusSemitones}, for painting along a whistle, a harmonic or onto single clicks). action "attenuate" scales the region by gainDb with smooth edges (e.g. take a whistle at 2.9–3.2 kHz down by 30 dB); action "heal" rebuilds it, per frequency, from the audio right before and after it — use it for coughs, clicks, mouth noises, a phone ring or a chair squeak inside speech. heal + strokes is the spot healing brush: e.g. strokes:[{points:[[12.304, 3000]], radiusMs: 8, radiusSemitones: 24}] removes one click. Keep regions tight (heal works best under ~1 s; look first with spectral_image). Creates a new asset ("… · spectral edit"), swaps it into every clip using the old one as one undoable step. ${TIME_NOTE} Frequencies in Hz.`,
    inputSchema: { type: 'object', properties: { ...target, ...EDIT_PROPS }, required: ['projectId', 'action'] },
    handler: async (a, actor) => spectralEdit(a.projectId, resolveAsset(a), strip(a, ['projectId', 'assetId', 'clipId']), actor),
  });
  mcpTools.push({
    name: 'noise_reduction',
    description: `Noise-print noise reduction (like Audition's Capture Noise Print + Noise Reduction). Best for steady noise: hiss, fan, air-con, hum, room tone. Give start/end of a stretch that contains ONLY the noise (room tone before someone speaks, ≥ 0.1 s, ideally 0.5–2 s): the print is learned from it, stored on the asset, and applied to the whole asset in one call. Without start/end the stored print of this asset (or the asset it was made from, or profileFrom) is reused. learnOnly:true only captures the print and returns its description (level, band balance, tonal peaks such as 50/60 Hz hum). Applying creates a new asset ("… · noise reduction") and swaps it into clips (one undo step); the result reports the noise level in the print range before/after. ${TIME_NOTE}`,
    inputSchema: { type: 'object', properties: { ...target, ...DENOISE_PROPS, learnOnly: { type: 'boolean', description: 'Only capture the noise print from start/end, do not process' } }, required: ['projectId'] },
    handler: async (a, actor) => {
      const aid = resolveAsset(a);
      if (a.learnOnly) {
        if (a.start === undefined || a.end === undefined) throw new OpError('learnOnly needs start and end', 'invalid_args', 400);
        return learnPrint(a.projectId, aid, { start: a.start, end: a.end }, actor);
      }
      return denoisePrint(a.projectId, aid, strip(a, ['projectId', 'assetId', 'clipId', 'learnOnly']), actor);
    },
  });
  mcpTools.push({
    name: 'get_pitch',
    description: `Fundamental-frequency (pitch) track of an asset, measured with YIN every 10 ms on a mono mix. Returns a summary (medianHz, minHz/maxHz after a 5-frame median so single octave slips do not count, p10Hz/p90Hz, voicedFraction, meanConfidence) and the track as [t, hz|null, confidence] decimated to maxPoints (default 120; median of the voiced frames per point). Use it to check a voice (typical speaking f0: ~85–180 Hz lower voices, ~165–255 Hz higher voices), find where someone is speaking (voiced) versus noise, or verify a pitch shift. With clipId and no start/end, measures the clip's source window. ${TIME_NOTE}`,
    inputSchema: { type: 'object', properties: { ...target, start: EDIT_PROPS.start, end: EDIT_PROPS.end, minHz: num('Lowest pitch searched (default 50)', { minimum: 20 }), maxHz: num('Highest pitch searched (default 1000)', { maximum: 4000 }), maxPoints: { type: 'integer', minimum: 10, maximum: 5000, description: 'Track points returned (default 120)' } }, required: ['projectId'] },
    handler: async (a) => {
      const aid = resolveAsset(a);
      let { start, end } = a;
      if (a.clipId && !a.assetId && start === undefined && end === undefined) {
        const { clip } = findClip(store.get(a.projectId), a.clipId);
        start = clip.offset; end = clip.offset + clip.duration;
      }
      return pitch(a.projectId, aid, { start, end, minHz: a.minHz, maxHz: a.maxHz, maxPoints: a.maxPoints ?? 120 });
    },
  });
  mcpTools.push({
    name: 'spectral_image',
    description: `Look at an asset's spectrogram rendered by NyxMix's own STFT, with an exact pixel → (time, Hz) mapping (returned as text next to the image) so you can read off rectangles for spectral_edit. Log-frequency axis (bottom = minHz, top = maxHz), no axis decorations. With clipId and no start/end, shows the clip's source window. ${TIME_NOTE}`,
    inputSchema: { type: 'object', properties: { ...target, start: EDIT_PROPS.start, end: EDIT_PROPS.end, width: { type: 'integer', minimum: 100, maximum: 4000, description: 'default 1200' }, height: { type: 'integer', minimum: 64, maximum: 2000, description: 'default 400' }, minHz: num('Bottom edge, default 30'), maxHz: num('Top edge, default Nyquist') }, required: ['projectId'] },
    handler: async (a) => {
      const aid = resolveAsset(a);
      let { start, end } = a;
      if (a.clipId && !a.assetId && start === undefined && end === undefined) {
        const { clip } = findClip(store.get(a.projectId), a.clipId);
        start = clip.offset; end = clip.offset + clip.duration;
      }
      const { png, meta } = await spectrogram(a.projectId, aid, { start, end, width: a.width, height: a.height ?? 400, minHz: a.minHz, maxHz: a.maxHz });
      return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: mappingText(meta) }] };
    },
  });
}
