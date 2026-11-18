import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Tiny stand-in for YTPTube. It models the endpoints the plugin uses and
 * "downloads" by ticking progress up and then writing a random file.
 */
export function startMock({ downloadDir, port, makeFile }) {
  const queue = new Map();
  const history = new Map();
  const calls = [];

  const json = (res, status, body) => {
    const s = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
    res.end(s);
  };
  const readBody = async (req) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const s = Buffer.concat(chunks).toString();
    return s ? JSON.parse(s) : {};
  };

  function tickItem(item) {
    const timer = setInterval(() => {
      if (item.status === 'cancelled') return clearInterval(timer);
      item.status = 'downloading';
      item.percent = Math.min(100, item.percent + 20);
      item.speed = 1_500_000;
      item.eta = Math.round((100 - item.percent) / 20);
      item.title = 'Mock Video Title';
      if (item.percent >= 100) {
        clearInterval(timer);
        item.status = 'finished';
        item.filename = `${item.id}.mp4`;
        const dir = join(downloadDir, item.folder);
        mkdirSync(dir, { recursive: true });
        if (makeFile) { // caller supplies a real video
          makeFile(join(dir, item.filename));
          item.file_size = statSync(join(dir, item.filename)).size;
        } else {
          const data = randomBytes(1_048_576);
          writeFileSync(join(dir, item.filename), data);
          item.file_size = data.length;
        }
        queue.delete(item.id);
        history.set(item.id, item);
      }
    }, 250);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    calls.push(`${req.method} ${url.pathname}`);
    const p = url.pathname;

    if (req.method === 'POST' && p === '/api/history') {
      const body = await readBody(req);
      const item = {
        id: randomUUID(), url: body.url, status: 'pending', percent: 0, title: null,
        folder: 'mockchan', filename: null, extras: {}, error: null,
      };
      queue.set(item.id, item);
      tickItem(item);
      return json(res, 200, [{ status: true, msg: 'Item added.', item }]);
    }
    if (req.method === 'GET' && p === '/api/history/live') {
      return json(res, 200, { queue: Object.fromEntries(queue) });
    }
    if (req.method === 'GET' && p === '/api/history') {
      return json(res, 200, { history: [...history.values()] });
    }
    if (req.method === 'GET' && p.startsWith('/api/history/') && p !== '/api/history/live') {
      const id = decodeURIComponent(p.split('/').pop());
      const item = queue.get(id) ?? history.get(id);
      return item ? json(res, 200, item) : json(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST' && p === '/api/history/cancel') {
      const { ids } = await readBody(req);
      for (const id of ids) {
        const it = queue.get(id);
        if (it) { it.status = 'cancelled'; queue.delete(id); history.set(id, it); }
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'DELETE' && p === '/api/history') {
      const { ids } = await readBody(req);
      for (const id of ids) history.delete(id);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/yt-dlp/url/info') {
      return json(res, 200, { title: 'Mock Info Title', description: 'A mock description' });
    }
    json(res, 404, { error: 'unknown route' });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({
      calls,
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
      cleanup: () => rmSync(downloadDir, { recursive: true, force: true }),
    }));
  });
}
