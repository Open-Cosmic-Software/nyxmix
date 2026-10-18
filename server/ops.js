// The operation catalogue. Every edit — from the UI, REST, or MCP — is one of these.
// Each op: description, JSON schema for args, and a pure apply(project, args) -> result.
import { randomBytes } from 'node:crypto';
import { EFFECTS, effectDefaults, automationAt, automatableParams } from '../public/js/engine/graph.js';
import { ValidationError } from './validate.js';
import { PRESETS } from '../public/js/engine/presets.js';

export const newId = (prefix) => `${prefix}_${randomBytes(4).toString('hex')}`;
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const TRACK_COLORS = ['#5cc8f0', '#6fb7c9', '#d9748f', '#9cc46b', '#b49be0', '#e07f52', '#5fa58f', '#c9b458'];

class OpError extends Error {
  constructor(msg, code = 'op_failed', status = 422) { super(msg); this.code = code; this.status = status; }
}
const notFound = (what, id) => new OpError(`${what} ${id} not found`, 'not_found', 404);

const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const bool = (description) => ({ type: 'boolean', description });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export function findTrack(p, id) {
  const t = p.tracks.find((t) => t.id === id);
  if (!t) throw notFound('Track', id);
  return t;
}
export function findClip(p, id) {
  for (const track of p.tracks) {
    const index = track.clips.findIndex((c) => c.id === id);
    if (index >= 0) return { track, clip: track.clips[index], index };
  }
  throw notFound('Clip', id);
}
function findAsset(p, id) {
  const a = p.assets.find((a) => a.id === id);
  if (!a) throw notFound('Asset', id);
  return a;
}
function findEffect(p, id) {
  const owners = [{ owner: 'master', list: p.master.effects }, ...p.tracks.map((t) => ({ owner: t.id, list: t.effects }))];
  for (const o of owners) {
    const index = o.list.findIndex((e) => e.id === id);
    if (index >= 0) return { ...o, index, effect: o.list[index] };
  }
  throw notFound('Effect', id);
}
function checkEffectParams(type, params = {}) {
  const def = Object.hasOwn(EFFECTS, type) ? EFFECTS[type] : null;
  if (!def) throw new ValidationError(`Unknown effect type "${type}". Built-in: ${Object.keys(EFFECTS).filter((k) => !k.startsWith('plugin:')).join(', ')}; plugins: GET /api/plugins`);
  for (const [k, v] of Object.entries(params)) {
    const spec = Object.hasOwn(def.params, k) ? def.params[k] : null;
    if (!spec) throw new ValidationError(`${type} has no parameter "${k}" (has: ${Object.keys(def.params).join(', ')})`);
    if (spec.type === 'string') {
      if (typeof v !== 'string' || !/^ast_[a-f0-9]+$/.test(v)) throw new ValidationError(`${type}.${k} must be an asset id (ast_…) from the bin`);
      continue;
    }
    if (typeof v !== 'number' || v < spec.minimum || v > spec.maximum) {
      throw new ValidationError(`${type}.${k} must be a number in [${spec.minimum}, ${spec.maximum}]${spec.unit ? ' ' + spec.unit : ''}`);
    }
  }
}
function clampFades(c) {
  c.fadeIn = r6(Math.max(0, Math.min(c.fadeIn || 0, c.duration)));
  c.fadeOut = r6(Math.max(0, Math.min(c.fadeOut || 0, c.duration - c.fadeIn)));
}
function sortClips(track) { track.clips.sort((a, b) => a.start - b.start); }

// Like Audition, the clip you just placed or moved goes on top of anything it overlaps.
function raiseIfOverlapping(track, clip) {
  const others = track.clips.filter((o) => o !== clip && o.start < clip.start + clip.duration - 1e-6 && clip.start < o.start + o.duration - 1e-6);
  if (!others.length) return;
  const top = Math.max(...others.map((o) => o.z || 0));
  if ((clip.z || 0) <= top) clip.z = top + 1;
}

// Like Audition: when a clip is placed so it overlaps a neighbour on the same
// track, the overlap becomes an equal-length crossfade.
function autoCrossfade(track, changedIds) {
  const cs = track.clips;
  for (let i = 0; i < cs.length; i++) for (let k = i + 1; k < cs.length; k++) {
    const a = cs[i], b = cs[k];
    if (b.start >= a.start + a.duration - 1e-6) break;
    if (!changedIds.has(a.id) && !changedIds.has(b.id)) continue;
    const overlap = r6(a.start + a.duration - b.start);
    if (overlap <= 0 || b.start + b.duration <= a.start + a.duration) continue; // fully contained: leave as is
    a.fadeOut = overlap; b.fadeIn = overlap;
    a.fadeOutShape = 'equalPower'; b.fadeInShape = 'equalPower';
    a.autoFadeOut = true; b.autoFadeIn = true;
    clampFades(a); clampFades(b);
  }
  // Crossfades we created earlier go away once the clips no longer overlap.
  for (const c of cs) {
    const end = c.start + c.duration;
    if (c.autoFadeIn && !cs.some((o) => o !== c && o.start < c.start && o.start + o.duration > c.start + 1e-6)) { c.fadeIn = 0; delete c.autoFadeIn; delete c.fadeInShape; }
    if (c.autoFadeOut && !cs.some((o) => o !== c && o.start > c.start && o.start < end - 1e-6)) { c.fadeOut = 0; delete c.autoFadeOut; delete c.fadeOutShape; }
  }
}

const shapeEnum = { type: 'string', enum: ['linear', 'equalPower', 'sCurve', 'exponential'] };
const clipProps = {
  rate: num('Varispeed: playback rate of the clip (0.25–4; 2 = twice as fast and an octave up, like tape). Changing it keeps the same source audio, so the clip gets shorter or longer.', { minimum: 0.25, maximum: 4 }),
  z: { type: 'integer', minimum: -1000, maximum: 1000, description: 'Stacking order: where clips overlap (and the overlap is not a crossfade), the higher z plays and covers the lower clip' },
  loop: bool('Loop the clip: its source piece (offset … offset+loopLength) repeats when the clip is longer than it, like Audition\'s looping clips'),
  loopLength: num('Length of the repeated source piece in seconds (set automatically when loop is turned on)', { minimum: 0.01 }),
  crossfade: bool('Turn overlaps with neighbours into crossfades (default true)'),
  fadeInShape: { ...shapeEnum, description: 'Fade-in curve (default linear; equalPower for crossfades)' },
  fadeOutShape: { ...shapeEnum, description: 'Fade-out curve' },
  start: num('Timeline position in seconds', { minimum: 0 }),
  offset: num('Where in the source asset the clip begins, seconds', { minimum: 0 }),
  duration: num('Clip length in seconds', { minimum: 0.001 }),
  gain: num('Clip gain in dB', { minimum: -60, maximum: 24 }),
  fadeIn: num('Fade-in length in seconds', { minimum: 0 }),
  fadeOut: num('Fade-out length in seconds', { minimum: 0 }),
  name: str('Display name', { maxLength: 200 }),
};

export const OPS = {};
function op(name, description, schema, apply) { OPS[name] = { name, description, schema, apply }; }

// ── project ──────────────────────────────────────────────────────────────
op('project.rename', 'Rename the project.', obj({ name: str('New name', { maxLength: 200 }) }, ['name']),
  (p, a) => { p.name = a.name; return {}; });

export const META_FIELDS = ['title', 'artist', 'album', 'album_artist', 'genre', 'date', 'track', 'comment', 'copyright', 'publisher', 'composer', 'language', 'isrc'];
op('project.setMetadata', `Set export metadata tags (ID3 in MP3, Vorbis comments in FLAC/Opus, iTunes atoms in M4A, INFO in WAV). Fields: ${META_FIELDS.join(', ')}. title defaults to the session name. Empty string removes a field.`,
  obj(Object.fromEntries(META_FIELDS.map((k) => [k, str(k, { maxLength: 500 })]))),
  (p, a) => {
    p.metadata ||= {};
    for (const [k, v] of Object.entries(a)) { if (v === '') delete p.metadata[k]; else p.metadata[k] = v; }
    return { metadata: p.metadata };
  });

op('project.setLayout', 'Switch the session between stereo and 5.1 surround. In 5.1 every track gets a surround position (track.update pan = left/right, surroundY = back/front, lfe = low-frequency send in dB); buses and the master carry six channels; exports are 6-channel (L R C LFE Ls Rs) except MP3, which is folded down to stereo.',
  obj({ layout: str('stereo or 5.1', { enum: ['stereo', '5.1'] }) }, ['layout']),
  (p, a) => { if (a.layout === '5.1') p.channels = 6; else delete p.channels; return { channels: p.channels || 2 }; });

op('master.update', 'Change the master bus output gain.', obj({ gain: num('Master gain in dB', { minimum: -60, maximum: 12 }) }, ['gain']),
  (p, a) => { p.master.gain = a.gain; return {}; });

// ── tracks ───────────────────────────────────────────────────────────────
op('track.add', 'Add an empty audio track, or a bus (kind:"bus") that other tracks feed via output routing or sends — e.g. one shared reverb for several voices. Returns trackId.',
  obj({ name: str('Track name', { maxLength: 100 }), kind: str('audio (default) or bus', { enum: ['audio', 'bus'] }), color: str('CSS hex color'), index: { type: 'integer', minimum: 0, description: 'Position; default = last' } }),
  (p, a) => {
    const bus = a.kind === 'bus';
    const t = {
      id: newId('trk'), name: a.name || (bus ? `Bus ${p.tracks.filter((x) => x.kind === 'bus').length + 1}` : `Track ${p.tracks.length + 1}`),
      ...(bus ? { kind: 'bus' } : { sends: [] }),
      color: a.color || TRACK_COLORS[p.tracks.length % TRACK_COLORS.length],
      gain: 0, pan: 0, mute: false, solo: false, effects: [], clips: [],
    };
    const i = a.index === undefined ? p.tracks.length : Math.min(a.index, p.tracks.length);
    p.tracks.splice(i, 0, t);
    return { trackId: t.id };
  });

op('track.update', 'Change track name, volume, pan, mute, solo, color, or output routing (output = a bus trackId, or "master").',
  obj({
    trackId: str('Track id'), name: str('Track name', { maxLength: 100 }),
    output: str('"master" or the id of a bus track'),
    surroundY: num('5.1 only: front/back position, 1 = front (default) … -1 = back', { minimum: -1, maximum: 1 }),
    lfe: num('5.1 only: send to the LFE channel in dB (-60 = off)', { minimum: -60, maximum: 6 }),
    gain: num('Track volume in dB', { minimum: -60, maximum: 12 }),
    pan: num('Stereo pan, -1 left … 1 right', { minimum: -1, maximum: 1 }),
    mute: bool('Mute'), solo: bool('Solo'), color: str('CSS hex color'),
  }, ['trackId']),
  (p, a) => {
    const t = findTrack(p, a.trackId);
    for (const k of ['name', 'gain', 'pan', 'mute', 'solo', 'color', 'surroundY', 'lfe']) if (a[k] !== undefined) t[k] = a[k];
    if (a.output !== undefined) {
      if (a.output === 'master' || a.output === '') delete t.output;
      else {
        if (t.kind === 'bus') throw new OpError('Buses always feed the master');
        const b = findTrack(p, a.output);
        if (b.kind !== 'bus') throw new OpError(`${a.output} is not a bus`);
        t.output = b.id;
      }
    }
    return {};
  });

op('track.remove', 'Delete a track and all its clips. Removing a bus reroutes its inputs to the master.', obj({ trackId: str('Track id') }, ['trackId']),
  (p, a) => {
    findTrack(p, a.trackId);
    p.tracks = p.tracks.filter((t) => t.id !== a.trackId);
    for (const t of p.tracks) {
      if (t.output === a.trackId) delete t.output;
      if (t.sends) t.sends = t.sends.filter((x) => x.busId !== a.trackId);
    }
    return {};
  });

op('send.add', 'Send part of a track\'s signal to a bus (post-fader by default). Returns sendId.',
  obj({ trackId: str('Source track id'), busId: str('Bus track id'), level: num('Send level in dB (default -6)', { minimum: -60, maximum: 6 }), pre: bool('Pre-fader send (independent of the track volume)') }, ['trackId', 'busId']),
  (p, a) => {
    const t = findTrack(p, a.trackId), b = findTrack(p, a.busId);
    if (b.kind !== 'bus') throw new OpError(`${a.busId} is not a bus`);
    if (t.kind === 'bus') throw new OpError('Buses cannot send to other buses');
    t.sends ||= [];
    if (t.sends.some((x) => x.busId === b.id)) throw new OpError('This track already sends to that bus; use send.update');
    const s = { id: newId('snd'), busId: b.id, level: a.level ?? -6, pre: !!a.pre };
    t.sends.push(s);
    return { sendId: s.id };
  });

function findSend(p, id) {
  for (const t of p.tracks) { const i = (t.sends || []).findIndex((x) => x.id === id); if (i >= 0) return { track: t, index: i, send: t.sends[i] }; }
  throw notFound('Send', id);
}
op('send.update', 'Change a send\'s level or pre/post-fader mode.', obj({ sendId: str('Send id'), level: num('dB', { minimum: -60, maximum: 6 }), pre: bool('Pre-fader') }, ['sendId']),
  (p, a) => { const { send } = findSend(p, a.sendId); if (a.level !== undefined) send.level = a.level; if (a.pre !== undefined) send.pre = a.pre; return {}; });
op('send.remove', 'Remove a send.', obj({ sendId: str('Send id') }, ['sendId']),
  (p, a) => { const { track, index } = findSend(p, a.sendId); track.sends.splice(index, 1); return {}; });

op('track.move', 'Reorder a track.', obj({ trackId: str('Track id'), index: { type: 'integer', minimum: 0, description: 'New position' } }, ['trackId', 'index']),
  (p, a) => {
    const t = findTrack(p, a.trackId);
    p.tracks = p.tracks.filter((x) => x !== t);
    p.tracks.splice(Math.min(a.index, p.tracks.length), 0, t);
    return {};
  });

// ── clips ────────────────────────────────────────────────────────────────
op('clip.add', 'Place an asset on a track. Duration defaults to the rest of the asset after offset. Returns clipId.',
  obj({ trackId: str('Track id'), assetId: str('Asset id'), ...clipProps }, ['trackId', 'assetId']),
  (p, a) => {
    const t = findTrack(p, a.trackId);
    if (t.kind === 'bus') throw new OpError('Buses have no clips; place audio on an audio track and route it to the bus');
    const asset = findAsset(p, a.assetId);
    const offset = a.offset || 0;
    if (offset >= asset.duration) throw new OpError(`offset ${offset}s is beyond the asset length ${asset.duration}s`);
    const rate = a.rate || 1, avail = (asset.duration - offset) / rate;
    const c = {
      id: newId('clp'), assetId: asset.id, name: a.name || asset.name,
      start: r6(a.start || 0), offset: r6(offset),
      duration: r6(a.loop ? (a.duration ?? avail) : Math.min(a.duration ?? avail, avail)),
      ...(rate !== 1 ? { rate } : {}), ...(a.z ? { z: a.z } : {}),
      ...(a.loop ? { loop: true, loopLength: r6(Math.min(a.loopLength ?? asset.duration - offset, asset.duration - offset)) } : {}),
      gain: a.gain || 0, fadeIn: a.fadeIn || 0, fadeOut: a.fadeOut || 0,
      ...(a.fadeInShape ? { fadeInShape: a.fadeInShape } : {}), ...(a.fadeOutShape ? { fadeOutShape: a.fadeOutShape } : {}),
    };
    clampFades(c);
    t.clips.push(c); sortClips(t);
    if (a.z === undefined) raiseIfOverlapping(t, c);
    if (a.crossfade !== false) autoCrossfade(t, new Set([c.id]));
    return { clipId: c.id };
  });

op('clip.update', 'Move, trim, retime or re-level a clip. Set trackId to move it to another track.',
  obj({ clipId: str('Clip id'), trackId: str('Destination track id'), ...clipProps }, ['clipId']),
  (p, a) => {
    const { track, clip } = findClip(p, a.clipId);
    const asset = findAsset(p, clip.assetId);
    // A new rate keeps the same source span, so the clip length scales (like tape varispeed).
    if (a.rate !== undefined && a.duration === undefined) clip.duration = r6(clip.duration * (clip.rate || 1) / a.rate);
    for (const k of ['start', 'offset', 'duration', 'gain', 'fadeIn', 'fadeOut', 'name', 'fadeInShape', 'fadeOutShape', 'rate', 'z']) if (a[k] !== undefined) clip[k] = typeof a[k] === 'number' ? r6(a[k]) : a[k];
    if (clip.rate === 1) delete clip.rate;
    if (clip.z === 0) delete clip.z;
    if (a.fadeIn !== undefined || a.fadeInShape !== undefined) delete clip.autoFadeIn;
    if (a.fadeOut !== undefined || a.fadeOutShape !== undefined) delete clip.autoFadeOut;
    if (clip.offset >= asset.duration) throw new OpError(`offset ${clip.offset}s is beyond the asset length ${asset.duration}s`);
    if (a.loop === true && !clip.loop) { clip.loop = true; clip.loopLength = r6(Math.min(a.loopLength ?? clip.duration, asset.duration - clip.offset)); }
    else if (a.loop === false) { delete clip.loop; delete clip.loopLength; }
    else if (clip.loop && a.loopLength !== undefined) clip.loopLength = r6(Math.min(a.loopLength, asset.duration - clip.offset));
    if (clip.loop && clip.offset + clip.loopLength > asset.duration + 1e-6) clip.loopLength = r6(asset.duration - clip.offset);
    if (!clip.loop && clip.offset + clip.duration * (clip.rate || 1) > asset.duration + 1e-6) clip.duration = r6((asset.duration - clip.offset) / (clip.rate || 1));
    clampFades(clip);
    let dest = track;
    if (a.trackId && a.trackId !== track.id) {
      dest = findTrack(p, a.trackId);
      if (dest.kind === 'bus') throw new OpError('Buses have no clips; move it to an audio track');
      track.clips = track.clips.filter((c) => c !== clip);
      dest.clips.push(clip);
    }
    sortClips(dest);
    if ((a.start !== undefined || a.trackId) && a.z === undefined) raiseIfOverlapping(dest, clip);
    if ((a.start !== undefined || a.trackId || a.duration !== undefined || a.offset !== undefined) && a.crossfade !== false) autoCrossfade(dest, new Set([clip.id]));
    return {};
  });

op('clip.split', 'Split a clip into two at a timeline time. Returns the ids of both halves.',
  obj({ clipId: str('Clip id'), at: num('Timeline time in seconds, strictly inside the clip', { minimum: 0 }) }, ['clipId', 'at']),
  (p, a) => {
    const { track, clip } = findClip(p, a.clipId);
    const rightId = splitClip(track, clip, a.at);
    if (!rightId) throw new OpError(`at=${a.at}s is not inside clip ${clip.id} (${clip.start}–${r6(clip.start + clip.duration)}s)`);
    return { leftId: clip.id, rightId };
  });

function splitClip(track, clip, at) {
  const rel = at - clip.start;
  if (rel <= 1e-4 || rel >= clip.duration - 1e-4) return null;
  const right = { ...clip, id: newId('clp'), start: r6(at), offset: r6(clip.offset + rel * (clip.rate || 1)), duration: r6(clip.duration - rel), fadeIn: 0 };
  clip.duration = r6(rel); clip.fadeOut = 0;
  clampFades(clip); clampFades(right);
  track.clips.push(right); sortClips(track);
  return right.id;
}

op('clip.replaceSource', 'Point a clip at a different asset window (used after stretching or re-rendering its audio). Keeps position, gain and fades.',
  obj({ clipId: str('Clip id'), assetId: str('New asset id'), offset: num('Source offset, seconds', { minimum: 0 }), duration: num('New clip length, seconds', { minimum: 0.001 }) }, ['clipId', 'assetId']),
  (p, a) => {
    const { track, clip } = findClip(p, a.clipId);
    const asset = findAsset(p, a.assetId);
    clip.assetId = asset.id;
    clip.offset = r6(a.offset ?? 0);
    clip.duration = r6(Math.min(a.duration ?? asset.duration - clip.offset, asset.duration - clip.offset));
    if (clip.duration <= 0) throw new OpError('The new source window is empty');
    clampFades(clip); sortClips(track); autoCrossfade(track, new Set([clip.id]));
    return {};
  });

op('clip.envelope', 'Set a clip\'s volume envelope (keyframes that move with the clip — Audition\'s clip volume keyframes). Point times are SOURCE seconds (clip.offset … clip.offset+duration; timeline = clip.start + time − clip.offset), values in dB added to clip gain. Empty list removes it.',
  obj({ clipId: str('Clip id'), points: { type: 'array', items: { type: 'object', properties: { time: num('Source seconds', { minimum: 0 }), value: num('dB', { minimum: -60, maximum: 24 }) }, required: ['time', 'value'], additionalProperties: false } } }, ['clipId', 'points']),
  (p, a) => {
    const { clip } = findClip(p, a.clipId);
    const pts = [...a.points].map((x) => ({ time: r6(x.time), value: r6(x.value) })).sort((x, y) => x.time - y.time);
    if (pts.length) clip.envelope = pts; else delete clip.envelope;
    return { points: pts.length };
  });

op('clip.setMarkers', 'Set markers that belong to a clip and move with it (Audition: clip markers in Multitrack). Times are SOURCE seconds inside the clip (timeline = clip.start + (time − clip.offset) / rate). Empty list removes them.',
  obj({ clipId: str('Clip id'), markers: { type: 'array', items: { type: 'object', properties: { time: num('Source seconds', { minimum: 0 }), label: str('Text', { maxLength: 200 }) }, required: ['time'], additionalProperties: false } } }, ['clipId', 'markers']),
  (p, a) => {
    const { clip } = findClip(p, a.clipId);
    const ms = a.markers.map((m) => ({ time: r6(m.time), label: m.label || '' })).sort((x, y) => x.time - y.time);
    if (ms.length) clip.markers = ms; else delete clip.markers;
    return { markers: ms.length };
  });

op('clip.remove', 'Delete a clip (leaves a gap).', obj({ clipId: str('Clip id') }, ['clipId']),
  (p, a) => { const { track, clip } = findClip(p, a.clipId); track.clips = track.clips.filter((c) => c !== clip); return {}; });

op('clip.duplicate', 'Copy a clip. Defaults to right after the original on the same track. Returns clipId.',
  obj({ clipId: str('Clip id'), start: num('Timeline position of the copy', { minimum: 0 }), trackId: str('Destination track id') }, ['clipId']),
  (p, a) => {
    const { track, clip } = findClip(p, a.clipId);
    const dest = a.trackId ? findTrack(p, a.trackId) : track;
    if (dest.kind === 'bus') throw new OpError('Buses have no clips; copy it to an audio track');
    const c = { ...clip, id: newId('clp'), start: r6(a.start ?? clip.start + clip.duration) };
    dest.clips.push(c); sortClips(dest);
    raiseIfOverlapping(dest, c);
    autoCrossfade(dest, new Set([c.id]));
    return { clipId: c.id };
  });

// ── ranges (the agent's scalpel) ─────────────────────────────────────────
const MIN_REMNANT = 0.02;
op('range.delete', 'Cut a time range out of the timeline across tracks (e.g. remove an "um" or a long pause). With ripple (default), everything after the range moves left to close the gap. Short fades are added at the cut edges to avoid clicks. Pieces of a clip shorter than 20 ms left over by the cut are removed too.',
  obj({
    start: num('Range start, seconds', { minimum: 0 }), end: num('Range end, seconds', { minimum: 0 }),
    trackIds: { type: 'array', items: { type: 'string' }, description: 'Limit to these tracks; default all' },
    ripple: bool('Close the gap (default true)'),
    moveMarkers: bool('With trackIds: still ripple the markers (default false; always true without trackIds)'),
    crossfade: num('Fade length at cut edges in ms (default 5)', { minimum: 0, maximum: 500 }),
  }, ['start', 'end']),
  (p, a) => {
    if (a.end <= a.start) throw new OpError('end must be greater than start');
    const ripple = a.ripple !== false;
    const fade = (a.crossfade ?? 5) / 1000;
    const len = a.end - a.start;
    const tracks = a.trackIds ? a.trackIds.map((id) => findTrack(p, id)) : p.tracks;
    let removed = 0;
    for (const t of tracks) {
      const out = [];
      for (const c of t.clips) {
        const cs = c.start, ce = c.start + c.duration;
        if (ce <= a.start) { out.push(c); continue; }
        if (cs >= a.end) { if (ripple) c.start = r6(c.start - len); out.push(c); continue; }
        removed++;
        // Remnants shorter than 20 ms (rounding slivers at clip edges) are removed with the cut.
        if (cs < a.start && a.start - cs >= MIN_REMNANT) {
          out.push({ ...c, duration: r6(a.start - cs), fadeOut: Math.min(fade, a.start - cs) });
        }
        if (ce > a.end && ce - a.end >= MIN_REMNANT) {
          out.push({
            ...c, id: cs < a.start ? newId('clp') : c.id,
            start: r6(ripple ? a.start : a.end), offset: r6(c.offset + (a.end - cs) * (c.rate || 1)),
            duration: r6(ce - a.end), fadeIn: Math.min(fade, ce - a.end), fadeOut: c.fadeOut,
          });
        }
      }
      out.forEach(clampFades);
      t.clips = out; sortClips(t);
      if (ripple) for (const param of Object.keys(t.automation || {})) {
        const pts = t.automation[param];
        if (!pts.length) continue;
        const atStart = automationAt(pts, a.start, 0), atEnd = automationAt(pts, a.end, 0);
        const kept = pts.filter((pt) => pt.time < a.start || pt.time > a.end).map((pt) => (pt.time > a.end ? { ...pt, time: r6(pt.time - len) } : pt));
        // Keep the envelope continuous at the cut.
        if (pts.some((pt) => pt.time >= a.start)) kept.push({ time: r6(a.start), value: atStart }, { time: r6(a.start + 1e-4), value: atEnd });
        t.automation[param] = kept.sort((x, y) => x.time - y.time);
      }
    }
    if (ripple && (!a.trackIds || a.moveMarkers)) {
      p.markers = p.markers.filter((m) => m.time < a.start || m.time >= a.end);
      for (const m of p.markers) if (m.time >= a.end) m.time = r6(m.time - len);
    }
    return { affectedClips: removed };
  });

op('range.insertSilence', 'Open a gap at a time by pushing everything after it to the right.',
  obj({ at: num('Time, seconds', { minimum: 0 }), duration: num('Gap length, seconds', { minimum: 0.001 }),
    trackIds: { type: 'array', items: { type: 'string' }, description: 'Limit to these tracks; default all' } }, ['at', 'duration']),
  (p, a) => {
    const tracks = a.trackIds ? a.trackIds.map((id) => findTrack(p, id)) : p.tracks;
    for (const t of tracks) {
      for (const c of [...t.clips]) if (c.start < a.at && c.start + c.duration > a.at) splitClip(t, c, a.at);
      for (const c of t.clips) if (c.start >= a.at - 1e-6) c.start = r6(c.start + a.duration);
      sortClips(t);
      for (const param of Object.keys(t.automation || {})) {
        const pts = t.automation[param];
        if (!pts.length) continue;
        const v = automationAt(pts, a.at, 0);
        t.automation[param] = [...pts.filter((pt) => pt.time < a.at), { time: r6(a.at), value: v }, { time: r6(a.at + a.duration), value: v }, ...pts.filter((pt) => pt.time >= a.at).map((pt) => ({ ...pt, time: r6(pt.time + a.duration) }))];
      }
    }
    if (!a.trackIds) for (const m of p.markers) if (m.time >= a.at) m.time = r6(m.time + a.duration);
    return {};
  });

// ── effects ──────────────────────────────────────────────────────────────
const effectTypes = Object.keys(EFFECTS);
op('effect.add', `Insert a real-time effect on a track (or on the master bus if trackId is omitted). Types: ${effectTypes.join(', ')}. See GET /api/effects for parameters. Returns effectId.`,
  obj({ trackId: str('Track id; omit for master'), type: str('Effect type (built-in, or "plugin:<id>" for installed plugins)', { maxLength: 80 }),
    params: { type: 'object', description: 'Parameter overrides; unspecified ones use defaults' },
    index: { type: 'integer', minimum: 0, description: 'Position in the chain; default = last' } }, ['type']),
  (p, a) => {
    checkEffectParams(a.type, a.params);
    const list = a.trackId ? findTrack(p, a.trackId).effects : p.master.effects;
    const fx = { id: newId('fx'), type: a.type, enabled: true, params: { ...effectDefaults(a.type), ...(a.params || {}) } };
    list.splice(a.index === undefined ? list.length : Math.min(a.index, list.length), 0, fx);
    return { effectId: fx.id };
  });

op('effect.update', 'Change effect parameters or bypass it.',
  obj({ effectId: str('Effect id'), params: { type: 'object', description: 'Parameters to change' }, enabled: bool('false = bypass') }, ['effectId']),
  (p, a) => {
    const { effect } = findEffect(p, a.effectId);
    if (a.params) { checkEffectParams(effect.type, a.params); Object.assign(effect.params, a.params); }
    if (a.enabled !== undefined) effect.enabled = a.enabled;
    return {};
  });

op('effect.remove', 'Remove an effect.', obj({ effectId: str('Effect id') }, ['effectId']),
  (p, a) => {
    const { list, index } = findEffect(p, a.effectId);
    list.splice(index, 1);
    for (const o of [p.master, ...p.tracks]) for (const k of Object.keys(o.automation || {})) if (k.startsWith(`fx:${a.effectId}:`)) delete o.automation[k];
    return {};
  });

op('effect.move', 'Reorder an effect within its chain.', obj({ effectId: str('Effect id'), index: { type: 'integer', minimum: 0 } }, ['effectId', 'index']),
  (p, a) => { const { list, index, effect } = findEffect(p, a.effectId); list.splice(index, 1); list.splice(Math.min(a.index, list.length), 0, effect); return {}; });

op('preset.apply', `Append a ready-made effect chain to a track (or the master if trackId is omitted). Presets: ${Object.entries(PRESETS).map(([k, v]) => `${k} (${v.target}: ${v.description})`).join('; ')}. Set replace:true to clear the chain first. Returns effectIds.`,
  obj({ trackId: str('Track id; omit for master'), preset: str('Preset id', { enum: Object.keys(PRESETS) }), replace: bool('Remove existing effects first') }, ['preset']),
  (p, a) => {
    const preset = PRESETS[a.preset];
    const list = a.trackId ? findTrack(p, a.trackId).effects : p.master.effects;
    if (a.replace) list.length = 0;
    const effectIds = [];
    for (const e of preset.effects) {
      const fx = { id: newId('fx'), type: e.type, enabled: true, params: { ...effectDefaults(e.type), ...e.params } };
      list.push(fx); effectIds.push(fx.id);
    }
    return { effectIds };
  });

// ── automation ───────────────────────────────────────────────────────────
const AUTO_RANGE = { volume: [-60, 12], pan: [-1, 1] };
const autoParam = { type: 'string', maxLength: 80, description: 'volume (dB relative to the fader, 0 = unchanged), pan (-1 left … 1 right), or an effect parameter as "fx:<effectId>:<param>" in that parameter\'s own units (see GET /api/effects; automatable params are listed per effect)' };
const pointSchema = { type: 'object', properties: { time: num('Timeline seconds', { minimum: 0 }), value: num('dB for volume, -1…1 for pan') }, required: ['time', 'value'], additionalProperties: false };
// Owner of an automation lane: a track, or the master bus (trackId "master", effect params only).
function autoOwner(p, trackId) {
  if (trackId === 'master') return p.master;
  return findTrack(p, trackId);
}
function autoRange(p, owner, param) {
  if (AUTO_RANGE[param]) {
    if (owner === p.master) throw new ValidationError('The master bus only automates effect parameters; use master.update for its level');
    return AUTO_RANGE[param];
  }
  const m = /^fx:(fx_[a-f0-9]+):(\w+)$/.exec(param);
  if (!m) throw new ValidationError('param must be volume, pan or fx:<effectId>:<param>');
  const fx = owner.effects.find((e) => e.id === m[1]);
  if (!fx) throw new ValidationError(`Effect ${m[1]} is not on this ${owner === p.master ? 'master bus' : 'track'}`);
  if (!automatableParams(fx.type).includes(m[2])) throw new ValidationError(`${fx.type}.${m[2]} cannot be automated (automatable: ${automatableParams(fx.type).join(', ') || 'none'})`);
  const spec = EFFECTS[fx.type].params[m[2]];
  return [spec.minimum, spec.maximum];
}
function setPoints(track, param, points, range) {
  const [lo, hi] = range || AUTO_RANGE[param];
  for (const pt of points) if (pt.value < lo || pt.value > hi) throw new ValidationError(`${param} automation values must be within [${lo}, ${hi}]`);
  const sorted = [...points].map((pt) => ({ time: r6(pt.time), value: r6(pt.value) })).sort((a, b) => a.time - b.time);
  const out = [];
  for (const pt of sorted) { if (out.length && Math.abs(out[out.length - 1].time - pt.time) < 1e-6) out[out.length - 1] = pt; else out.push(pt); }
  track.automation ||= {};
  track.automation[param] = out;
  return out.length;
}

op('automation.set', 'Replace a track\'s volume, pan or effect-parameter automation (trackId "master" for master-bus effects) with these points (linear between points; flat before the first and after the last). Volume is in dB on top of the fader, so a "duck" is e.g. [{time:10,value:0},{time:10.3,value:-12},{time:20,value:-12},{time:20.8,value:0}]. Empty list removes automation.',
  obj({ trackId: str('Track id'), param: autoParam, points: { type: 'array', items: pointSchema } }, ['trackId', 'param', 'points']),
  (p, a) => { const o = autoOwner(p, a.trackId); return { points: setPoints(o, a.param, a.points, autoRange(p, o, a.param)) }; });

op('automation.addPoint', 'Add (or replace at the same time) one automation point.',
  obj({ trackId: str('Track id'), param: autoParam, time: num('Timeline seconds', { minimum: 0 }), value: num('dB for volume, -1…1 for pan') }, ['trackId', 'param', 'time', 'value']),
  (p, a) => { const t = autoOwner(p, a.trackId); return { points: setPoints(t, a.param, [...(t.automation?.[a.param] || []), { time: a.time, value: a.value }], autoRange(p, t, a.param)) }; });

op('automation.removeRange', 'Delete automation points between start and end (inclusive).',
  obj({ trackId: str('Track id'), param: autoParam, start: num('Seconds', { minimum: 0 }), end: num('Seconds', { minimum: 0 }) }, ['trackId', 'param', 'start', 'end']),
  (p, a) => { const t = autoOwner(p, a.trackId); const pts = (t.automation?.[a.param] || []).filter((pt) => pt.time < a.start - 1e-9 || pt.time > a.end + 1e-9); return { points: setPoints(t, a.param, pts, autoRange(p, t, a.param)) }; });

// ── markers ──────────────────────────────────────────────────────────────
op('marker.add', 'Add a marker (a point, or a range if duration is given). Useful to flag things for humans to review. Returns markerId.',
  obj({ time: num('Seconds', { minimum: 0 }), duration: num('Range length, seconds', { minimum: 0 }), label: str('Text', { maxLength: 300 }) }, ['time']),
  (p, a) => {
    const m = { id: newId('mrk'), time: r6(a.time), duration: r6(a.duration || 0), label: a.label || '' };
    p.markers.push(m); p.markers.sort((x, y) => x.time - y.time);
    return { markerId: m.id };
  });

op('marker.update', 'Edit a marker.', obj({ markerId: str('Marker id'), time: num('Seconds', { minimum: 0 }), duration: num('Seconds', { minimum: 0 }), label: str('Text', { maxLength: 300 }) }, ['markerId']),
  (p, a) => {
    const m = p.markers.find((m) => m.id === a.markerId);
    if (!m) throw notFound('Marker', a.markerId);
    for (const k of ['time', 'duration', 'label']) if (a[k] !== undefined) m[k] = a[k];
    p.markers.sort((x, y) => x.time - y.time);
    return {};
  });

op('marker.remove', 'Delete a marker.', obj({ markerId: str('Marker id') }, ['markerId']),
  (p, a) => { const n = p.markers.length; p.markers = p.markers.filter((m) => m.id !== a.markerId); if (n === p.markers.length) throw notFound('Marker', a.markerId); return {}; });

// ── assets (metadata only; audio import/processing are separate endpoints) ─
op('asset.rename', 'Rename an asset in the file bin.', obj({ assetId: str('Asset id'), name: str('Name', { maxLength: 200 }) }, ['assetId', 'name']),
  (p, a) => { findAsset(p, a.assetId).name = a.name; return {}; });

op('asset.replaceInClips', 'Point every clip that uses one asset at another asset of the same length (e.g. after denoising).',
  obj({ fromAssetId: str('Old asset id'), toAssetId: str('New asset id') }, ['fromAssetId', 'toAssetId']),
  (p, a) => {
    findAsset(p, a.fromAssetId); const to = findAsset(p, a.toAssetId);
    let n = 0;
    for (const t of p.tracks) for (const c of t.clips) if (c.assetId === a.fromAssetId) {
      if (c.offset >= to.duration) throw new OpError(`clip ${c.id} starts at ${c.offset}s in the source, beyond the length of ${to.id} (${to.duration}s)`);
      c.assetId = to.id; n++;
      if (c.offset + c.duration * (c.rate || 1) > to.duration) { c.duration = r6((to.duration - c.offset) / (c.rate || 1)); clampFades(c); }
    }
    return { clipsUpdated: n };
  });

export function describeOps() {
  return Object.values(OPS).map(({ name, description, schema }) => ({ name, description, args: schema }));
}
export { OpError };
