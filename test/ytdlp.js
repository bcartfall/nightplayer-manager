import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import createYtdlp from '../src/plugins/ytdlp.js';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'ytdlp-plugin-'));
const downloadPath = join(tmp, 'downloads');
const stateDir = join(tmp, 'state');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = (over = {}) => createYtdlp({
  downloadPath,
  ytdlp: {
    bin: join(here, 'fake-ytdlp.js'), stateDir, format: 'bv*+ba/b', sort: 'res:1080', mergeFormat: 'mp4',
    outputTemplate: '%(title)s [%(id)s].%(ext)s', concurrency: 1, jsRuntimes: '', cookies: '', rateLimit: '',
    extraArgs: [], infoTimeoutMs: 5000, ...over,
  },
});
async function until(plugin, id, pred, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const s = await plugin.status(id);
    if (pred(s)) return s;
    assert.ok(Date.now() - t0 < ms, `timed out, last status: ${JSON.stringify(s)}`);
    await sleep(40);
  }
}
let n = 0;
const ok = (name) => console.log(`  ok  ytdlp plugin: ${name}`);

try {
  const p = mk();

  // success, progress is monotonic and never reaches 100 before the file exists
  const a = await p.add('https://example.test/ok');
  const seen = [];
  const fin = await until(p, a.externalId, (s) => { seen.push(s.percent); return s.state === 'finished'; });
  assert.deepEqual(seen, [...seen].sort((x, y) => x - y));
  assert.ok(seen.slice(0, -1).every((v) => v < 100));
  assert.equal(fin.title, 'Fake Title');
  assert.equal(fin.description, 'Line 1\nLine 2');
  assert.deepEqual(fin.fileCandidates, ['Fake Title [abc].mp4']);
  assert.equal(fin.fileSize, 2048);
  assert.deepEqual(readdirSync(join(downloadPath, '.ytdlp-tmp')), [], 'temp dir is cleaned up');
  ok('download finishes with title, description, relative file path and size'); n++;

  // failure
  const f = await p.add('https://example.test/fail');
  const bad = await until(p, f.externalId, (s) => s.state === 'error');
  assert.equal(bad.error, 'abc: Video unavailable');
  ok('yt-dlp failure becomes an error state with its message'); n++;

  // info()
  assert.deepEqual(await p.info('https://example.test/ok'), { title: 'Fake Title', description: 'Fake description' });
  ok('info() returns title and description'); n++;

  // concurrency 1: the second job waits in the queue, cancelling the first starts it
  const s1 = await p.add('https://example.test/slow');
  const s2 = await p.add('https://example.test/ok');
  await until(p, s1.externalId, (s) => s.state === 'downloading');
  assert.equal((await p.status(s2.externalId)).state, 'queued');
  const res = await p.remove(s1.externalId, { removeFile: true });
  assert.deepEqual(res.warnings, []);
  assert.equal(await p.status(s1.externalId), null);
  await until(p, s2.externalId, (s) => s.state === 'finished');
  ok('concurrency limit queues jobs; remove() kills a running job and frees its slot'); n++;

  // remove deletes the finished file
  const file = join(downloadPath, 'Fake Title [abc].mp4');
  assert.ok(existsSync(file));
  await p.remove(s2.externalId, { removeFile: true });
  assert.ok(!existsSync(file));
  assert.ok(!existsSync(join(stateDir, `${s2.externalId}.json`)));
  ok('remove() deletes the file and the job record'); n++;

  // restart: an unfinished job from the previous run is resumed, a finished one is remembered
  const done = await p.add('https://example.test/ok');
  await until(p, done.externalId, (s) => s.state === 'finished');
  writeFileSync(join(stateDir, 'aaaaaaaa-0000-0000-0000-000000000000.json'), JSON.stringify({
    id: 'aaaaaaaa-0000-0000-0000-000000000000', url: 'https://example.test/ok', state: 'downloading', createdAt: Date.now(),
  }));
  const p2 = mk();
  const resumed = await until(p2, 'aaaaaaaa-0000-0000-0000-000000000000', (s) => s.state === 'finished');
  assert.equal(resumed.fileCandidates[0], 'Fake Title [abc].mp4');
  assert.equal((await p2.status(done.externalId)).state, 'finished');
  assert.equal(await p2.status('does-not-exist'), null);
  ok('restart resumes unfinished jobs and remembers finished ones'); n++;

  // missing binary
  const p3 = mk({ bin: '/nonexistent/yt-dlp', stateDir: join(tmp, 'state3') });
  const m = await p3.add('https://example.test/ok');
  assert.match((await until(p3, m.externalId, (s) => s.state === 'error')).error, /yt-dlp was not found/);
  ok('missing binary gives a clear error'); n++;

  console.log(`ytdlp plugin: ${n} checks passed`);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
} catch (err) {
  console.error(err);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}
