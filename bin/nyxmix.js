#!/usr/bin/env node
// `npx nyxmix` — start a NyxMix server. Options map to the documented environment variables.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const help = `NyxMix — agent-first multitrack audio editor

Usage: npx nyxmix [--port 3950] [--host 127.0.0.1] [--data ~/.nyxmix] [--token SECRET]

  --port   Listen port (env PORT, default 3950)
  --host   Listen address (env HOST, default 127.0.0.1 — only this machine)
  --data   Where sessions and audio live (env NYXMIX_DATA, default ~/.nyxmix)
  --token  Require "Authorization: Bearer <token>" (env NYXMIX_TOKEN). Set it whenever others can reach the server.

Then open http://127.0.0.1:3950 and connect an agent:
  claude mcp add --transport http nyxmix http://127.0.0.1:3950/mcp
Requires Node 22+ and ffmpeg 6+ on PATH.`;
const map = { '--port': 'PORT', '--host': 'HOST', '--data': 'NYXMIX_DATA', '--token': 'NYXMIX_TOKEN' };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') { console.log(help); process.exit(0); }
  if (a === '-v' || a === '--version') { const { default: pkg } = await import('../package.json', { with: { type: 'json' } }); console.log(pkg.version); process.exit(0); }
  const [k, inline] = a.split('=');
  if (!map[k]) { console.error(`Unknown option ${a}\n\n${help}`); process.exit(2); }
  const v = inline ?? args[++i];
  if (v === undefined) { console.error(`${k} needs a value`); process.exit(2); }
  process.env[map[k]] = v;
}
// Installed with npx, the package folder is a throwaway cache: keep sessions in the home folder instead.
if (!process.env.NYXMIX_DATA && !process.env.KLANG_DATA) process.env.NYXMIX_DATA = path.join(os.homedir(), '.nyxmix');
await import(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'index.js'));
