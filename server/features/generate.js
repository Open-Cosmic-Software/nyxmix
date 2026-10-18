// Generate audio (Audition's Generate menu): tones, noise, silence, and speech from text.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../audio.js';
import { validate } from '../validate.js';

const VOICES_DIR = process.env.KLANG_PIPER_VOICES || '/opt/piper-voices';
const voices = () => { try { return fsSync.readdirSync(VOICES_DIR).filter((f) => f.endsWith('.onnx')).map((f) => f.replace(/\.onnx$/, '')); } catch { return []; } };
const schema = {
  type: 'object', required: ['kind'], additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['tone', 'noise', 'silence', 'speech'] },
    duration: { type: 'number', minimum: 0.05, maximum: 3600 },
    frequency: { type: 'number', minimum: 10, maximum: 20000 },
    waveform: { type: 'string', enum: ['sine', 'square', 'triangle', 'sawtooth'] },
    color: { type: 'string', enum: ['white', 'pink', 'brown'] },
    level: { type: 'number', minimum: -60, maximum: 0, description: 'dBFS' },
    text: { type: 'string', maxLength: 5000 },
    voice: { type: 'string', maxLength: 80 },
    speed: { type: 'number', minimum: 0.5, maximum: 2 },
    name: { type: 'string', maxLength: 120 },
    place: { type: 'object', properties: { trackId: { type: 'string' }, start: { type: 'number', minimum: 0 } } },
  },
};

export async function register({ api, json, wrap, store, actions, mcpTools, actorOf, OpError }) {
  async function generate(pid, b, actor) {
    validate(schema, b);
    store.get(pid);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klang-gen-'));
    const out = path.join(dir, 'gen.wav');
    const amp = Math.pow(10, (b.level ?? -18) / 20);
    const d = b.duration ?? 2;
    try {
      if (b.kind === 'speech') {
        if (!b.text?.trim()) throw new OpError('text is required for speech', 'invalid_args', 400);
        const list = voices();
        const voice = b.voice || list.find((v) => v.startsWith('en_')) || list[0];
        if (!voice || !list.includes(voice)) throw new OpError(`No such voice. Available: ${list.join(', ') || 'none installed'}`, 'invalid_args', 400);
        const raw = path.join(dir, 'tts.wav');
        await run('piper', ['-m', path.join(VOICES_DIR, `${voice}.onnx`), '-f', raw, '--length-scale', String(1 / (b.speed || 1))], { input: b.text, timeoutMs: 5 * 60_000 });
        await fs.rename(raw, out);
      } else {
        const src = b.kind === 'tone' ? `aevalsrc=${toneExpr(b.waveform || 'sine', b.frequency || 440, amp)}:s=48000:d=${d}`
          : b.kind === 'noise' ? `anoisesrc=c=${b.color || 'pink'}:a=${amp}:d=${d}:r=48000` : `anullsrc=r=48000:cl=mono:d=${d}`;
        await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', src, '-t', String(d), out]);
      }
      const label = b.name || (b.kind === 'speech' ? `Speech: ${b.text.slice(0, 40)}` : b.kind === 'tone' ? `Tone ${b.frequency || 440} Hz` : b.kind === 'noise' ? `${b.color || 'pink'} noise` : 'Silence');
      const asset = await actions.importFromFile(pid, out, { name: label, actor });
      let clipId;
      if (b.place) {
        const ops = b.place.trackId ? [] : [{ op: 'track.add', args: { name: label.slice(0, 60) } }];
        ops.push({ op: 'clip.add', args: { trackId: b.place.trackId || '$0.trackId', assetId: asset.id, start: b.place.start || 0 } });
        const r = store.apply(pid, ops, { actor, label: `Placed generated ${b.kind}` });
        clipId = r.results.at(-1).clipId;
      }
      return { asset, ...(clipId ? { clipId } : {}) };
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
  // Waveforms as ffmpeg expressions; frequency and amplitude are validated numbers.
  function toneExpr(w, f, a) {
    const ph = `mod(${f}*t\\,1)`;
    return { sine: `${a}*sin(2*PI*${f}*t)`, square: `${a}*(2*gte(${ph}\\,0.5)-1)`, triangle: `${a}*(4*abs(${ph}-0.5)-1)`, sawtooth: `${a}*(2*${ph}-1)` }[w];
  }

  api.get('/voices', (req, res) => res.json(voices()));
  api.post('/projects/:id/generate', json, wrap(async (req, res) => res.status(201).json(await generate(req.params.id, req.body || {}, actorOf(req)))));
  mcpTools.push({
    name: 'generate_audio',
    description: `Create audio in the bin (Audition's Generate menu): kind "speech" (text → voice, local TTS; voices: ${voices().join(', ') || 'none installed'}; speed 0.5–2), "tone" (frequency, waveform sine/square/triangle/sawtooth), "noise" (white/pink/brown — e.g. to fill a cut with room-like noise), "silence". level in dBFS (default -18), duration in seconds. place:{trackId?, start} also puts it on the timeline (new track if no trackId). Useful for placeholder voice-overs, test tones, slates.`,
    inputSchema: { ...schema, properties: { projectId: { type: 'string' }, ...schema.properties }, required: ['projectId', 'kind'], additionalProperties: undefined },
    handler: ({ projectId, ...b }, actor) => generate(projectId, b, actor),
  });
}
