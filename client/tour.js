#!/usr/bin/env node
/**
 * Sample client for ytdl-gateway. Walks through every endpoint with pretty output.
 *
 *   node client/tour.js [video-url] [--base http://host:3000] [--keep] [--full] [--insecure]
 *
 *   --keep      don't delete the video at the end
 *   --full      also download the whole file through /stream and checksum it
 *   --insecure  accept self-signed TLS certificates (when the gateway uses TLS_KEY/TLS_CERT)
 *
 * Env: GATEWAY_URL (same as --base), NO_COLOR=1 to disable colours.
 */
import { createHash } from 'node:crypto';

// ---------- args ----------
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--base');
const BASE = (opt('--base') || process.env.GATEWAY_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const VIDEO_URL = positional[0] || 'https://www.twitch.tv/videos/2021340640'; // https://www.twitch.tv/videos/2021340640 // https://www.youtube.com/watch?v=Ua_X6HEllEo
const KEEP = flag('--keep');
const FULL = flag('--full');
if (flag('--insecure')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ---------- styling ----------
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (...codes) => (s) => (tty ? `\x1b[${codes.join(';')}m${s}\x1b[0m` : String(s));
const c = {
  bold: sgr(1), dim: sgr(2), red: sgr(31), green: sgr(32), yellow: sgr(33),
  blue: sgr(34), magenta: sgr(35), cyan: sgr(36), gray: sgr(90),
  method: { GET: sgr(1, 32), POST: sgr(1, 33), DELETE: sgr(1, 31), HEAD: sgr(1, 36) },
};
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - strip(s).length));
const W = Math.min(process.stdout.columns || 80, 92);
const out = (s = '') => process.stdout.write(s + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fmtBytes = (n) => {
  if (n == null) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
};
const fmtEta = (s) => (s == null ? '–' : s >= 3600 ? `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m${Math.round(s % 60)}s` : `${Math.round(s)}s`);
const fmtMs = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

function banner() {
  const lines = [c.bold('ytdl-gateway · sample client'), c.dim(`gateway  ${BASE}`), c.dim(`video    ${VIDEO_URL}`)];
  const inner = W - 4;
  out(c.cyan('╭' + '─'.repeat(inner + 2) + '╮'));
  for (const l of lines) out(c.cyan('│ ') + pad(l, inner) + c.cyan(' │'));
  out(c.cyan('╰' + '─'.repeat(inner + 2) + '╯'));
}

let stepNo = 0;
const TOTAL_STEPS = 9;
function step(title) {
  stepNo++;
  out();
  out(c.bold(c.magenta(`[${stepNo}/${TOTAL_STEPS}]`)) + ' ' + c.bold(title));
  out(c.gray('─'.repeat(W)));
}

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  out(`  ${pass ? c.green('✔') : c.red('✘')} ${name}${detail ? c.dim('  ' + detail) : ''}`);
}

function statusColor(code) {
  const s = String(code);
  return s[0] === '2' ? c.green(s) : s[0] === '3' ? c.cyan(s) : s[0] === '4' ? c.yellow(s) : c.red(s);
}

/** Make a request, print a request/response line, return { res, ms, body? } */
async function api(method, path, { json, headers = {}, label, raw = false } = {}) {
  const t0 = performance.now();
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...headers },
    body: json ? JSON.stringify(json) : undefined,
  });
  const ms = performance.now() - t0;
  out(`  ${c.method[method](pad(method, 6))} ${path}${label ? c.dim('  ' + label) : ''}`);
  out(`  ${c.gray('└▶')} ${statusColor(res.status)} ${c.dim(res.statusText || '')} ${c.gray('· ' + fmtMs(ms))}`);
  if (raw) return { res, ms };
  const text = await res.text();
  let body = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  return { res, ms, body };
}

/** Render key/value rows in a small table. */
function table(rows) {
  const kw = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) out(`    ${c.gray(pad(k, kw))}  ${v}`);
}

const BAR = 32;
function bar(pct) {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * BAR);
  return c.cyan('█'.repeat(filled)) + c.gray('░'.repeat(BAR - filled));
}

function showVideo(v) {
  table([
    ['uuid', c.cyan(v.uuid)],
    ['status', statusPill(v.status)],
    ['title', v.title ? c.bold(v.title) : c.dim('(not known yet)')],
    ['description', v.description ? c.dim(v.description.replace(/\s+/g, ' ').slice(0, W - 20) + (v.description.length > W - 20 ? '…' : '')) : c.dim('(none)')],
    ['progress', `${bar(v.percent ?? 0)} ${(v.percent ?? 0).toFixed(1)}%`],
    ['size', fmtBytes(v.fileSize)],
    ['links', c.dim(Object.entries(v.links || {}).filter(([, x]) => x).map(([k]) => k).join(', '))],
  ]);
}
function statusPill(s) {
  const f = { finished: c.green, downloading: c.cyan, queued: c.yellow, error: c.red, cancelled: c.red }[s] || c.gray;
  return f(`● ${s}`);
}

/** Consume an SSE response, calling onEvent(event, data). Resolves when the stream ends. */
async function readSse(res, onEvent) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (ev && data && onEvent(ev, JSON.parse(data)) === false) { await reader.cancel(); return; }
    }
  }
}

// ---------- the tour ----------
async function main() {
  banner();

  // 1 -----------------------------------------------------------------
  step('Health check');
  try {
    const { res, body } = await api('GET', '/api/health');
    check('gateway reachable', res.ok, `plugin=${body?.plugin} protocol=${body?.protocol}`);
    if (!res.ok) throw new Error('unhealthy');
  } catch (err) {
    out(`  ${c.red('✘')} cannot reach ${BASE}: ${err.cause?.code || err.message}`);
    out(c.dim('    Is the gateway running? Try: npm start   (or pass --base http://host:port)'));
    process.exit(1);
  }

  // 2 -----------------------------------------------------------------
  step('Start a download  ·  POST /api/download');
  const first = await api('POST', '/api/download', { json: { url: VIDEO_URL } });
  if (!first.res.ok) {
    out(`  ${c.red('✘')} ${first.body?.error || 'request failed'}`);
    process.exit(1);
  }
  const video = first.body;
  const uuid = video.uuid;
  check('accepted', [200, 202].includes(first.res.status), video.existing ? 'already known — not downloading again' : 'new download queued');
  showVideo(video);

  // 3 -----------------------------------------------------------------
  step('Duplicate request  ·  POST /api/download (same video, different URL spelling)');
  const idMatch = /[?&]v=([\w-]{11})/.exec(VIDEO_URL) || /youtu\.be\/([\w-]{11})/.exec(VIDEO_URL);
  const altUrl = idMatch ? `https://youtu.be/${idMatch[1]}?t=1` : VIDEO_URL;
  const dup = await api('POST', '/api/download', { json: { url: altUrl }, label: altUrl });
  check('same uuid returned', dup.body?.uuid === uuid, dup.body?.uuid);
  check('flagged as existing, no second download', dup.body?.existing === true && dup.res.status === 200);

  // 4 -----------------------------------------------------------------
  step('Live progress  ·  GET /api/videos/{uuid}/events  (Server-Sent Events)');
  let last = video;
  if (video.status !== 'finished' && video.links?.events) {
    const sse = await api('GET', video.links.events, { raw: true, headers: { accept: 'text/event-stream' } });
    check('SSE connected', sse.res.ok && /event-stream/.test(sse.res.headers.get('content-type') || ''), sse.res.headers.get('content-type'));
    let count = 0;
    let lastLogged = -1;
    const t0 = performance.now();
    await readSse(sse.res, (ev, v) => {
      if (ev === 'deleted') return false;
      count++;
      last = v;
      const line = `  ${bar(v.percent ?? 0)} ${pad(`${(v.percent ?? 0).toFixed(1)}%`, 7)} ${statusPill(v.status)} ` +
        c.dim(`${v.speed ? fmtBytes(v.speed) + '/s' : '–'} · eta ${fmtEta(v.eta)}`);
      if (tty) process.stdout.write('\r\x1b[2K' + line);
      else if (Math.floor((v.percent ?? 0) / 10) !== lastLogged) { lastLogged = Math.floor((v.percent ?? 0) / 10); out(line); }
      return ev !== 'done';
    });
    if (tty) process.stdout.write('\n');
    check(`received ${count} events until done`, count > 0 && ['finished', 'error', 'cancelled'].includes(last.status), `in ${fmtMs(performance.now() - t0)}`);
  } else {
    out(`  ${c.dim('already finished — no live stream to watch')}`);
  }

  // 5 -----------------------------------------------------------------
  step('Video details  ·  GET /api/videos/{uuid}');
  const info = await api('GET', `/api/videos/${uuid}`);
  showVideo(info.body);
  check('download finished', info.body?.status === 'finished', info.body?.error || '');
  if (info.body?.status !== 'finished') {
    out(`\n  ${c.red('Download did not finish; skipping streaming tests.')}`);
    return summary(uuid, false);
  }
  const size = info.body.fileSize;

  // 6 -----------------------------------------------------------------
  step('Streaming  ·  HEAD + GET /api/videos/{uuid}/stream');
  const head = await api('HEAD', `/api/videos/${uuid}/stream`, { raw: true });
  const ctype = head.res.headers.get('content-type');
  const len = Number(head.res.headers.get('content-length'));
  table([
    ['content-type', ctype], ['content-length', `${fmtBytes(len)} ${c.dim(`(${len} bytes)`)}`],
    ['accept-ranges', head.res.headers.get('accept-ranges')], ['http', c.dim('HTTP/1.1 or h2, negotiated by fetch')],
  ]);
  check('HEAD reports size and range support', head.res.ok && head.res.headers.get('accept-ranges') === 'bytes' && len === size);

  // 7 -----------------------------------------------------------------
  step('Seeking  ·  Range requests (what a <video> tag does)');
  const probes = [
    { name: 'first 1 KiB', range: 'bytes=0-1023', start: 0, end: 1023 },
    { name: 'middle 1 KiB', range: `bytes=${Math.floor(len / 2)}-${Math.floor(len / 2) + 1023}`, start: Math.floor(len / 2), end: Math.floor(len / 2) + 1023 },
    { name: 'open-ended near end', range: `bytes=${len - 2048}-`, start: len - 2048, end: len - 1 },
    { name: 'last 512 bytes (suffix)', range: 'bytes=-512', start: len - 512, end: len - 1 },
  ];
  for (const p of probes) {
    const r = await api('GET', `/api/videos/${uuid}/stream`, { headers: { range: p.range }, raw: true, label: p.range });
    const buf = Buffer.from(await r.res.arrayBuffer());
    const wantCR = `bytes ${p.start}-${p.end}/${len}`;
    const got = r.res.headers.get('content-range');
    check(`${p.name}`, r.res.status === 206 && got === wantCR && buf.length === p.end - p.start + 1, `${got} · ${fmtBytes(buf.length)}`);
  }
  const bad = await api('GET', `/api/videos/${uuid}/stream`, { headers: { range: `bytes=${len + 100}-` }, raw: true, label: `bytes=${len + 100}-` });
  await bad.res.arrayBuffer();
  check('beyond end of file is rejected', bad.res.status === 416, bad.res.headers.get('content-range'));

  if (FULL) {
    out();
    out(`  ${c.bold('Full download')} ${c.dim('(--full)')}`);
    const t0 = performance.now();
    const r = await api('GET', `/api/videos/${uuid}/stream`, { raw: true });
    const hash = createHash('sha256');
    let got = 0;
    for await (const chunk of r.res.body) {
      hash.update(chunk);
      got += chunk.length;
      if (tty) process.stdout.write(`\r\x1b[2K  ${bar((got / len) * 100)} ${((got / len) * 100).toFixed(0)}%  ${c.dim(fmtBytes(got / ((performance.now() - t0) / 1000)) + '/s')}`);
    }
    if (tty) process.stdout.write('\n');
    check('whole file received', got === len, `sha256 ${hash.digest('hex').slice(0, 16)}… in ${fmtMs(performance.now() - t0)}`);
  }

  out();
  out(`  ${c.bold('Use in a page:')}`);
  out(`  ${c.gray('<video controls src="')}${c.cyan(`${BASE}/api/videos/${uuid}/stream`)}${c.gray('"></video>')}`);

  await summary(uuid, true);
}

async function summary(uuid, canDelete) {
  // 8 -----------------------------------------------------------------
  step('Delete  ·  DELETE /api/videos/{uuid}');
  if (KEEP) {
    out(`  ${c.yellow('skipped')} ${c.dim('(--keep) — video left on disk')}`);
    out(`  ${c.dim('delete later with:')} curl -X DELETE ${BASE}/api/videos/${uuid}`);
    return finish();
  }
  const del = await api('DELETE', `/api/videos/${uuid}`);
  check('deleted', del.res.ok && del.body?.deleted === true);
  for (const w of del.body?.warnings ?? []) out(`  ${c.yellow('!')} ${c.dim(w)}`);

  // 9 -----------------------------------------------------------------
  step('Verify it is gone');
  const g = await api('GET', `/api/videos/${uuid}`);
  check('GET /api/videos/{uuid} → 404', g.res.status === 404);
  const s = await api('GET', `/api/videos/${uuid}/stream`);
  check('GET /api/videos/{uuid}/stream → 404', s.res.status === 404);
  finish();
}

function finish() {
  const pass = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  out();
  const ok = failed.length === 0;
  const msg = ok ? c.bold(c.green(`✔ All ${pass} checks passed`)) : c.bold(c.red(`✘ ${failed.length} of ${results.length} checks failed`));
  const inner = W - 4;
  const col = ok ? c.green : c.red;
  out(col('╭' + '─'.repeat(inner + 2) + '╮'));
  out(col('│ ') + pad(msg, inner) + col(' │'));
  for (const f of failed) out(col('│ ') + pad(c.red(`  - ${f.name}`), inner) + col(' │'));
  out(col('╰' + '─'.repeat(inner + 2) + '╯'));
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  out(`\n${c.red('✘ Unexpected error:')} ${err.stack || err}`);
  process.exit(1);
});
