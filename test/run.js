import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-ytptube.js';
import { parseVideoUrl } from '../src/urls.js';
import { parseRange } from '../src/stream.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'ytdl-gw-'));
const downloadDir = join(tmp, 'downloads');
const GW_PORT = 38931;
const MOCK_PORT = 38932;
const gw = `http://127.0.0.1:${GW_PORT}`;
const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (path, body) => fetch(gw + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// ---------- unit checks ----------
assert.deepEqual(parseVideoUrl('https://youtu.be/dQw4w9WgXcQ?t=4').sourceId, 'dQw4w9WgXcQ');
assert.equal(parseVideoUrl('https://m.youtube.com/shorts/dQw4w9WgXcQ').canonicalUrl, YT);
assert.equal(parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx&index=3').canonicalUrl, YT);
assert.equal(parseVideoUrl('https://www.twitch.tv/videos/123456789').sourceId, '123456789');
assert.equal(parseVideoUrl('https://clips.twitch.tv/AbC-dEf_1').sourceId, 'clip:AbC-dEf_1');
assert.equal(parseVideoUrl('https://www.twitch.tv/somechannel'), null);
assert.equal(parseVideoUrl('https://example.com/watch?v=dQw4w9WgXcQ'), null);
assert.equal(parseVideoUrl('not a url'), null);
assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
assert.deepEqual(parseRange('bytes=500-5000', 1000), { start: 500, end: 999 });
assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable');
assert.equal(parseRange('bytes=0-1,5-6', 1000), null);
ok('URL parsing and Range parsing');

const mock = await startMock({ downloadDir, port: MOCK_PORT });
const child = spawn(process.execPath, ['--no-warnings', 'src/index.js'], {
  cwd: root,
  env: {
    ...process.env, ENV_FILE: '/nonexistent', PORT: String(GW_PORT), HOST: '127.0.0.1',
    DOWNLOAD_PATH: downloadDir, DB_PATH: join(tmp, 'gw.db'), YTDLP_UI: 'ytptube',
    YTPTUBE_URL: `http://127.0.0.1:${MOCK_PORT}`, POLL_INTERVAL_MS: '300',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

async function cleanup(code) {
  child.kill('SIGTERM');
  await mock.close();
  rmSync(tmp, { recursive: true, force: true });
  process.exit(code);
}
process.on('unhandledRejection', (e) => { console.error(e); cleanup(1); });

try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${gw}/api/health`)).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }

  // ---------- validation ----------
  let r = await post('/api/download', { url: 'https://example.com/x' });
  assert.equal(r.status, 400);
  r = await post('/api/download', {});
  assert.equal(r.status, 400);
  ok('rejects unsupported / missing URL with 400');

  // ---------- POST /api/download ----------
  r = await post('/api/download', { url: YT });
  assert.equal(r.status, 202);
  const first = await r.json();
  assert.match(first.uuid, /^[0-9a-f-]{36}$/);
  assert.equal(first.existing, false);
  assert.equal(first.links.events, `/api/videos/${first.uuid}/events`);
  ok('POST /api/download -> 202 with uuid and events link');

  // Duplicate while in flight (different URL spelling of the same video)
  r = await post('/api/download', { url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(r.status, 200);
  const dup = await r.json();
  assert.equal(dup.uuid, first.uuid);
  assert.equal(dup.existing, true);
  const addCalls = mock.calls.filter((c) => c === 'POST /api/history').length;
  assert.equal(addCalls, 1, 'must not ask YTPTube to download twice');
  ok('duplicate URL returns same uuid and does not re-download');

  // ---------- GET /api/videos/:uuid while downloading ----------
  r = await fetch(`${gw}/api/videos/${first.uuid}/stream`);
  assert.equal(r.status, 409);
  ok('stream before completion -> 409');

  // ---------- SSE ----------
  r = await fetch(`${gw}/api/videos/${first.uuid}/events`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const events = [];
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  outer: for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (ev && data) events.push({ ev, data: JSON.parse(data) });
      if (ev === 'done') break outer;
    }
  }
  const percents = events.filter((e) => e.ev === 'progress').map((e) => e.data.percent);
  assert.ok(percents.length >= 2, 'got several progress events');
  assert.deepEqual([...percents].sort((a, b) => a - b), percents, 'progress is monotonic');
  assert.equal(events.at(-1).ev, 'done');
  assert.equal(events.at(-1).data.status, 'finished');
  ok(`SSE streamed ${percents.length} progress events then done (${percents.join(',')})`);

  // ---------- GET /api/videos/:uuid ----------
  r = await fetch(`${gw}/api/videos/${first.uuid}`);
  const info = await r.json();
  assert.equal(info.status, 'finished');
  assert.equal(info.percent, 100);
  assert.ok(info.title);
  assert.equal(info.description, 'A mock description');
  assert.equal(info.links.stream, `/api/videos/${first.uuid}/stream`);
  assert.equal(info.links.events, null);
  assert.equal(info.fileSize, 1_048_576);
  ok('GET /api/videos/:uuid -> finished, title, description, stream link');

  // ---------- GET /api/videos/:uuid/stream (Range) ----------
  // locate the file the mock wrote (one mp4 in mockchan)
  const { readdirSync } = await import('node:fs');
  const fname = readdirSync(join(downloadDir, 'mockchan')).find((f) => f.endsWith('.mp4'));
  const onDisk = readFileSync(join(downloadDir, 'mockchan', fname));

  r = await fetch(`${gw}/api/videos/${first.uuid}/stream`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  assert.equal(Number(r.headers.get('content-length')), onDisk.length);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(onDisk));
  ok('full stream is byte-identical, advertises Accept-Ranges');

  r = await fetch(`${gw}/api/videos/${first.uuid}/stream`, { headers: { range: 'bytes=1000-1999' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 1000-1999/${onDisk.length}`);
  assert.equal(r.headers.get('content-length'), '1000');
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(onDisk.subarray(1000, 2000)));
  ok('Range bytes=1000-1999 -> 206 with exact bytes');

  r = await fetch(`${gw}/api/videos/${first.uuid}/stream`, { headers: { range: 'bytes=1048000-' } });
  assert.equal(r.status, 206);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(onDisk.subarray(1048000)));
  r = await fetch(`${gw}/api/videos/${first.uuid}/stream`, { headers: { range: 'bytes=-500' } });
  assert.equal(r.status, 206);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(onDisk.subarray(onDisk.length - 500)));
  ok('open-ended and suffix ranges work (seek to end)');

  r = await fetch(`${gw}/api/videos/${first.uuid}/stream`, { headers: { range: `bytes=${onDisk.length + 5}-` } });
  assert.equal(r.status, 416);
  assert.equal(r.headers.get('content-range'), `bytes */${onDisk.length}`);
  ok('out-of-range -> 416');

  r = await fetch(`${gw}/api/videos/${first.uuid}/stream`, { method: 'HEAD' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-length'), String(onDisk.length));
  ok('HEAD works');

  // ---------- duplicate after completion ----------
  r = await post('/api/download', { url: YT });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).uuid, first.uuid);
  ok('duplicate after completion still returns existing uuid');

  // ---------- DELETE ----------
  r = await fetch(`${gw}/api/videos/${first.uuid}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).deleted, true);
  assert.equal(existsSync(join(downloadDir, 'mockchan', fname)), false, 'file removed from disk');
  r = await fetch(`${gw}/api/videos/${first.uuid}`);
  assert.equal(r.status, 404);
  r = await fetch(`${gw}/api/videos/${first.uuid}/stream`);
  assert.equal(r.status, 404);
  assert.ok(mock.calls.includes('DELETE /api/history'), 'YTPTube was told to delete too');
  ok('DELETE removes file, DB row and YTPTube history entry');

  // ---------- re-download after delete ----------
  r = await post('/api/download', { url: YT });
  assert.equal(r.status, 202);
  const again = await r.json();
  assert.notEqual(again.uuid, first.uuid);
  ok('after delete the same URL downloads again with a new uuid');

  // ---------- 404 / 405 ----------
  assert.equal((await fetch(`${gw}/api/videos/not-a-uuid`)).status, 404);
  assert.equal((await fetch(`${gw}/api/nope`)).status, 404);
  assert.equal((await fetch(`${gw}/api/download`)).status, 405);
  ok('404 / 405 handling');

  console.log(`\n${passed} checks passed`);
  await cleanup(0);
} catch (err) {
  console.error('\nTEST FAILED:', err);
  await cleanup(1);
}
