import { createReadStream, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { isInside } from './paths.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

const fileOf = (p) => { try { const st = statSync(p); return st.isFile() ? st : null; } catch { return null; } };

/**
 * Serves the built Vue app. Returns a handler `(req, res, pathname) => boolean`
 * (true = handled), or null when there is no build to serve.
 * Unknown paths fall back to index.html (single-page app).
 */
export function createStatic(root) {
  const base = resolve(root);
  if (!fileOf(join(base, 'index.html'))) return null;

  return (req, res, pathname) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (pathname.startsWith('/api/')) return false;

    let file = join(base, decodeURIComponent(pathname));
    let st = isInside(base, file) ? fileOf(file) : null;
    if (!st) {
      if (extname(pathname)) return false; // a missing asset is a real 404
      file = join(base, 'index.html');
      st = fileOf(file);
    }
    const hashed = file.includes(`${join(base, 'assets')}`);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end(), true;
    createReadStream(file).pipe(res);
    return true;
  };
}
