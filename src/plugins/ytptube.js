import { isAbsolute, join, relative } from 'node:path';

/**
 * YTPTube (https://github.com/arabcoders/ytptube) plugin.
 *
 * Endpoints used:
 *   POST   /api/history?sync=true      add a download
 *   GET    /api/history/live           live queue with progress
 *   GET    /api/history/{id}           single item (queue or history)
 *   GET    /api/history?type=done      history, used to re-find an item by URL
 *   POST   /api/history/cancel         cancel a running download
 *   DELETE /api/history                remove items from history
 *   GET    /api/yt-dlp/url/info        title/description without downloading
 *
 * Response bodies are searched for the item by id/url rather than relying on one
 * exact JSON layout, so small differences between YTPTube versions are tolerated.
 */
export default function createYtptube(config) {
  const cfg = config.ytptube;
  const base = cfg.url.replace(/\/+$/, '');
  const baseHeaders = { accept: 'application/json' };
  if (cfg.user) {
    baseHeaders.authorization = 'Basic ' + Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64');
  }

  async function call(method, path, { query, body, timeoutMs = cfg.timeoutMs } = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const headers = { ...baseHeaders };
    if (body !== undefined) headers['content-type'] = 'application/json';

    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const detail = typeof data === 'string' ? data.slice(0, 200) : data?.error ?? data?.message ?? '';
      const err = new Error(`YTPTube ${method} ${path} -> ${res.status} ${detail}`.trim());
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // Depth-limited search of a JSON tree for an item-like object.
  function findItem(node, match, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 6) return null;
    if (!Array.isArray(node) && match(node) && ('status' in node || 'url' in node)) return node;
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      const hit = findItem(child, match, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  const idOf = (n) => String(n.id ?? n._id ?? '');
  const byId = (id) => (n) => idOf(n) === String(id);

  const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  function mapState(status) {
    switch (String(status ?? '').toLowerCase()) {
      case 'finished': return 'finished';
      case 'error': case 'skip': return 'error';
      case 'cancelled': case 'canceled': return 'cancelled';
      case 'downloading': case 'postprocessing': case 'preparing': case 'started': return 'downloading';
      default: return 'queued';
    }
  }

  function normalize(item) {
    const state = mapState(item.status);
    const folder = item.folder || '';
    const fileCandidates = [];
    if (item.filename) {
      if (isAbsolute(item.filename)) {
        const rel = relative(cfg.remoteDownloadPath, item.filename);
        if (!rel.startsWith('..') && !isAbsolute(rel)) fileCandidates.push(rel);
      } else {
        if (folder) fileCandidates.push(join(folder, item.filename));
        fileCandidates.push(item.filename);
      }
    }
    let error = null;
    if (state === 'error') {
      error = item.error || item.msg ||
        (String(item.status).toLowerCase() === 'skip'
          ? 'Skipped by YTPTube (already in its download archive)'
          : 'Download failed');
    }
    return {
      state,
      percent: state === 'finished' ? 100 : num(item.percent),
      speed: num(item.speed),
      eta: num(item.eta),
      title: item.title || null,
      description: item.extras?.description ?? item.description ?? null,
      duration: num(item.extras?.duration ?? item.duration),
      thumbnail: item.extras?.thumbnail ?? item.thumbnail ?? null,
      error,
      fileCandidates,
      fileSize: num(item.file_size),
    };
  }

  async function tolerant404(promise) {
    try { return await promise; } catch (err) { if (err.status === 404) return null; throw err; }
  }

  async function findByUrl(url) {
    const match = (n) => n.url === url && idOf(n);
    const live = await tolerant404(call('GET', '/api/history/live')).catch(() => null);
    const hit = findItem(live, match);
    if (hit) return hit;
    const done = await tolerant404(
      call('GET', '/api/history', { query: { type: 'done', per_page: '100', order: 'DESC' } }),
    ).catch(() => null);
    return findItem(done, match);
  }

  return {
    name: 'ytptube',

    async add(url) {
      const item = { url, auto_start: true };
      if (cfg.preset) item.preset = cfg.preset;
      if (cfg.folder) item.folder = cfg.folder;
      if (cfg.template) item.template = cfg.template;

      let data = null;
      let addError = null;
      try {
        data = await call('POST', '/api/history', { query: { sync: 'true' }, body: item });
      } catch (err) {
        addError = err;
      }

      // YTPTube may refuse a URL it already knows; adopting the existing item is fine.
      const found = findItem(data, (n) => n.url === url && idOf(n)) ?? (await findByUrl(url));
      if (!found) {
        throw addError ?? new Error(`YTPTube did not return an item for ${url}: ${JSON.stringify(data)?.slice(0, 200)}`);
      }
      return { externalId: idOf(found) };
    },

    async status(externalId) {
      let item = null;
      try {
        item = findItem(await call('GET', '/api/history/live'), byId(externalId));
      } catch (err) {
        if (err.status !== 404) throw err;
      }

      const terminal = item && mapState(item.status) !== 'queued' && mapState(item.status) !== 'downloading';
      if (!item || (terminal && !item.filename)) {
        const detail = await tolerant404(call('GET', `/api/history/${encodeURIComponent(externalId)}`));
        const found = findItem(detail, byId(externalId)) ?? (detail && typeof detail === 'object' ? detail.item ?? null : null);
        if (found && typeof found === 'object') item = { ...item, ...found };
      }
      return item ? normalize(item) : null;
    },

    async remove(externalId, { removeFile = true } = {}) {
      const warnings = [];
      const attempt = async (label, fn) => {
        try { await fn(); } catch (err) { if (err.status !== 404) warnings.push(`${label}: ${err.message}`); }
      };
      await attempt('cancel', () => call('POST', '/api/history/cancel', { body: { ids: [externalId] } }));
      await attempt('delete', () =>
        call('DELETE', '/api/history', { body: { type: 'done', ids: [externalId], remove_file: removeFile } }));
      return { warnings };
    },

    async info(url) {
      const data = await call('GET', '/api/yt-dlp/url/info', {
        query: { url },
        timeoutMs: cfg.infoTimeoutMs,
      });
      const d = data?.info ?? data;
      if (!d || typeof d !== 'object') return null;
      return { title: d.title ?? null, description: d.description ?? null, duration: num(d.duration), thumbnail: d.thumbnail ?? null };
    },
  };
}
