import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-ytptube.js';
import { createStoryboards, storyboardPath, SBB } from '../src/storyboard.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (spawnSync('ffmpeg', ['-version']).status !== 0) {
  console.log('  skip  storyboard tests (ffmpeg not installed)');
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), 'sbb-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (name) => console.log(`  ok  storyboard: ${name}`);

/** Tiny real video: `seconds` long, 1 fps, 320x180, with audio. */
function makeVideo(path, seconds) {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=1', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', String(seconds), '-pix_fmt', 'yuv420p', '-g', '10', path]);
  assert.equal(r.status, 0, String(r.stderr));
}

/** Parse an .sbb the way a reader of the documented format would. */
function parseSbb(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [0x53, 0x54, 0x4f, 0x52, 0x59, 0x73, 0x62, 0x1a]);
  const h = {
    version: buf.readUInt32LE(8), count: buf.readUInt32LE(12), width: buf.readUInt32LE(16), height: buf.readUInt32LE(20),
    fps: buf.readDoubleLE(24), rows: buf.readUInt32LE(32), columns: buf.readUInt32LE(36),
  };
  assert.ok(buf.subarray(40, 64).every((b) => b === 0), 'reserved bytes are zero');
  const entries = [];
  let pos = 64;
  for (;;) {
    const index = buf.readUInt32LE(pos);
    const e = { index, offset: buf.readUInt32LE(pos + 4), size: buf.readUInt32LE(pos + 8), duration: buf.readDoubleLE(pos + 12) };
    pos += 20;
    if (index === 0xffffffff) { entries.push({ terminator: true, ...e }); break; }
    entries.push(e);
  }
  return { ...h, entries, dataStart: pos };
}

/** JPEG width/height from its SOF marker. */
function jpegSize(b) {
  assert.equal(b[0], 0xff); assert.equal(b[1], 0xd8);
  for (let i = 2; i < b.length;) {
    assert.equal(b[i], 0xff);
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xc3) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  throw new Error('no SOF marker');
}

function checkSbb(file, { seconds }) {
  const buf = readFileSync(file);
  const s = parseSbb(buf);
  assert.equal(s.version, 0);
  assert.equal(s.width, 160); assert.equal(s.height, 90);
  assert.equal(s.fps, 0.1);
  assert.equal(s.rows, 10); assert.equal(s.columns, 10);
  const term = s.entries.at(-1);
  assert.ok(term.terminator && term.size === 0 && term.duration === 0);
  assert.equal(term.offset, buf.length, 'terminator offset = end of file');
  const sheets = s.count;
  assert.equal(s.dataStart, 64 + 20 * (sheets + 1));
  let expectOffset = s.dataStart;
  let totalSeconds = 0;
  s.entries.slice(0, -1).forEach((e, i) => {
    assert.equal(e.index, i);
    assert.equal(e.offset, expectOffset);
    expectOffset += e.size;
    const dim = jpegSize(buf.subarray(e.offset, e.offset + e.size));
    assert.deepEqual(dim, { width: 1600, height: 900 }, 'every sheet is a full 10x10 sheet of 160x90 images');
    totalSeconds += e.duration;
  });
  assert.equal(expectOffset, buf.length);
  const frames = totalSeconds / 10;
  assert.ok(Number.isInteger(frames));
  // one small image per 10 s; ffmpeg's -r may repeat the last frame once or twice at the end
  assert.ok(frames >= Math.ceil(seconds / 10) && frames <= Math.ceil(seconds / 10) + 3, `frames=${frames}`);
  assert.equal(sheets, Math.ceil(frames / 100));
  s.entries.slice(0, -2).forEach((e) => assert.equal(e.duration, 1000), 'full sheets cover 1000 s');
  return s;
}

/** Minimal db stand-in for createStoryboards. */
const fakeDb = (rows) => ({ getByUuid: (u) => rows[u] ?? null, listFinished: () => Object.values(rows) });
const cfg = { storyboard: { enabled: true, ffmpeg: 'ffmpeg' } };
async function waitFor(pred, ms = 60_000) {
  const t0 = Date.now();
  while (!pred()) { assert.ok(Date.now() - t0 < ms, 'timed out'); await sleep(100); }
}

let child; let mock;
async function cleanup(code) {
  child?.kill('SIGTERM');
  await mock?.close();
  rmSync(tmp, { recursive: true, force: true });
  process.exit(code);
}
process.on('unhandledRejection', (e) => { console.error(e); cleanup(1); });

try {
  assert.equal(storyboardPath('/d/Some Video [abc].mp4'), '/d/Some Video [abc].sbb');
  assert.equal(storyboardPath('/d/a.b/noext'), '/d/a.b/noext.sbb');

  // ---- short video: 25 s -> 3 small images (0 s, 10 s, 20 s) -> 1 sheet, 30 s ----
  const v1 = join(tmp, 'short.mp4');
  makeVideo(v1, 25);
  const rows = { u1: { uuid: 'u1', status: 'finished', file_path: v1 } };
  const sb = createStoryboards({ db: fakeDb(rows), config: cfg });
  sb.enqueue('u1');
  await waitFor(() => existsSync(storyboardPath(v1)));
  const s1 = checkSbb(storyboardPath(v1), { seconds: 25 });
  assert.ok(s1.count === 1);
  assert.deepEqual(readdirSync(tmp).filter((f) => f.endsWith('.part')), [], 'no partial file left');
  ok('25 s video -> one padded 1600x900 sheet, valid header/index/terminator');

  // ---- long video: 1050 s -> 105 small images -> 2 sheets (100 + 5) ----
  const v2 = join(tmp, 'long.mp4');
  makeVideo(v2, 1050);
  rows.u2 = { uuid: 'u2', status: 'finished', file_path: v2 };
  sb.enqueue('u2');
  await waitFor(() => existsSync(storyboardPath(v2)));
  const s2 = checkSbb(storyboardPath(v2), { seconds: 1050 });
  assert.equal(s2.count, 2);
  assert.equal(s2.entries[0].duration, 1000);
  ok('1050 s video -> two sheets, first one covers exactly 1000 s');

  // ---- clip shorter than one interval still gets a storyboard ----
  const v5 = join(tmp, 'tiny.mp4');
  makeVideo(v5, 3);
  rows.u5 = { uuid: 'u5', status: 'finished', file_path: v5 };
  sb.enqueue('u5');
  await waitFor(() => existsSync(storyboardPath(v5)));
  checkSbb(storyboardPath(v5), { seconds: 3 });
  ok('3 s clip (shorter than the 10 s interval) still gets a storyboard');

  // ---- not a video: no sbb, no crash, queue keeps working ----
  const bad = join(tmp, 'bad.mp4');
  writeFileSync(bad, 'definitely not a video');
  rows.u3 = { uuid: 'u3', status: 'finished', file_path: bad };
  sb.enqueue('u3');
  await sleep(1500);
  assert.ok(!existsSync(storyboardPath(bad)));
  ok('invalid video is skipped without leaving files behind');

  // ---- deleted while generating: no orphan ----
  const v4 = join(tmp, 'gone.mp4');
  makeVideo(v4, 25);
  rows.u4 = { uuid: 'u4', status: 'finished', file_path: v4 };
  sb.enqueue('u4');
  delete rows.u4; // DELETE /api/videos/:uuid arrived
  await sleep(2500);
  assert.ok(!existsSync(storyboardPath(v4)));
  ok('a video deleted mid-generation leaves no orphan .sbb');

  // ---- backfill ----
  rmSync(storyboardPath(v1));
  const sb2 = createStoryboards({ db: fakeDb({ u1: rows.u1 }), config: cfg });
  sb2.backfill();
  await waitFor(() => existsSync(storyboardPath(v1)));
  checkSbb(storyboardPath(v1), { seconds: 25 });
  ok('backfill creates missing storyboards for already-finished videos');

  // ---- disabled ----
  rmSync(storyboardPath(v1));
  const sb3 = createStoryboards({ db: fakeDb({ u1: rows.u1 }), config: { storyboard: { enabled: false, ffmpeg: 'ffmpeg' } } });
  sb3.enqueue('u1'); sb3.backfill();
  await sleep(1500);
  assert.ok(!existsSync(storyboardPath(v1)));
  ok('STORYBOARD=0 disables generation');

  // ---- end to end through the HTTP API ----
  const GW = 38941; const MOCK = 38942;
  const gw = `http://127.0.0.1:${GW}`;
  const dl = join(tmp, 'downloads');
  mock = await startMock({ downloadDir: dl, port: MOCK, makeFile: (p) => makeVideo(p, 25) });
  child = spawn(process.execPath, ['--no-warnings', 'src/index.js'], {
    cwd: root,
    env: { ...process.env, ENV_FILE: '/nonexistent', PORT: String(GW), HOST: '127.0.0.1', DOWNLOAD_PATH: dl,
      DB_PATH: join(tmp, 'gw.db'), YTDLP_UI: 'ytptube', YTPTUBE_URL: `http://127.0.0.1:${MOCK}`, POLL_INTERVAL_MS: '300' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${gw}/api/health`)).ok) break; } catch { /* not up */ } await sleep(100); }

  let r = await fetch(`${gw}/api/download`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }) });
  const { uuid } = await r.json();
  let v;
  for (let i = 0; i < 300; i++) { v = await (await fetch(`${gw}/api/videos/${uuid}`)).json(); if (v.links.storyboard) break; await sleep(200); }
  assert.equal(v.status, 'finished');
  assert.equal(v.links.storyboard, `/api/videos/${uuid}/storyboard`);
  ok('GET /api/videos/:uuid shows links.storyboard once the background job is done');

  r = await fetch(gw + v.links.storyboard);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  const served = Buffer.from(await r.arrayBuffer());
  const onDisk = readFileSync(storyboardPath(join(dl, 'mockchan', readdirSync(join(dl, 'mockchan')).find((f) => f.endsWith('.mp4')))));
  assert.ok(served.equals(onDisk));
  r = await fetch(gw + v.links.storyboard, { headers: { range: 'bytes=0-7' } });
  assert.equal(r.status, 206);
  assert.deepEqual([...Buffer.from(await r.arrayBuffer())], [0x53, 0x54, 0x4f, 0x52, 0x59, 0x73, 0x62, 0x1a]);
  ok('GET /api/videos/:uuid/storyboard serves the .sbb with Range support');

  r = await fetch(`${gw}/api/videos/${uuid}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.deepEqual(readdirSync(join(dl)).filter((f) => f !== 'mockchan'), []);
  assert.ok(!existsSync(join(dl, 'mockchan')), 'video, .sbb and the emptied folder are gone');
  assert.equal((await fetch(`${gw}/api/videos/${uuid}/storyboard`)).status, 404);
  ok('DELETE also removes the .sbb');

  console.log('storyboard: all checks passed');
  await cleanup(0);
} catch (err) {
  console.error(err);
  await cleanup(1);
}
