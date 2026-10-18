---
name: nyxmix
description: Edit audio with a human watching live — multitrack sessions, effects, loudness, transcripts and exports through the NyxMix MCP server or REST API.
---

# NyxMix skill

NyxMix is a multitrack audio editor for the web. A person and you work in the **same session at
the same time**: every change you make appears live in their browser, labelled with your name,
and they can undo it. Use it for podcasts, voice-overs, music drafts, cleanup and mastering.

## Connect

- Start a server: `npx nyxmix` (Node 22+, ffmpeg 6+). UI at http://127.0.0.1:3950
- MCP (Streamable HTTP): `http://127.0.0.1:3950/mcp`
  `claude mcp add --transport http nyxmix http://127.0.0.1:3950/mcp`
- If the server has a token: header `Authorization: Bearer <token>`
- Always identify yourself: header `X-Actor: agent:<your-name>`
- Plain-language reference: `GET /llms.txt` · full API: `GET /openapi.json`

## How to work

1. `list_projects` / `create_project`, then `get_project` (summary) to see tracks, clips and assets.
2. `import_audio` (URL or base64) → asset id, then place it with `edit` → `clip.add`.
3. Change things with **`edit`**: a list of ops applied atomically as one undo step. Give a short
   `label` (the human reads it). Pass `ifRev` so you never overwrite a human edit made meanwhile.
4. **Measure, don't guess:** `analyze` (EBU R128 loudness, true peak, silences, spectrum) and
   `get_image` (waveform / spectrogram PNG) before and after a change.
5. `render` to export (wav/flac/mp3/m4a/opus; loudness target e.g. `{lufs:-14,truePeak:-1}`,
   stems, one file per marker).
6. `get_activity` shows what the human changed — read it before continuing after a pause.

## Good manners

- Small, labelled edits beat one huge change; the human should be able to follow and undo.
- Ask before destructive `process_audio` on the only copy, or prefer it with `replaceInClips`
  (it creates a new asset, the original stays in the bin).
- Use `propose_edits` when the human should approve first.
- Report numbers you measured (LUFS, dBTP, seconds), not impressions.

## Sessions as files

A whole session can be saved and moved as one `.nyxmix` file (audio, edits, versions, transcripts,
custom plugins it uses). Use `archive_url` for a download link; `POST /api/projects/import` restores it.
