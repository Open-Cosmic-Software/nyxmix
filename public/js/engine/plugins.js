// Plugins: user-supplied AudioWorklet effects. A plugin is a manifest
// { id, label, description, params } plus a worklet module that calls
// registerProcessor('plugin-<id>', …) with one k-rate AudioParam per manifest param.
// Registered plugins become ordinary effect types named "plugin:<id>", usable in
// the browser and in server renders alike.
import { EFFECTS } from './graph.js';

export const pluginType = (id) => `plugin:${id}`;

export function registerPlugin(m) {
  EFFECTS[pluginType(m.id)] = {
    label: m.label, description: `${m.description || 'Plugin'} (plugin by ${m.author || 'unknown'})`,
    worklet: `plugin-${m.id}`, plugin: m.id, params: m.params,
  };
}

const loaded = new WeakMap();
// Load the worklet modules of plugins used by a project into a context (once per context).
export async function loadPluginModules(ctx, project, urlFor) {
  let set = loaded.get(ctx);
  if (!set) loaded.set(ctx, (set = new Map()));
  const ids = new Set();
  for (const list of [project.master?.effects || [], ...project.tracks.map((t) => t.effects || [])]) for (const e of list) if (EFFECTS[e.type]?.plugin) ids.add(EFFECTS[e.type].plugin);
  await Promise.all([...ids].map((id) => {
    if (!set.has(id)) set.set(id, ctx.audioWorklet.addModule(urlFor(id)));
    return set.get(id);
  }));
}
