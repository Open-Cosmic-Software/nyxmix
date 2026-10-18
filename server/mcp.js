// Model Context Protocol endpoint (Streamable HTTP, JSON responses).
import { randomUUID } from 'node:crypto';
import { OPS } from './ops.js';
import { EFFECTS } from '../public/js/engine/graph.js';
import { PROCESSES, FORMATS } from './audio.js';

const PROTOCOL = '2025-06-18';
const sessions = new Map(); // sessionId -> client name

export const INSTRUCTIONS = `NyxMix is a multitrack audio editor. You edit by sending operations; a human may be watching the same session live in the browser and sees your edits (and their author) instantly.
Workflow: list_projects / create_project → import_audio → get_project (summary) → analyze (loudness, silences, spectrum) and get_image (waveform/spectrogram you can look at) → edit with the op tools or one atomic \`edit\` batch → render.
Times are seconds on the project timeline. Clip = window into an asset (offset + duration) placed at start on a track. Track effects are real-time and non-destructive; process_audio is destructive (creates a new asset; same-length results are swapped into existing clips; undo restores the old clip references).
Batches can reference earlier results: {"op":"clip.add","args":{"trackId":"$0.trackId",…}} uses the trackId returned by ops[0].
Spoken word: transcribe → get_transcript → cut_transcript / remove_filler_words edits audio by text.
Mixing: preset.apply gives instant effect chains (podcast-voice, master-podcast, …); auto_duck lowers music under speech; automation.set draws volume/pan envelopes.
Restoration: process_audio (denoise, dehum, declick, deess, loudness…), spectral_edit for a time×frequency box, noise_reduction from a room-tone range.
Automation: automation.set works for volume, pan and any effect parameter ("fx:<effectId>:<param>"); clip.envelope gives clip-glued volume keyframes.
More: remix_music (fit music to a length by jumping between matching beats — tempo untouched), stretch_clip (fit to an exact length by tempo), batch_process (one process on many files), pitchCorrect process (auto-tune a solo voice) and pitch_curve (hand-drawn cents over time, after get_pitch), project.setLayout 5.1 surround, video tools (import_video, video_frame to look at the picture, detect_scene_changes to cut to picture), install_plugin for custom DSP, check_delivery before export, render ranges:'markers' for one file per range marker.
When a change is a judgement call, use propose_edits instead of editing directly: the human previews and accepts or rejects it. save_version before risky passes.
Leave markers (marker.add) to flag things for the human to review. Every edit is undoable.`;

const pid = { projectId: { type: 'string', description: 'Project id (prj_…)' } };
const targetSchema = {
  type: 'object', description: 'What to inspect. Omit for the full mix of the timeline. {assetId} = raw source file; {clipId} = the source audio under one clip; {start,end} limits the range (timeline seconds for the mix).',
  properties: { assetId: { type: 'string' }, clipId: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' } },
};

function tools(extraTools = []) {
  const list = [
    { name: 'list_projects', description: 'List editing sessions.', inputSchema: { type: 'object', properties: {} } },
    { name: 'create_project', description: 'Create an empty session.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, sampleRate: { type: 'integer', enum: [44100, 48000, 96000] } } } },
    { name: 'get_project', description: 'Read the session: tracks, clips (with times), effects, assets, markers. format "summary" (default) is compact text; "json" is the full document.', inputSchema: { type: 'object', properties: { ...pid, format: { type: 'string', enum: ['summary', 'json'] } }, required: ['projectId'] } },
    { name: 'describe_capabilities', description: 'Effect types with parameter ranges, destructive processes, and export formats.', inputSchema: { type: 'object', properties: {} } },
    { name: 'import_audio', description: 'Add an audio file to the session bin from a public URL or base64 data. Any common format; converted losslessly to 32-bit float at the project rate. Returns the asset (id, duration). Then place it with clip.add.', inputSchema: { type: 'object', properties: { ...pid, url: { type: 'string' }, base64: { type: 'string' }, name: { type: 'string' } }, required: ['projectId'] } },
    { name: 'edit', description: `Apply several operations atomically (all or nothing, one undo step). Ops: ${Object.keys(OPS).join(', ')}. Each op tool documents its args. Pass ifRev to fail instead of clobbering concurrent human edits.`, inputSchema: { type: 'object', properties: { ...pid, ops: { type: 'array', items: { type: 'object', properties: { op: { type: 'string', enum: Object.keys(OPS) }, args: { type: 'object' } }, required: ['op'] } }, label: { type: 'string', description: 'Shown in the activity feed and undo history' }, ifRev: { type: 'integer' } }, required: ['projectId', 'ops'] } },
    { name: 'undo', description: 'Undo the last edit (by anyone).', inputSchema: { type: 'object', properties: pid, required: ['projectId'] } },
    { name: 'redo', description: 'Redo.', inputSchema: { type: 'object', properties: pid, required: ['projectId'] } },
    { name: 'analyze', description: 'Measure audio: EBU R128 loudness (integrated LUFS, LRA, true peak), sample peak/RMS/clipping/DC, silent stretches, spectral band balance, optional RMS envelope.', inputSchema: { type: 'object', properties: { ...pid, target: targetSchema, start: { type: 'number', description: 'Range start in seconds (same as target.start; timeline seconds for the mix)' }, end: { type: 'number', description: 'Range end in seconds' }, include: { type: 'array', items: { type: 'string', enum: ['loudness', 'levels', 'silences', 'spectrum', 'envelope'] } }, silenceThresholdDb: { type: 'number', description: 'default -45' }, minSilence: { type: 'number', description: 'seconds, default 0.5' }, envelopeStep: { type: 'number', description: 'seconds per envelope point, default 0.25' } }, required: ['projectId'] } },
    { name: 'get_image', description: 'Render a waveform or spectrogram PNG of the mix, an asset or a clip, so you can look at the audio.', inputSchema: { type: 'object', properties: { ...pid, kind: { type: 'string', enum: ['waveform', 'spectrogram'] }, target: targetSchema, start: { type: 'number' }, end: { type: 'number' }, width: { type: 'integer', minimum: 200, maximum: 4000 }, height: { type: 'integer', minimum: 100, maximum: 2000 } }, required: ['projectId'] } },
    { name: 'process_audio', description: `Destructive processing of an asset into a new asset. Kinds: ${Object.entries(PROCESSES).map(([k, v]) => `${k} (${v.description})`).join('; ')}`, inputSchema: { type: 'object', properties: { ...pid, assetId: { type: 'string' }, kind: { type: 'string', enum: Object.keys(PROCESSES) }, params: { type: 'object' }, replaceInClips: { type: 'boolean', description: 'Swap the result into clips using the original (default true; only for length-preserving kinds)' }, start: { type: 'number', description: 'Only process from here (asset/source seconds; timeline = clip.start + source − clip.offset)' }, end: { type: 'number', description: 'Only process until here (source seconds). Edges are crossfaded.' } }, required: ['projectId', 'assetId', 'kind'] } },
    { name: 'render', description: 'Export the mix. Returns a download URL plus measured loudness. bounce:true instead adds the mixdown to the bin as a new asset.', inputSchema: { type: 'object', properties: { ...pid, format: { type: 'string', enum: Object.keys(FORMATS) }, bitDepth: { type: 'integer', enum: [16, 24, 32] }, bitrate: { type: 'integer', description: 'kbps for lossy formats' }, sampleRate: { type: 'integer' }, start: { type: 'number' }, end: { type: 'number' }, tail: { type: 'number', description: 'Extra seconds after the end for reverb/echo tails' }, loudness: { type: 'object', properties: { lufs: { type: 'number' }, truePeak: { type: 'number' } }, description: 'Normalize the export to this loudness' }, bounce: { type: 'boolean' }, ranges: { type: 'string', enum: ['markers'], description: 'markers = one file per range marker (named after its label) instead of the mix' }, stems: { type: 'boolean', description: 'One file per audio track (soloed, with its bus sends, through the master) instead of the mix' }, chapters: { type: 'boolean', description: 'Write labelled markers as chapters (default true; mp3/m4a/opus/flac)' }, name: { type: 'string' } }, required: ['projectId'] } },
    { name: 'get_activity', description: 'Recent edits with author (human or agent) — use it to see what the human changed.', inputSchema: { type: 'object', properties: { ...pid, limit: { type: 'integer' } }, required: ['projectId'] } },
  ];
  for (const t of extraTools) list.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
  for (const op of Object.values(OPS)) {
    list.push({
      name: op.name.replace('.', '_'),
      description: op.description,
      inputSchema: { ...op.schema, properties: { ...pid, ...op.schema.properties }, required: ['projectId', ...(op.schema.required || [])] },
    });
  }
  return list;
}

export function createMcpHandler({ store, actions, baseUrl, extraTools = [] }) {
  const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

  async function call(name, a, actor, req) {
    const extra = extraTools.find((t) => t.name === name);
    if (extra) { const r = await extra.handler(a, actor, req); return r?.content ? r : text(r); }
    switch (name) {
      case 'list_projects': return text(store.list());
      case 'create_project': return text(await store.create({ name: a.name, sampleRate: a.sampleRate }, actor));
      case 'get_project': return text(a.format === 'json' ? store.get(a.projectId) : actions.summary(a.projectId));
      case 'describe_capabilities': return text({ effects: EFFECTS, processes: PROCESSES, formats: Object.keys(FORMATS) });
      case 'import_audio': {
        if (a.url) return text(await actions.importFromUrl(a.projectId, a.url, { name: a.name, actor }));
        if (a.base64) {
          const { Readable } = await import('node:stream');
          return text(await actions.importFromStream(a.projectId, Readable.from([Buffer.from(a.base64, 'base64')]), { name: a.name || 'Audio', actor }));
        }
        throw Object.assign(new Error('Provide url or base64'), { code: 'invalid_args' });
      }
      case 'edit': return text(store.apply(a.projectId, a.ops, { actor, label: a.label, ifRev: a.ifRev }));
      case 'undo': return text(store.undo(a.projectId, actor));
      case 'redo': return text(store.redo(a.projectId, actor));
      case 'analyze': { const { projectId, target, ...rest } = a; return text(await actions.analyze(projectId, target, rest)); }
      case 'get_image': {
        const { projectId, target, ...rest } = a;
        const png = await actions.image(projectId, target, rest);
        return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] };
      }
      case 'process_audio': return text(await actions.processAsset(a.projectId, a.assetId, { kind: a.kind, params: a.params, replaceInClips: a.replaceInClips, start: a.start, end: a.end }, actor));
      case 'render': {
        const r = await actions.render(a.projectId, a, actor);
        if (r.url) r.url = baseUrl(req) + r.url;
        for (const st of [...(r.stems || []), ...(r.files || [])]) st.url = baseUrl(req) + st.url;
        return text(r);
      }
      case 'get_activity': return text(store.activity(a.projectId, a.limit || 30));
      default: {
        const opName = name.replace('_', '.');
        if (!OPS[opName]) throw Object.assign(new Error(`Unknown tool ${name}`), { code: 'unknown_tool' });
        const { projectId, ...args } = a;
        const r = store.apply(projectId, [{ op: opName, args }], { actor });
        return text({ rev: r.rev, ...r.results[0] });
      }
    }
  }

  async function handleOne(msg, req, res) {
    const { id, method, params = {} } = msg;
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (id === undefined) return null; // notification
    switch (method) {
      case 'initialize': {
        const sid = randomUUID();
        sessions.set(sid, params.clientInfo?.name || 'agent');
        if (sessions.size > 5000) sessions.delete(sessions.keys().next().value);
        res.setHeader('Mcp-Session-Id', sid);
        return reply({
          protocolVersion: params.protocolVersion || PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'nyxmix', title: 'NyxMix audio editor', version: '0.1.0' },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: tools(extraTools) });
      case 'tools/call': {
        const sid = req.get('mcp-session-id');
        const actor = req.get('x-actor') || `agent:${sessions.get(sid) || 'mcp'}`;
        try {
          return reply(await call(params.name, params.arguments || {}, actor, req));
        } catch (err) {
          return reply({ isError: true, content: [{ type: 'text', text: `${err.code ? `[${err.code}] ` : ''}${err.message}` }] });
        }
      }
      case 'resources/list': return reply({ resources: [] });
      case 'prompts/list': return reply({ prompts: [] });
      default: return fail(-32601, `Method not found: ${method}`);
    }
  }

  return async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object') return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handleOne(m, req, res)))).filter(Boolean);
      return out.length ? res.json(out) : res.status(202).end();
    }
    const out = await handleOne(body, req, res);
    return out ? res.json(out) : res.status(202).end();
  };
}
