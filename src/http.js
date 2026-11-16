export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

export async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
}

/** Minimal router: ":name" segments become params. HEAD is routed as GET. */
export function createRouter() {
  const routes = [];
  return {
    add(method, pattern, handler) {
      const keys = [];
      const re = new RegExp(
        '^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$',
      );
      routes.push({ method, re, keys, handler });
    },
    match(method, pathname) {
      const m = method === 'HEAD' ? 'GET' : method;
      let pathMatched = false;
      for (const r of routes) {
        const hit = r.re.exec(pathname);
        if (!hit) continue;
        pathMatched = true;
        if (r.method !== m) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(hit[i + 1]); });
        return { handler: r.handler, params };
      }
      return { pathMatched };
    },
  };
}

/** Server-Sent Events response helper (works on HTTP/1.1 and HTTP/2). */
export function openSse(res, headers = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
    ...headers,
  });
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');

  let closed = false;
  const closeHandlers = [];
  const heartbeat = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, 15_000);

  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const fn of closeHandlers) fn();
  };
  res.on('close', finish);

  return {
    send(event, data) {
      if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    onClose(fn) { closeHandlers.push(fn); },
    end() {
      if (closed) return;
      finish();
      res.end();
    },
  };
}
