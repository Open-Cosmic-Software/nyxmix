// Transcription + text-based editing.
// Assets are transcribed once (faster-whisper, word timestamps) and cached per asset.
// The *timeline transcript* maps those words through every clip onto timeline time;
// cutting words from it becomes ordinary ripple `range.delete` ops (one undo step).
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PY = process.env.KLANG_PYTHON || 'python3';
const DEFAULT_MODEL = process.env.KLANG_WHISPER_MODEL || 'small';
const MODELS = ['tiny', 'tiny.en', 'base', 'base.en', 'small', 'small.en', 'medium', 'medium.en', 'large-v1', 'large-v2', 'large-v3', 'large-v3-turbo', 'turbo', 'distil-large-v3'];
const PAD = 0.03;          // seconds of breathing room added around cut words
const CROSSFADE_MS = 10;
const LOW_CONFIDENCE = 0.5;
const MCP_WAIT_MS = 50_000; // MCP clients tend to time out around a minute
// Filler words per language. "um" is a filler in English but a preposition in German,
// "er" is a pronoun in German, "eh" is a real word in Spanish/Italian — so lists must
// follow the transcript's language; unknown languages get only the unambiguous ones.
const UNIVERSAL_FILLERS = ['hm', 'hmm', 'mm', 'mhm', 'mmm'];
export const FILLERS_BY_LANG = {
  en: ['um', 'uh', 'uhm', 'umm', 'uhh', 'erm', 'er', 'ah'],
  de: ['äh', 'ähm', 'öh', 'öhm', 'ähem', 'ehm'],
  fr: ['euh', 'heu', 'hum', 'bah'],
  es: ['eh', 'em', 'emm', 'este'],
  it: ['ehm', 'eh', 'mmh'],
  nl: ['eh', 'ehm', 'uh', 'uhm'],
  pt: ['hã', 'ahn'],
  pl: ['yyy', 'eee', 'yy', 'ee'],
};
export const fillersFor = (lang) => [...UNIVERSAL_FILLERS, ...(FILLERS_BY_LANG[lang] || [])];
export const DEFAULT_FILLERS = [...new Set(Object.values(FILLERS_BY_LANG).flat().concat(UNIVERSAL_FILLERS))];

const r3 = (x) => Math.round(x * 1000) / 1000;
// Lower-case letters/digits only: "Um," → "um", "Hello-world!" → "helloworld".
export const norm = (s) => String(s).toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '');

export async function register({ api, json, wrap, store, mcpTools, actorOf, OpError }) {
  const dirOf = (pid) => path.join(store.projectDir(pid), 'transcripts');
  const fileOf = (pid, aid) => path.join(dirOf(pid), `${aid}.json`);
  const memo = new Map(); // `${pid}/${aid}` -> transcript | null

  async function readTranscript(pid, aid) {
    if (!/^[\w-]+$/.test(aid)) return null;
    const key = `${pid}/${aid}`;
    if (memo.has(key)) return memo.get(key);
    let t = null;
    try { t = JSON.parse(await fs.readFile(fileOf(pid, aid), 'utf8')); } catch {}
    memo.set(key, t);
    return t;
  }

  // A same-length processed copy (denoise, EQ…) speaks the same words at the same
  // times, so it inherits its source's transcript.
  async function transcriptFor(pid, aid, seen = new Set()) {
    const own = await readTranscript(pid, aid);
    if (own) return own;
    const p = store.get(pid);
    const a = p.assets.find((x) => x.id === aid);
    if (!a?.derivedFrom || seen.has(aid)) return null;
    seen.add(aid);
    const parent = p.assets.find((x) => x.id === a.derivedFrom);
    if (!parent || Math.abs(parent.duration - a.duration) > 0.002) return null;
    return transcriptFor(pid, parent.id, seen);
  }

  const assetsInUse = (p) => [...new Set(p.tracks.flatMap((t) => t.clips.map((c) => c.assetId)))];
  const findAsset = (p, aid) => {
    const a = p.assets.find((x) => x.id === aid);
    if (!a) throw new OpError(`Asset ${aid} not found`, 'not_found', 404);
    return a;
  };

  // ── transcription jobs (one at a time) ─────────────────────────────────
  let chain = Promise.resolve();
  const pending = new Map(); // `${pid}/${aid}` -> { promise, jobId }

  function modelCached(model) {
    const hub = process.env.HF_HUB_CACHE || path.join(process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface'), 'hub');
    try { return readdirSync(hub).some((d) => d.toLowerCase().endsWith(`faster-whisper-${model}`.toLowerCase())); } catch { return false; }
  }

  function transcribe(pid, aid, { language, model, force, actor }) {
    const p = store.get(pid);
    const asset = findAsset(p, aid);
    model = model || DEFAULT_MODEL;
    if (!MODELS.includes(model)) throw new OpError(`Unknown model "${model}". Use one of: ${MODELS.join(', ')}`, 'invalid_args', 400);
    if (language !== undefined && language !== null && !/^[a-z]{2,3}$/.test(language)) throw new OpError('language must be an ISO 639-1 code like "en" or "de" (omit to auto-detect)', 'invalid_args', 400);
    const key = `${pid}/${aid}`;
    if (pending.has(key)) return pending.get(key);
    const jobId = `job_${randomBytes(4).toString('hex')}`;
    const label = `Transcribing “${asset.name}”`;
    const job = { jobId, assetId: aid, status: 'queued' };
    job.promise = (async () => {
      if (!force) {
        const cached = await readTranscript(pid, aid);
        if (cached) { pending.delete(key); return { ...cached, cached: true }; }
      }
      const prev = chain;
      let release;
      chain = new Promise((r) => (release = r));
      try {
        await prev;
        job.status = 'running';
        store.notify(pid, { type: 'job', jobId, status: 'running', label, actor });
        const result = await runWhisper(store.assetPath(pid, aid), { language, model, duration: asset.duration }, (msg) => {
          store.notify(pid, { type: 'job', jobId, status: 'running', label: `${label}${msg ? ` · ${msg}` : ''}`, actor });
        });
        const doc = { assetId: aid, assetName: asset.name, createdAt: new Date().toISOString(), createdBy: actor, ...result };
        await fs.mkdir(dirOf(pid), { recursive: true });
        await fs.writeFile(fileOf(pid, aid) + '.tmp', JSON.stringify(doc));
        await fs.rename(fileOf(pid, aid) + '.tmp', fileOf(pid, aid));
        memo.set(key, doc);
        const words = doc.segments.reduce((n, s) => n + s.words.length, 0);
        store.notify(pid, { type: 'job', jobId, status: 'done', label: `${label}: ${words} words`, actor });
        store.notify(pid, { type: 'transcript', status: 'ready', assetId: aid, actor });
        return doc;
      } catch (err) {
        store.notify(pid, { type: 'job', jobId, status: 'failed', label, error: err.message, actor });
        store.notify(pid, { type: 'transcript', status: 'failed', assetId: aid, error: err.message, actor });
        throw err;
      } finally {
        release();
        pending.delete(key);
      }
    })();
    job.promise.catch(() => {});
    pending.set(key, job);
    return job;
  }

  function runWhisper(file, { language, model, duration }, onProgress) {
    return new Promise((resolve, reject) => {
      const args = [path.join(HERE, 'transcribe.py'), file, '--model', model];
      if (language) args.push('--language', language);
      const child = spawn(PY, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1', HF_HUB_DISABLE_PROGRESS_BARS: '1' } });
      // First run downloads the model; give that plenty of time, then ~2× real time on CPU.
      const timeoutMs = 20 * 60_000 + (duration || 0) * 2000;
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new OpError(`Transcription timed out after ${Math.round(timeoutMs / 60000)} min`, 'timeout', 504)); }, timeoutMs);
      let out = '', errTail = '', buf = '', lastPct = -1;
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (line.startsWith('@@')) {
            try {
              const m = JSON.parse(line.slice(2));
              if (m.stage === 'loading') onProgress(modelCached(m.model) ? 'loading model' : `downloading the ${m.model} speech model (first run only)`);
              else if (m.stage === 'transcribing') {
                const pct = Math.round((m.progress || 0) * 100);
                if (pct !== lastPct && (pct === 0 || pct - lastPct >= 5)) { lastPct = pct; onProgress(`${pct}%`); }
              }
            } catch {}
          } else if (line.trim()) errTail = (errTail + '\n' + line).slice(-2000);
        }
      });
      child.on('error', (e) => { clearTimeout(timer); reject(new OpError(`Could not start Python (${PY}): ${e.message}`, 'transcriber_unavailable', 503)); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          const hint = /No module named 'faster_whisper'/.test(errTail) ? 'faster-whisper is not installed (pip install faster-whisper)' : errTail.trim().split('\n').slice(-3).join(' | ');
          return reject(new OpError(`Transcription failed: ${hint || `exit code ${code}`}`, 'transcription_failed', 500));
        }
        try { resolve(JSON.parse(out)); } catch { reject(new OpError('Transcriber returned invalid output', 'transcription_failed', 500)); }
      });
    });
  }

  // ── timeline transcript ─────────────────────────────────────────────────
  async function timeline(pid, { fillers } = {}) {
    const p = store.get(pid);
    const custom = fillers?.length ? new Set(fillers.map(norm)) : null;
    const byLang = new Map();
    const fillerSetFor = (lang) => custom || byLang.get(lang) || byLang.set(lang, new Set(fillersFor(lang).map(norm))).get(lang);
    const words = [];
    const missing = new Set();
    let language = null;
    for (const t of p.tracks) {
      if (t.mute) continue;
      for (const c of t.clips) {
        const tr = await transcriptFor(pid, c.assetId);
        if (!tr) { missing.add(c.assetId); continue; }
        language ||= tr.language;
        const fillerSet = fillerSetFor(tr.language);
        const lo = c.offset, hi = c.offset + c.duration, shift = c.start - c.offset;
        tr.segments.forEach((s, si) => {
          if (s.end < lo || s.start > hi) return;
          for (const w of s.words) {
            const mid = (w.start + w.end) / 2;
            if (mid < lo || mid > hi) continue;
            const text = w.word.trim();
            if (!text) continue;
            words.push({
              start: r3(Math.max(w.start, lo) + shift), end: r3(Math.min(w.end, hi) + shift), word: text,
              probability: w.probability, trackId: t.id, clipId: c.id, seg: `${c.assetId}:${si}`,
              ...(fillerSet.has(norm(text)) ? { filler: true } : {}),
            });
          }
        });
      }
    }
    const order = new Map(p.tracks.map((t, i) => [t.id, i]));
    words.sort((a, b) => a.start - b.start || order.get(a.trackId) - order.get(b.trackId));
    words.forEach((w, i) => (w.i = i));
    return {
      projectId: pid, rev: p.rev, language,
      tracks: p.tracks.filter((t) => !t.mute).map((t) => ({ id: t.id, name: t.name, color: t.color })),
      untranscribedAssets: [...missing].map((id) => ({ id, name: p.assets.find((a) => a.id === id)?.name })),
      words,
    };
  }

  // Timeline segments: runs of words from the same source segment of the same clip.
  function segmentsOf(words) {
    const segs = [];
    for (const w of words) {
      const last = segs[segs.length - 1];
      if (last && last.key === w.seg && last.trackId === w.trackId) { last.words.push(w); last.end = w.end; continue; }
      segs.push({ key: w.seg, trackId: w.trackId, start: w.start, end: w.end, words: [w] });
    }
    return segs;
  }

  function asText(tl, p) {
    const multi = new Set(tl.words.map((w) => w.trackId)).size > 1;
    const names = new Map(p.tracks.map((t) => [t.id, t.name]));
    const lines = [`Timeline transcript of “${p.name}” (rev ${tl.rev}; times are timeline seconds${tl.language ? `; language ${tl.language}` : ''}; ${tl.words.length} words; words marked ‹…› are filler, ~ = low confidence)`];
    for (const s of segmentsOf(tl.words)) {
      const text = s.words.map((w) => (w.filler ? `‹${w.word}›` : w.word) + (w.probability < LOW_CONFIDENCE ? '~' : '')).join(' ');
      lines.push(`[${s.start.toFixed(2)}–${s.end.toFixed(2)}]${multi ? ` ${names.get(s.trackId)}:` : ''} ${text}`);
    }
    if (tl.untranscribedAssets.length) lines.push(`Not transcribed yet: ${tl.untranscribedAssets.map((a) => `${a.id} “${a.name}”`).join(', ')} (call transcribe).`);
    if (!tl.words.length && !tl.untranscribedAssets.length) lines.push('(no clips on unmuted tracks)');
    return lines.join('\n');
  }

  // ── cutting ─────────────────────────────────────────────────────────────
  function findPhrase(words, text, trackId) {
    const target = String(text).split(/\s+/).map(norm).join('');
    if (!target) throw new OpError('text has no letters or digits to match', 'invalid_args', 400);
    const byTrack = new Map();
    for (const w of words) if (!trackId || w.trackId === trackId) (byTrack.get(w.trackId) || byTrack.set(w.trackId, []).get(w.trackId)).push(w);
    const matches = [];
    for (const list of byTrack.values()) {
      // Concatenate normalized tokens and only accept hits on token boundaries, so a
      // phrase still matches when Whisper splits one word into two tokens.
      let s = ''; const startAt = new Map(); const endAt = new Map();
      list.forEach((w, k) => { startAt.set(s.length, k); s += norm(w.word); endAt.set(s.length, k); });
      for (let pos = s.indexOf(target); pos >= 0; pos = s.indexOf(target, pos + 1)) {
        const a = startAt.get(pos), b = endAt.get(pos + target.length);
        if (a === undefined || b === undefined || b < a) continue;
        // skip empty-norm tokens at the edges (pure punctuation)
        matches.push(list.slice(a, b + 1));
      }
    }
    matches.sort((x, y) => x[0].start - y[0].start);
    return matches;
  }

  function plan(tl, body) {
    const { words } = tl;
    const cut = new Set();
    const explicit = [];
    if (Array.isArray(body.ranges) && body.ranges.length) {
      for (const [k, r] of body.ranges.entries()) {
        if (typeof r?.start !== 'number' || typeof r?.end !== 'number' || !(r.end > r.start) || r.start < 0) throw new OpError(`ranges[${k}] needs numeric start < end (timeline seconds, ≥ 0)`, 'invalid_args', 400);
        explicit.push({ start: r.start, end: r.end });
      }
    } else if (Array.isArray(body.words) && body.words.length) {
      for (const [k, q] of body.words.entries()) {
        if (typeof q?.start !== 'number' || typeof q?.end !== 'number') throw new OpError(`words[${k}] needs numeric start and end (timeline seconds, as returned by the transcript)`, 'invalid_args', 400);
        const hit = words.filter((w) => (!q.trackId || w.trackId === q.trackId) && (w.start + w.end) / 2 >= q.start - 0.02 && (w.start + w.end) / 2 <= q.end + 0.02);
        if (!hit.length) throw new OpError(`words[${k}]: no transcript word at ${q.start}–${q.end}s${q.trackId ? ` on ${q.trackId}` : ''}. Re-read the transcript; times shift after every cut.`, 'not_found', 404);
        hit.forEach((w) => cut.add(w.i));
      }
    } else if (typeof body.text === 'string' && body.text.trim()) {
      const matches = findPhrase(words, body.text, body.trackId);
      if (!matches.length) throw new OpError(`“${body.text}” does not occur in the timeline transcript (matching ignores case and punctuation). Read it with get_transcript.`, 'not_found', 404);
      const occ = body.occurrence;
      let chosen;
      if (occ === 'all') chosen = matches;
      else if (occ === undefined || occ === null) {
        if (matches.length > 1) throw new OpError(`“${body.text}” occurs ${matches.length} times (at ${matches.map((m) => m[0].start.toFixed(2) + 's').join(', ')}). Pass occurrence (1-based number) or "all".`, 'ambiguous', 409);
        chosen = matches;
      } else if (Number.isInteger(occ) && occ >= 1) {
        if (occ > matches.length) throw new OpError(`occurrence ${occ} requested but “${body.text}” occurs only ${matches.length} time(s)`, 'not_found', 404);
        chosen = [matches[occ - 1]];
      } else throw new OpError('occurrence must be a 1-based integer or "all"', 'invalid_args', 400);
      chosen.flat().forEach((w) => cut.add(w.i));
    } else {
      throw new OpError('Send one of: ranges [{start,end}], words [{trackId?,start,end}], or text "exact phrase" (+ occurrence)', 'invalid_args', 400);
    }

    let spans = [];
    if (explicit.length) {
      spans = explicit.map((r) => ({ start: r.start, end: r.end, words: words.filter((w) => w.start >= r.start - 1e-3 && w.end <= r.end + 1e-3) }));
    } else {
      // Runs of cut words with no kept word between them become one span (so the
      // pause between two removed words goes too), padded but never into a kept word.
      let run = null;
      for (const w of words) {
        if (cut.has(w.i)) { if (run) run.push(w); else spans.push((run = [w])); }
        else run = null;
      }
      const kept = words.filter((w) => !cut.has(w.i));
      spans = spans.map((ws) => {
        const s0 = Math.min(...ws.map((w) => w.start)), e0 = Math.max(...ws.map((w) => w.end));
        let start = Math.max(0, s0 - PAD), end = e0 + PAD;
        for (const k of kept) {
          if (k.end <= s0 + 1e-6 && k.end > start) start = k.end;
          if (k.start >= e0 - 1e-6 && k.start < end) end = k.start;
        }
        return { start: Math.min(start, s0), end: Math.max(end, e0), words: ws };
      });
    }
    // Merge overlapping / touching spans.
    spans.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s.start <= last.end + 1e-3) { last.end = Math.max(last.end, s.end); last.words.push(...s.words); }
      else merged.push({ ...s, words: [...s.words] });
    }
    return merged.filter((s) => s.end - s.start > 1e-3).map((s) => ({ start: r3(s.start), end: r3(s.end), text: s.words.map((w) => w.word).join(' '), words: s.words.length }));
  }

  const quote = (s, n = 48) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

  async function cut(pid, body, actor, labelPrefix) {
    const tl = await timeline(pid, { fillers: body.fillers });
    if (body.ifRev !== undefined && body.ifRev !== tl.rev) throw new OpError(`Project is at rev ${tl.rev}, you sent ifRev=${body.ifRev}. Re-read the transcript and retry.`, 'rev_conflict', 409);
    const spans = plan(tl, body);
    if (!spans.length) throw new OpError('Nothing to cut', 'invalid_args', 400);
    // Cut only the tracks that carry speech, so a music bed keeps playing instead of
    // being chopped at every removed word. allTracks:true cuts everything in sync.
    const speech = [...new Set(tl.words.map((w) => w.trackId))];
    const scoped = !body.allTracks && speech.length && speech.length < store.get(pid).tracks.length;
    const ops = [...spans].reverse().map((s) => ({ op: 'range.delete', args: { start: s.start, end: s.end, ripple: true, crossfade: CROSSFADE_MS, ...(scoped ? { trackIds: speech, moveMarkers: true } : {}) } }));
    const label = spans.length === 1
      ? `${labelPrefix || 'Cut'} “${quote(spans[0].text || `${spans[0].start}–${spans[0].end}s`)}” from transcript`
      : `${labelPrefix || 'Cut'} ${spans.length} passages from transcript (“${quote(spans.map((s) => s.text).filter(Boolean).join('”, “'), 40)}”)`;
    const r = store.apply(pid, ops, { actor, label });
    return { rev: r.rev, label, cut: spans, removedSeconds: r3(spans.reduce((n, s) => n + s.end - s.start, 0)) };
  }

  async function fillers(pid, { words: list, apply, ifRev } = {}, actor) {
    if (list !== undefined && (!Array.isArray(list) || list.some((x) => typeof x !== 'string'))) throw new OpError('words must be an array of strings', 'invalid_args', 400);
    const fl = list?.length ? list : undefined;
    const tl = await timeline(pid, { fillers: fl });
    const found = tl.words.filter((w) => w.filler).map(({ start, end, word, trackId, clipId, probability }) => ({ start, end, word, trackId, clipId, probability }));
    const matchedWords = fl || fillersFor(tl.language);
    if (!apply) return { count: found.length, fillers: found, applied: false, matchedWords };
    if (!found.length) return { count: 0, fillers: [], applied: false, matchedWords, note: 'No filler words found' };
    const r = await cut(pid, { words: found.map(({ trackId, start, end }) => ({ trackId, start, end })), fillers: fl, ifRev }, actor, 'Removed');
    return { count: found.length, fillers: found, applied: true, ...r, label: `Removed ${found.length} filler word${found.length === 1 ? '' : 's'}` };
  }

  // ── REST ────────────────────────────────────────────────────────────────
  const settle = async (job, wait) => {
    if (wait === false) return { status: 202, body: { status: job.status, jobId: job.jobId, assetId: job.assetId } };
    return { status: 200, body: await job.promise };
  };

  api.post('/projects/:id/assets/:aid/transcribe', json, wrap(async (req, res) => {
    const b = req.body || {};
    const { id: pid, aid } = req.params;
    if (!b.force) { findAsset(store.get(pid), aid); const c = await readTranscript(pid, aid); if (c) return res.json({ ...c, cached: true }); }
    const job = transcribe(pid, aid, { language: b.language, model: b.model, force: !!b.force, actor: actorOf(req) });
    const r = await settle(job, b.wait);
    res.status(r.status).json(r.body);
  }));

  // Transcribe every asset used on the timeline that has no transcript yet.
  api.post('/projects/:id/transcribe', json, wrap(async (req, res) => {
    const b = req.body || {};
    const jobs = await transcribeInUse(req.params.id, { ...b, actor: actorOf(req) });
    if (b.wait === false) return res.status(202).json({ status: 'queued', jobs: jobs.map((j) => ({ jobId: j.jobId, assetId: j.assetId })) });
    await Promise.all(jobs.map((j) => j.promise));
    res.json(await timeline(req.params.id));
  }));

  async function transcribeInUse(pid, { language, model, force, actor }) {
    const p = store.get(pid);
    const jobs = [];
    for (const aid of assetsInUse(p)) {
      if (!force && await transcriptFor(pid, aid)) continue;
      jobs.push(transcribe(pid, aid, { language, model, force, actor }));
    }
    return jobs;
  }

  api.get('/projects/:id/assets/:aid/transcript', wrap(async (req, res) => {
    findAsset(store.get(req.params.id), req.params.aid);
    const t = await transcriptFor(req.params.id, req.params.aid);
    if (!t) throw new OpError(`Asset ${req.params.aid} has no transcript yet. POST …/transcribe first.`, 'not_found', 404);
    res.json(t);
  }));

  api.get('/projects/:id/transcript', wrap(async (req, res) => {
    const tl = await timeline(req.params.id);
    if (req.query.format === 'text') return res.type('text/plain').send(asText(tl, store.get(req.params.id)));
    tl.running = [...pending.entries()].filter(([k]) => k.startsWith(req.params.id + '/')).map(([, j]) => ({ jobId: j.jobId, assetId: j.assetId, status: j.status }));
    res.json(tl);
  }));

  api.post('/projects/:id/transcript/delete', json, wrap(async (req, res) => {
    res.json(await cut(req.params.id, req.body || {}, actorOf(req)));
  }));

  api.post('/projects/:id/transcript/filler', json, wrap(async (req, res) => {
    res.json(await fillers(req.params.id, req.body || {}, actorOf(req)));
  }));

  // ── MCP ─────────────────────────────────────────────────────────────────
  const pidProp = { projectId: { type: 'string', description: 'Project id (prj_…)' } };
  mcpTools.push(
    {
      name: 'transcribe',
      description: 'Speech-to-text with word-level timestamps (Whisper, runs locally). Transcribes one asset, or (without assetId) every asset used on the timeline that has no transcript yet. Results are cached per asset, so calling again is cheap; force:true re-runs. Same-length processed copies (denoise etc.) reuse their source\'s transcript. Takes roughly 0.1–0.3× the audio length; the first run also downloads the model. If it is still running after ~50 s this returns {status:"running"} — call get_transcript later. Afterwards use get_transcript to read and cut_transcript / remove_filler_words to edit by text.',
      inputSchema: { type: 'object', properties: { ...pidProp, assetId: { type: 'string', description: 'Asset id (ast_…); omit to transcribe all assets on the timeline' }, language: { type: 'string', description: 'ISO 639-1 code like "en" or "de"; omit to auto-detect' }, model: { type: 'string', enum: MODELS, description: `Whisper model (default ${DEFAULT_MODEL}); larger = slower but more accurate` }, force: { type: 'boolean', description: 'Re-transcribe even if cached' } }, required: ['projectId'] },
      handler: async (a, actor) => {
        const jobs = a.assetId
          ? [transcribe(a.projectId, a.assetId, { language: a.language, model: a.model, force: !!a.force, actor })]
          : await transcribeInUse(a.projectId, { language: a.language, model: a.model, force: !!a.force, actor });
        if (!jobs.length) return { status: 'done', note: 'Every asset on the timeline already has a transcript. Call get_transcript.' };
        const all = Promise.all(jobs.map((j) => j.promise));
        const timedOut = await Promise.race([all.then(() => false), new Promise((r) => setTimeout(() => r(true), MCP_WAIT_MS))]);
        if (timedOut) return { status: 'running', jobs: jobs.map((j) => ({ jobId: j.jobId, assetId: j.assetId })), note: 'Still transcribing in the background. Call get_transcript in a minute; untranscribed assets are listed at the end.' };
        const docs = await all;
        return { status: 'done', assets: docs.map((d) => ({ assetId: d.assetId, language: d.language, words: d.segments.reduce((n, s) => n + s.words.length, 0), cached: !!d.cached })), next: 'Call get_transcript (format "text") to read the timeline transcript.' };
      },
    },
    {
      name: 'get_transcript',
      description: 'Read the TIMELINE transcript: words from every clip on unmuted tracks, mapped to timeline seconds (so it reflects all edits; re-read after cutting, because later times shift). format "text" (default): one line per phrase, "[start–end] words…" (with "Track:" when several tracks speak), filler words shown as ‹um›, low-confidence words suffixed with ~. format "words": JSON {words:[{start,end,word,probability,trackId,clipId,filler?}]} for exact word times.',
      inputSchema: { type: 'object', properties: { ...pidProp, format: { type: 'string', enum: ['text', 'words'] } }, required: ['projectId'] },
      handler: async (a) => {
        const tl = await timeline(a.projectId);
        if (a.format === 'words') return { rev: tl.rev, language: tl.language, untranscribedAssets: tl.untranscribedAssets, words: tl.words.map(({ start, end, word, probability, trackId, clipId, filler }) => ({ start, end, word, probability, trackId, clipId, ...(filler ? { filler } : {}) })) };
        return asText(tl, store.get(a.projectId));
      },
    },
    {
      name: 'cut_transcript',
      description: 'Remove spoken words from the edit by text — like deleting them in a document. Give EITHER text (an exact phrase from get_transcript; case and punctuation are ignored; if it occurs more than once you must pass occurrence = 1-based index or "all") OR ranges [{start,end}] in timeline seconds (cut exactly as given) OR words [{start,end,trackId?}] copied from get_transcript format "words". Word cuts get 30 ms padding that never eats into neighbouring kept words; the pause between consecutive removed words goes too. Ripple-deleted on every track that carries speech (several mic tracks stay in sync) while music/effects tracks keep playing uncut; pass allTracks:true to cut every track. 10 ms crossfades, ONE undoable edit. Returns the cut spans and the new rev; times after a cut move earlier, so re-read before cutting again.',
      inputSchema: { type: 'object', properties: { ...pidProp, text: { type: 'string', description: 'Exact phrase to cut, e.g. "you know what I mean"' }, occurrence: { description: '1-based occurrence of text, or "all"', anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', enum: ['all'] }] }, trackId: { type: 'string', description: 'Only match text spoken on this track' }, ranges: { type: 'array', items: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' } }, required: ['start', 'end'] } }, words: { type: 'array', items: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' }, trackId: { type: 'string' } }, required: ['start', 'end'] } }, ifRev: { type: 'integer', description: 'Fail instead of cutting if the project changed since you read it' }, allTracks: { type: 'boolean', description: 'Also cut tracks without speech (music, ambience). Default false.' } }, required: ['projectId'] },
      handler: async (a, actor) => { const { projectId, ...body } = a; return cut(projectId, body, actor); },
    },
    {
      name: 'remove_filler_words',
      description: `Find filler words in the timeline transcript. By default the list follows each recording's detected language (${Object.entries(FILLERS_BY_LANG).map(([k, v]) => `${k}: ${v.join('/')}`).join('; ')}; plus hm/hmm/mhm everywhere), so e.g. German "um" (a preposition) is never treated as a filler. With apply:false (default) only lists them with timeline times so you can review; apply:true cuts all of them in ONE undoable ripple edit (30 ms padding, 10 ms crossfades). Pass words to use your own list (whole-word, case-insensitive). Tip: review first — "like"/"so" are often not fillers.`,
      inputSchema: { type: 'object', properties: { ...pidProp, words: { type: 'array', items: { type: 'string' }, description: 'Filler words to match instead of the defaults' }, apply: { type: 'boolean', description: 'true = cut them now' } }, required: ['projectId'] },
      handler: async (a, actor) => fillers(a.projectId, { words: a.words, apply: !!a.apply }, actor),
    },
  );
}
