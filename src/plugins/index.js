import { readdirSync } from 'node:fs';

/**
 * A yt-dlp UI plugin is a file in this folder whose default export is a
 * factory `(config) => plugin`. The plugin object must provide:
 *
 *   name: string
 *   add(url)                 -> Promise<{ externalId: string }>
 *   status(externalId)       -> Promise<null | {
 *        state: 'queued'|'downloading'|'finished'|'error'|'cancelled',
 *        percent: number|null, speed: number|null (bytes/s), eta: number|null (s),
 *        title: string|null, description: string|null, error: string|null,
 *        fileCandidates: string[]   // paths relative to DOWNLOAD_PATH, tried in order
 *        fileSize: number|null }>   // null = the UI no longer knows this id
 *   remove(externalId, { removeFile }) -> Promise<{ warnings: string[] }>
 *
 * and may provide:
 *   info(url) -> Promise<{ title, description } | null>   // metadata without downloading
 */
const REQUIRED = ['add', 'status', 'remove'];

export async function loadPlugin(name, config) {
  const dir = new URL('./', import.meta.url);
  const available = readdirSync(dir)
    .filter((f) => f.endsWith('.js') && f !== 'index.js')
    .map((f) => f.slice(0, -3));

  if (!available.includes(name)) {
    throw new Error(`Unknown YTDLP_UI "${name}". Available plugins: ${available.join(', ') || '(none)'}`);
  }

  const mod = await import(new URL(`./${name}.js`, import.meta.url));
  if (typeof mod.default !== 'function') throw new Error(`Plugin "${name}" must default-export a factory function`);

  const plugin = mod.default(config);
  for (const fn of REQUIRED) {
    if (typeof plugin?.[fn] !== 'function') throw new Error(`Plugin "${name}" is missing required method ${fn}()`);
  }
  plugin.name ??= name;
  return plugin;
}
