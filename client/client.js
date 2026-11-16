#!/usr/bin/env node
/**
 * Stand-alone client for the gateway. It runs separately from the server (any
 * machine that can reach it) and only talks to the public HTTP API:
 *
 *   POST /api/download            ask the gateway to fetch a video with yt-dlp
 *   GET  /api/videos/:id/events   follow progress (Server-Sent Events)
 *   GET  /api/videos/:id/stream   download the finished file to this machine
 *   DELETE /api/videos/:id        (optional) clean up on the server
 *
 *   node client/client.js [video-url] [--base http://host:3000] [--out ./downloads] [--delete] [--insecure]
 *
 *   video-url   defaults to the first YouTube video, "Me at the zoo" (19 s)
 *   --base      gateway address (or env GATEWAY_URL), default http://127.0.0.1:3000
 *   --out       where to save the file, default ./downloads
 *   --delete    delete the video from the server once it is saved locally
 *   --insecure  accept a self-signed TLS certificate
 *
 * Needs Node 18+, no dependencies. Exit code 0 = file saved.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const valueArgs = new Set(['--base', '--out']);
const positional = argv.filter((a, i) => !a.startsWith('--') && !valueArgs.has(argv[i - 1]));

const BASE = (opt('--base') || process.env.GATEWAY_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const OUT_DIR = opt('--out') || './downloads';
const VIDEO_URL = positional[0] || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
if (argv.includes('--insecure')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const tty = process.stdout.isTTY;
const fmtBytes = (n) => {
  if (n == null) return '–';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
};
const fmtEta = (s) => (s == null ? '–' : s >= 60 ? `${Math.floor(s / 60)}m${Math.round(s % 60)}s` : `${Math.round(s)}s`);
const bar = (pct, w = 28) => {
  const f = Math.round((Math.max(0, Math.min(100, pct)) / 100) * w);
  return '█'.repeat(f) + '░'.repeat(w - f);
};
const log = (s = '') => process.stdout.write(s + '\n');
/** Rewrite one terminal line when interactive, otherwise print a line every 10 %. */
let lastDecile = -1;
function progressLine(text, pct) {
  if (tty) return process.stdout.write('\r\x1b[2K' + text);
  const d = Math.floor(pct / 10);
  if (d !== lastDecile) { lastDecile = d; log(text); }
}
const endProgress = () => { if (tty) process.stdout.write('\n'); lastDecile = -1; };

class ApiError extends Error {
  constructor(res, body) {
    super(`${res.status} ${res.statusText}${body?.error ? ` – ${body.error}` : ''}`);
    this.status = res.status;
  }
}

async function api(method, path, json) {
  const res = await fetch(BASE + path, {
    method,
    headers: json ? { 'content-type': 'application/json' } : {},
    body: json ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) throw new ApiError(res, body);
  return { status: res.status, body };
}

/** Yield `[event, data]` pairs from a Server-Sent Events response. */
async function* sse(res) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (event && data) yield [event, JSON.parse(data)];
    }
  }
}

/** Follow a download until it reaches a final state. Returns the last snapshot. */
async function waitUntilDone(video) {
  if (!video.links.events) return video; // already finished (or failed)
  const res = await fetch(BASE + video.links.events, { headers: { accept: 'text/event-stream' } });
  if (!res.ok) throw new ApiError(res, null);

  let last = video;
  for await (const [event, v] of sse(res)) {
    if (event === 'deleted') throw new Error('The video was deleted on the server while waiting');
    last = v;
    if (v.title && !waitUntilDone.titleShown) { waitUntilDone.titleShown = true; if (tty) process.stdout.write('\n'); log(`  title: ${v.title}`); }
    progressLine(
      `  server  ${bar(v.percent ?? 0)} ${(v.percent ?? 0).toFixed(1).padStart(5)}%  ${v.status}  ` +
        `${v.speed ? fmtBytes(v.speed) + '/s' : '–'}  eta ${fmtEta(v.eta)}`,
      v.percent ?? 0,
    );
    if (event === 'done') break;
  }
  endProgress();
  return last;
}

/** Download /stream to disk (resumable: continues a leftover .part file). */
async function saveFile(video) {
  await mkdir(OUT_DIR, { recursive: true });
  const url = BASE + video.links.stream;

  // Ask for the name and size first.
  const head = await fetch(url, { method: 'HEAD' });
  if (!head.ok) throw new ApiError(head, null);
  const total = Number(head.headers.get('content-length'));
  const cd = head.headers.get('content-disposition') || '';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1];
  const name = basename(encoded ? decodeURIComponent(encoded) : `${video.sourceId}.mp4`);
  const finalPath = join(OUT_DIR, name);
  const partPath = finalPath + '.part';

  let offset = 0;
  try { offset = (await stat(partPath)).size; } catch { /* fresh download */ }
  if (offset >= total) offset = 0;

  const res = await fetch(url, { headers: offset ? { range: `bytes=${offset}-` } : {} });
  if (offset && res.status !== 206) offset = 0; // server ignored the range: start over
  if (!res.ok) throw new ApiError(res, null);

  const file = createWriteStream(partPath, { flags: offset ? 'a' : 'w' });
  let got = offset;
  const t0 = performance.now();
  for await (const chunk of res.body) {
    if (!file.write(chunk)) await new Promise((r) => file.once('drain', r));
    got += chunk.length;
    const speed = (got - offset) / ((performance.now() - t0) / 1000 || 1);
    progressLine(`  saving  ${bar((got / total) * 100)} ${((got / total) * 100).toFixed(1).padStart(5)}%  ${fmtBytes(got)} / ${fmtBytes(total)}  ${fmtBytes(speed)}/s`, (got / total) * 100);
  }
  await new Promise((resolve, reject) => file.end((err) => (err ? reject(err) : resolve())));
  endProgress();

  if (got !== total) throw new Error(`Incomplete download: got ${got} of ${total} bytes`);
  await rename(partPath, finalPath);
  return { path: finalPath, bytes: got };
}

async function main() {
  log(`gateway  ${BASE}`);
  log(`video    ${VIDEO_URL}`);

  // 1. Is the gateway up, and is it using the yt-dlp plugin?
  let health;
  try {
    health = (await api('GET', '/api/health')).body;
  } catch (err) {
    throw new Error(`Cannot reach the gateway at ${BASE} (${err.cause?.code || err.message}). Is it running? Use --base to point at it.`);
  }
  log(`plugin   ${health.plugin}${health.plugin === 'ytdlp' ? '' : '  (note: not the self-hosted yt-dlp plugin)'}\n`);

  // 2. Ask for the download. An already-known video is returned, not fetched again.
  const { status, body: video } = await api('POST', '/api/download', { url: VIDEO_URL });
  log(status === 200 ? `Already on the server (uuid ${video.uuid}), skipping the download step.` : `Queued on the server (uuid ${video.uuid}).`);

  // 3. Wait for yt-dlp inside the gateway container to finish.
  const done = await waitUntilDone(video);
  if (done.status !== 'finished') throw new Error(`Download ${done.status}: ${done.error || 'no details'}`);
  log(`Server finished: ${done.title ?? video.uuid} (${fmtBytes(done.fileSize)})\n`);

  // 4. Pull the file to this machine.
  const saved = await saveFile(done);
  log(`\nSaved ${fmtBytes(saved.bytes)} to ${saved.path}`);

  // 5. Optional cleanup on the server.
  if (argv.includes('--delete')) {
    await api('DELETE', `/api/videos/${done.uuid}`);
    log('Deleted from the server.');
  }
}

main().catch((err) => {
  endProgress();
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
