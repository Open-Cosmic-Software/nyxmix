// Auto-ducking: lower a music bed while voices are active, as editable volume automation.
import { renderMix, envelope } from '../audio.js';
import { validate } from '../validate.js';

const schema = {
  type: 'object', additionalProperties: false, required: ['musicTrackId'],
  properties: {
    musicTrackId: { type: 'string', description: 'Track to turn down (music / bed)' },
    voiceTrackIds: { type: 'array', items: { type: 'string' }, description: 'Tracks whose activity triggers ducking; default: every other track' },
    amount: { type: 'number', minimum: -40, maximum: -1, description: 'How far to duck, dB (default -12)' },
    threshold: { type: 'number', minimum: -70, maximum: -10, description: 'Voice level that counts as speech, dBFS RMS (default -42)' },
    attack: { type: 'number', minimum: 0.01, maximum: 3, description: 'Seconds to fade down before speech starts (default 0.3)' },
    release: { type: 'number', minimum: 0.05, maximum: 5, description: 'Seconds to come back up after speech ends (default 0.9)' },
    hold: { type: 'number', minimum: 0, maximum: 5, description: 'Pauses shorter than this stay ducked (default 0.8)' },
    start: { type: 'number', minimum: 0, description: 'Only duck from here (timeline seconds)' },
    end: { type: 'number', minimum: 0, description: 'Only duck until here' },
  },
};

export async function register({ api, json, wrap, store, mcpTools, actorOf, OpError }) {
  async function duck(pid, args, actor) {
    validate(schema, args);
    const p = store.get(pid);
    const music = p.tracks.find((t) => t.id === args.musicTrackId);
    if (!music) throw new OpError(`Track ${args.musicTrackId} not found`, 'not_found', 404);
    const voiceIds = args.voiceTrackIds || p.tracks.filter((t) => t.id !== music.id).map((t) => t.id);
    if (!voiceIds.length) throw new OpError('No voice tracks to listen to', 'invalid_args', 400);
    for (const id of voiceIds) if (!p.tracks.some((t) => t.id === id)) throw new OpError(`Track ${id} not found`, 'not_found', 404);
    const amount = args.amount ?? -12, thr = args.threshold ?? -42, attack = args.attack ?? 0.3, release = args.release ?? 0.9, hold = args.hold ?? 0.8;

    // Listen to the voices alone, after their own effects but without the master chain.
    const voicesOnly = { ...p, master: { gain: 0, effects: [] }, tracks: p.tracks.filter((t) => voiceIds.includes(t.id)).map((t) => ({ ...t, mute: false, solo: false })) };
    const start = args.start ?? 0;
    const mix = await renderMix(voicesOnly, (aid) => store.assetPath(pid, aid), { start, end: args.end });
    const step = 0.05;
    const env = envelope({ channels: mix.channels, sampleRate: mix.sampleRate, frames: mix.channels[0].length, offset: start }, step);

    // Speech regions with short gaps bridged.
    const regions = [];
    env.rmsDbfs.forEach((db, i) => {
      if (db < thr) return;
      const t0 = start + i * step, t1 = t0 + step;
      const last = regions[regions.length - 1];
      if (last && t0 - last.end <= hold) last.end = t1; else regions.push({ start: t0, end: t1 });
    });
    const speech = regions.filter((r) => r.end - r.start >= 0.15);

    const points = [];
    for (const r of speech) {
      const down = Math.max(0, r.start - attack);
      const last = points[points.length - 1];
      if (last && down <= last.time) { points.pop(); points.pop(); } // merge with the previous duck
      else points.push({ time: down, value: 0 });
      points.push({ time: r.start, value: amount }, { time: r.end, value: amount }, { time: r.end + release, value: 0 });
    }
    if (points.length && points[0].time > 0) points.unshift({ time: 0, value: 0 });
    const res = store.apply(pid, [{ op: 'automation.set', args: { trackId: music.id, param: 'volume', points: points.map((x) => ({ time: +x.time.toFixed(3), value: x.value })) } }],
      { actor, label: `Auto-ducked “${music.name}” under ${speech.length} speech passage${speech.length === 1 ? '' : 's'}` });
    return { rev: res.rev, speechRegions: speech.map((r) => ({ start: +r.start.toFixed(2), end: +r.end.toFixed(2) })), points: points.length };
  }

  api.post('/projects/:id/duck', json, wrap(async (req, res) => res.json(await duck(req.params.id, req.body || {}, actorOf(req)))));

  mcpTools.push({
    name: 'auto_duck',
    description: 'Lower a music/bed track automatically wherever the voice tracks are speaking. Writes volume automation on the music track (replacing its existing volume automation) — one undoable step; the human can fine-tune the points afterwards. Returns the detected speech regions.',
    inputSchema: { ...schema, properties: { projectId: { type: 'string' }, ...schema.properties }, required: ['projectId', 'musicTrackId'], additionalProperties: undefined },
    handler: ({ projectId, ...args }, actor) => duck(projectId, args, actor),
  });
}
