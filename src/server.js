import http from 'node:http';
import http2 from 'node:http2';
import { readFileSync } from 'node:fs';
import { stat, unlink, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, extname } from 'node:path';
import { HttpError, createRouter, openSse, readJson, sendJson } from './http.js';
import { serveFile } from './stream.js';
import { parseVideoUrl } from './urls.js';
import { isInside } from './paths.js';
import { ACTIVE, TERMINAL, view } from './view.js';
import { log } from './log.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIDECARS = ['.info.json', '.description', '.jpg', '.jpeg', '.png', '.webp', '.nfo', '.srt', '.vtt'];

export function createServer({ config, db, plugin, hub, tracker }) {
  const cors = {
    'access-control-allow-origin': config.corsOrigin,
    'access-control-allow-methods': 'GET, POST, DELETE, HEAD, OPTIONS',
    'access-control-allow-headers': 'content-type, range, if-range',
    'access-control-expose-headers': 'content-range, accept-ranges, content-length, content-type',
    'access-control-max-age': '600',
  };

  const router = createRouter();

  const fileStat = async (path) => {
    try {
      const st = await stat(path);
      return st.isFile() ? st : null;
    } catch { return null; }
  };

  const mustGet = (uuid) => {
    const row = UUID_RE.test(uuid) ? db.getByUuid(uuid) : null;
    if (!row) throw new HttpError(404, 'Video not found');
    return row;
  };

  async function removeFiles(row) {
    const p = row.file_path;
    if (!p || !isInside(config.downloadPath, p)) return;
    const ext = extname(p);
    const stem = ext ? p.slice(0, -ext.length) : p;
    for (const file of [p, ...SIDECARS.map((s) => stem + s)]) {
      try { await unlink(file); } catch (err) { if (err.code !== 'ENOENT') log.warn(`could not delete ${file}: ${err.message}`); }
    }
    // Tidy up an empty per-channel folder, never the root.
    const dir = dirname(p);
    if (isInside(config.downloadPath, dir)) await rmdir(dir).catch(() => {});
  }

  /** Hand a row to the yt-dlp UI. Throws HttpError(502) if the UI can't take it. */
  async function startDownload(row, canonicalUrl, { isNew }) {
    if (!isNew) {
      row = db.update(row.uuid, { status: 'queued', percent: 0, speed: null, eta: null, error: null, external_id: null, file_path: null, file_size: null });
    }
    try {
      const { externalId } = await plugin.add(canonicalUrl);
      const next = db.update(row.uuid, { external_id: externalId });
      tracker.kick();

      // Title/description right away, without waiting for the first progress poll.
      plugin.info?.(canonicalUrl).then((info) => {
        if (!info) return;
        const cur = db.getByUuid(row.uuid);
        if (!cur) return;
        tracker.applyPatch(row.uuid, {
          title: cur.title ? undefined : info.title ?? undefined,
          description: cur.description ? undefined : info.description ?? undefined,
        });
      }).catch((err) => log.warn(`${plugin.name}: info lookup failed: ${err.message}`));

      return next;
    } catch (err) {
      if (isNew) db.delete(row.uuid);
      else db.update(row.uuid, { status: 'error', error: err.message });
      throw new HttpError(502, `Could not start the download via ${plugin.name}: ${err.message}`);
    }
  }

  // POST /api/download  { "url": "..." }
  router.add('POST', '/api/download', async ({ res, req }) => {
    const body = await readJson(req);
    const parsed = parseVideoUrl(body?.url);
    if (!parsed) {
      throw new HttpError(400, 'Provide a "url" for a single YouTube video or a Twitch VOD/clip');
    }

    const existing = db.getBySource(parsed.source, parsed.sourceId);
    if (existing) {
      const missingFile = existing.status === 'finished' && !(await fileStat(existing.file_path));
      const retry = existing.status === 'error' || existing.status === 'cancelled' || missingFile;
      if (!retry) {
        return sendJson(res, 200, { existing: true, ...view(existing) });
      }
      const row = await startDownload(existing, parsed.canonicalUrl, { isNew: false });
      return sendJson(res, 202, { existing: true, retried: true, ...view(row) });
    }

    // Insert first (synchronously) so a concurrent identical request sees the row.
    const row = db.insert({
      uuid: randomUUID(), source: parsed.source, sourceId: parsed.sourceId,
      url: parsed.canonicalUrl, plugin: plugin.name,
    });
    const started = await startDownload(row, parsed.canonicalUrl, { isNew: true });
    sendJson(res, 202, { existing: false, ...view(started) });
  });

  // GET /api/videos/:uuid
  router.add('GET', '/api/videos/:uuid', async ({ res, params }) => {
    const row = mustGet(params.uuid);
    sendJson(res, 200, view(row));
  });

  // DELETE /api/videos/:uuid
  router.add('DELETE', '/api/videos/:uuid', async ({ res, params }) => {
    const row = mustGet(params.uuid);
    let warnings = [];
    if (row.external_id) {
      try {
        ({ warnings = [] } = await plugin.remove(row.external_id, { removeFile: true }));
      } catch (err) {
        warnings.push(`${plugin.name}: ${err.message}`);
      }
    }
    await removeFiles(row);
    db.delete(row.uuid);
    hub.emit(row.uuid, 'deleted', { uuid: row.uuid });
    sendJson(res, 200, { deleted: true, uuid: row.uuid, warnings });
  });

  // GET /api/videos/:uuid/events  (Server-Sent Events)
  router.add('GET', '/api/videos/:uuid/events', async ({ req, res, params }) => {
    const row = mustGet(params.uuid);
    const sse = openSse(res, cors);

    sse.send('progress', view(row));
    if (TERMINAL.has(row.status)) {
      sse.send('done', view(row));
      return sse.end();
    }

    const unsubscribe = hub.subscribe(row.uuid, (event, data) => {
      sse.send(event, data);
      if (event === 'done' || event === 'deleted') sse.end();
    });
    sse.onClose(unsubscribe);
  });

  // GET|HEAD /api/videos/:uuid/stream  (Range-capable)
  router.add('GET', '/api/videos/:uuid/stream', async ({ req, res, params }) => {
    const row = mustGet(params.uuid);
    if (row.status !== 'finished') {
      throw new HttpError(409, `Video is not ready (status: ${row.status})`, { status: row.status, links: view(row).links });
    }
    const st = await fileStat(row.file_path);
    if (!st) throw new HttpError(410, `The video file is missing from disk (${row.file_path}); POST /api/download again to re-fetch it`);
    serveFile(req, res, row.file_path, st, cors);
  });

  router.add('GET', '/api/health', async ({ res }) => {
    sendJson(res, 200, { ok: true, plugin: plugin.name, protocol: config.tls.key ? 'h2' : 'http/1.1' });
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }
      const hit = router.match(req.method, url.pathname);
      if (!hit.handler) {
        throw new HttpError(hit.pathMatched ? 405 : 404, hit.pathMatched ? 'Method not allowed' : 'Not found');
      }
      await hit.handler({ req, res, url, params: hit.params });
    } catch (err) {
      if (res.headersSent) return res.destroy();
      if (err instanceof HttpError) {
        return sendJson(res, err.status, { error: err.message, ...err.extra });
      }
      log.error(`${req.method} ${url.pathname}:`, err);
      sendJson(res, 500, { error: 'Internal server error' });
    }
  }

  // HTTP/2 (with HTTP/1.1 fallback) when a certificate is configured, because
  // browsers only speak h2 over TLS. Otherwise plain HTTP/1.1.
  if (config.tls.key && config.tls.cert) {
    return http2.createSecureServer(
      { key: readFileSync(config.tls.key), cert: readFileSync(config.tls.cert), allowHTTP1: true },
      handle,
    );
  }
  return http.createServer(handle);
}
