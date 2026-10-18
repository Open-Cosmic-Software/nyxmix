// Render child process: renders one segment per message. Running renders in separate
// processes keeps the server alive even if the native audio library crashes.
import { renderSegment } from './render-core.js';

process.on('message', async ({ id, project, files, from, to, contentEnd, keep, plugins }) => {
  try {
    const ch = await renderSegment(project, files, { from, to, contentEnd, plugins });
    process.send({ id, channels: ch.map((c) => c.slice(keep)) });
  } catch (err) {
    process.send({ id, error: err.message });
  }
});
process.on('disconnect', () => process.exit(0));
