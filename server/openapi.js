import { OPS } from './ops.js';
import { PROCESSES, FORMATS } from './audio.js';

export function openapi(server) {
  const pid = { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Project id' };
  const body = (schema, description) => ({ required: true, description, content: { 'application/json': { schema } } });
  const ok = (description, schema = { type: 'object' }) => ({ 200: { description, content: { 'application/json': { schema } } } });
  const opSchemas = Object.fromEntries(Object.values(OPS).map((o) => [o.name, { description: o.description, ...o.schema }]));
  const opItem = {
    oneOf: Object.keys(OPS).map((name) => ({
      type: 'object', required: ['op'], title: name,
      properties: { op: { const: name }, args: { $ref: `#/components/schemas/${name.replace('.', '_')}` } },
    })),
  };
  const target = { type: 'object', properties: { assetId: { type: 'string' }, clipId: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' } }, description: 'Omit for the full mix' };

  const paths = {
    '/api/projects': {
      get: { operationId: 'listProjects', summary: 'List projects', responses: ok('Projects', { type: 'array' }) },
      post: { operationId: 'createProject', summary: 'Create a project', requestBody: body({ type: 'object', properties: { name: { type: 'string' }, sampleRate: { type: 'integer', enum: [44100, 48000, 88200, 96000] } } }), responses: { 201: { description: 'Created' } } },
    },
    '/api/projects/{id}': {
      get: { operationId: 'getProject', summary: 'Full project document', parameters: [pid], responses: ok('Project') },
      delete: { operationId: 'deleteProject', summary: 'Delete a project and its files', parameters: [pid], responses: { 204: { description: 'Deleted' } } },
    },
    '/api/projects/{id}/summary': { get: { operationId: 'getSummary', summary: 'Compact plain-text overview for LLMs', parameters: [pid], responses: { 200: { description: 'Text', content: { 'text/plain': {} } } } } },
    '/api/projects/{id}/ops': {
      post: {
        operationId: 'applyOps', summary: 'Apply edit operations atomically (one undo step)', parameters: [pid],
        requestBody: body({ type: 'object', required: ['ops'], properties: { ops: { type: 'array', items: opItem }, label: { type: 'string' }, ifRev: { type: 'integer', description: 'Fail with 409 if the project changed' } } }),
        responses: ok('{ rev, results[] }'),
      },
    },
    '/api/projects/{id}/ops/{op}': {
      post: { operationId: 'applyOp', summary: 'Apply a single operation; body = its args', parameters: [pid, { name: 'op', in: 'path', required: true, schema: { type: 'string', enum: Object.keys(OPS) } }], requestBody: body({ type: 'object' }), responses: ok('{ rev, ...result }') },
    },
    '/api/projects/{id}/undo': { post: { operationId: 'undo', summary: 'Undo the last edit', parameters: [pid], responses: ok('Undone') } },
    '/api/projects/{id}/redo': { post: { operationId: 'redo', summary: 'Redo', parameters: [pid], responses: ok('Redone') } },
    '/api/projects/{id}/history': { get: { operationId: 'history', summary: 'Undo/redo stacks', parameters: [pid], responses: ok('History') } },
    '/api/projects/{id}/activity': { get: { operationId: 'activity', summary: 'Recent edits with authors', parameters: [pid, { name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: ok('Entries', { type: 'array' }) } },
    '/api/projects/{id}/assets': {
      post: {
        operationId: 'importAudio', summary: 'Import audio: multipart upload, raw body (?name=), or JSON {url|base64, name}', parameters: [pid, { name: 'name', in: 'query', schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { url: { type: 'string' }, base64: { type: 'string' }, name: { type: 'string' } } } }, 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } }, 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        responses: { 201: { description: 'Asset' } },
      },
    },
    '/api/projects/{id}/assets/{assetId}/audio': { get: { operationId: 'getAssetAudio', summary: '32-bit float WAV', parameters: [pid, { name: 'assetId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'WAV', content: { 'audio/wav': {} } } } } },
    '/api/projects/{id}/assets/{assetId}/process': {
      post: {
        operationId: 'processAsset', summary: 'Destructive processing into a new asset', parameters: [pid, { name: 'assetId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: body({ type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: Object.keys(PROCESSES) }, params: { type: 'object' }, replaceInClips: { type: 'boolean' } } }, Object.entries(PROCESSES).map(([k, v]) => `${k}: ${v.description}`).join('\n')),
        responses: { 201: { description: 'New asset' } },
      },
    },
    '/api/projects/{id}/analyze': {
      post: { operationId: 'analyze', summary: 'Loudness, levels, silences, spectrum, envelope', parameters: [pid], requestBody: body({ type: 'object', properties: { target, include: { type: 'array', items: { type: 'string', enum: ['loudness', 'levels', 'silences', 'spectrum', 'envelope'] } }, silenceThresholdDb: { type: 'number' }, minSilence: { type: 'number' }, envelopeStep: { type: 'number' } } }), responses: ok('Analysis') },
    },
    '/api/projects/{id}/image': {
      get: { operationId: 'image', summary: 'Waveform or spectrogram PNG', parameters: [pid, ...['kind', 'assetId', 'clipId'].map((n) => ({ name: n, in: 'query', schema: { type: 'string' } })), ...['start', 'end', 'width', 'height'].map((n) => ({ name: n, in: 'query', schema: { type: 'number' } }))], responses: { 200: { description: 'PNG', content: { 'image/png': {} } } } },
    },
    '/api/projects/{id}/render': {
      post: { operationId: 'render', summary: 'Export the mix (or bounce it into the bin)', parameters: [pid], requestBody: body({ type: 'object', properties: { format: { type: 'string', enum: Object.keys(FORMATS) }, bitDepth: { type: 'integer', enum: [16, 24, 32] }, bitrate: { type: 'integer' }, sampleRate: { type: 'integer' }, start: { type: 'number' }, end: { type: 'number' }, tail: { type: 'number' }, loudness: { type: 'object', properties: { lufs: { type: 'number' }, truePeak: { type: 'number' } } }, bounce: { type: 'boolean' }, name: { type: 'string' } } }), responses: { 201: { description: 'Render metadata with url' } } },
    },
    '/api/projects/{id}/renders': { get: { operationId: 'listRenders', summary: 'Previous exports', parameters: [pid], responses: ok('Renders', { type: 'array' }) } },
    '/api/ops': { get: { operationId: 'listOps', summary: 'Operation catalogue with JSON schemas', responses: ok('Ops', { type: 'array' }) } },
    '/api/effects': { get: { operationId: 'listEffects', summary: 'Real-time effect types and parameter ranges', responses: ok('Effects') } },
    '/api/processes': { get: { operationId: 'listProcesses', summary: 'Destructive process kinds', responses: ok('Processes') } },
  };

  return {
    openapi: '3.1.0',
    info: { title: 'NyxMix', version: '0.1.0', description: 'Agent-first multitrack audio editor. Every UI action is one of these calls. Send X-Actor: agent:<name> so humans see who edited.' },
    servers: [{ url: server }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      schemas: Object.fromEntries(Object.entries(opSchemas).map(([k, v]) => [k.replace('.', '_'), v])),
    },
    security: [{ bearer: [] }],
    paths,
  };
}
