import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream';
import { basename, extname } from 'node:path';

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime', '.ts': 'video/mp2t', '.flv': 'video/x-flv', '.avi': 'video/x-msvideo',
  '.ogv': 'video/ogg', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.sbb': 'application/octet-stream', '.opus': 'audio/ogg', '.ogg': 'audio/ogg',
};

/**
 * Parse a single-range `Range` header.
 * @returns {null | 'unsatisfiable' | {start:number,end:number}}
 *   null = no (usable) range, serve the whole file.
 */
export function parseRange(header, size) {
  if (!header || size === 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!m) return null; // other units / multi-range: ignoring Range is allowed by RFC 9110
  const [, a, b] = m;
  if (a === '' && b === '') return null;

  let start;
  let end;
  if (a === '') { // suffix range: last N bytes
    const n = Number(b);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
    if (start >= size || start > end) return 'unsatisfiable';
  }
  return { start, end };
}

export function serveFile(req, res, filePath, st, extraHeaders = {}) {
  const size = st.size;
  const etag = `W/"${size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const lastModified = st.mtime.toUTCString();

  const headers = {
    'accept-ranges': 'bytes',
    'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(basename(filePath))}`,
    'cache-control': 'private, max-age=0, must-revalidate',
    etag,
    'last-modified': lastModified,
    ...extraHeaders,
  };

  let range = parseRange(req.headers.range, size);
  const ifRange = req.headers['if-range'];
  if (ifRange && ifRange !== etag && ifRange !== lastModified) range = null;

  if (!range && req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }

  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${size}`, 'content-length': 0 });
    return res.end();
  }

  let status = 200;
  let start = 0;
  let end = size - 1;
  if (range) {
    status = 206;
    ({ start, end } = range);
    headers['content-range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['content-length'] = size === 0 ? 0 : end - start + 1;

  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) return res.end();

  const file = createReadStream(filePath, { start, end, highWaterMark: 256 * 1024 });
  pipeline(file, res, (err) => {
    // Players abort connections constantly while seeking; that is not an error.
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') res.destroy(err);
  });
}
