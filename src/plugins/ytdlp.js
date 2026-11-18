import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { log } from '../log.js';
import { isInside } from '../paths.js';

/**
 * Self-hosted plugin: runs the `yt-dlp` binary that is installed in the same
 * container as the gateway. No external web UI is needed.
 *
 * It implements the standard plugin contract (see ./index.js):
 *   add(url)                      spawn yt-dlp (queued if YTDLP_CONCURRENCY is reached)
 *   status(id)                    live progress parsed from yt-dlp's --progress-template
 *   remove(id, { removeFile })    kill the process, wipe partial files, forget the job
 *   info(url)                     title/description via `yt-dlp --dump-single-json`
 *
 * Jobs are mirrored to JSON files in YTDLP_STATE_DIR so that a gateway restart
 * resumes unfinished downloads (yt-dlp continues from its .part files).
 *
 * Layout on disk:
 *   <DOWNLOAD_PATH>/<output template>        finished file (+ .info.json sidecar)
 *   <DOWNLOAD_PATH>/.ytdlp-tmp/<job id>/     partial files, removed when the job ends
 */
export default function createYtdlp(config) {
  const cfg = config.ytdlp;
  const downloadRoot = config.downloadPath;
  const tmpRoot = join(downloadRoot, '.ytdlp-tmp');
  const cacheDir = join(cfg.stateDir, 'cache');
  mkdirSync(cfg.stateDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  /** @type {Map<string, any>} */
  const jobs = new Map();
  const pending = [];
  let running = 0;

  const toNum = (v) => {
    if (v == null || v === '' || v === 'NA' || v === 'None') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  // ---------------------------------------------------------------- persistence
  const stateFile = (id) => join(cfg.stateDir, `${id}.json`);

  function persist(job) {
    const { id, url, state, title, description, error, file, createdAt } = job;
    const tmp = stateFile(id) + '.tmp';
    try {
      writeFileSync(tmp, JSON.stringify({ id, url, state, title, description, error, file, createdAt }));
      renameSync(tmp, stateFile(id));
    } catch (err) {
      log.warn(`ytdlp: could not save job ${id}: ${err.message}`);
    }
  }

  function newJob(fields) {
    return {
      id: randomUUID(), url: '', state: 'queued', percent: 0, speed: null, eta: null,
      title: null, description: null, error: null, file: null,
      createdAt: Date.now(), proc: null, cancelled: false,
      streamsTotal: 1, streamsDone: 0, stderrTail: [], ...fields,
    };
  }

  // Reload jobs from a previous run; unfinished ones are resumed.
  const WEEK = 7 * 24 * 3600 * 1000;
  for (const f of readdirSync(cfg.stateDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const saved = JSON.parse(readFileSync(join(cfg.stateDir, f), 'utf8'));
      const terminal = ['finished', 'error', 'cancelled'].includes(saved.state);
      if (terminal && Date.now() - (saved.createdAt ?? 0) > WEEK) {
        rmSync(join(cfg.stateDir, f), { force: true });
        continue;
      }
      const job = newJob({ ...saved, state: terminal ? saved.state : 'queued', percent: saved.state === 'finished' ? 100 : 0 });
      jobs.set(job.id, job);
      if (!terminal) {
        log.info(`ytdlp: resuming ${job.id} (${job.url})`);
        pending.push(job);
      }
    } catch (err) {
      log.warn(`ytdlp: ignoring unreadable state file ${f}: ${err.message}`);
    }
  }
  queueMicrotask(pump);

  // ---------------------------------------------------------------- running yt-dlp
  const commonArgs = () => {
    const a = ['--encoding', 'utf-8', '--no-playlist', '--no-colors', '--ignore-config', '--retries', '10', '--fragment-retries', '10',
      '--socket-timeout', '30', '--windows-filenames'];
    if (cfg.jsRuntimes) a.push('--js-runtimes', cfg.jsRuntimes);
    if (cfg.cookies) a.push('--cookies', cfg.cookies);
    if (cfg.rateLimit) a.push('--limit-rate', cfg.rateLimit);
    a.push(...cfg.extraArgs);
    return a;
  };
  const childEnv = () => ({ ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', XDG_CACHE_HOME: cacheDir, HOME: process.env.HOME || cfg.stateDir });

  function buildArgs(job) {
    return [
      ...commonArgs(),
      '--newline', '--progress',
      '-f', cfg.format, '-S', cfg.sort, '--merge-output-format', cfg.mergeFormat,
      '-o', cfg.outputTemplate,
      '--paths', `home:${downloadRoot}`,
      '--paths', `temp:${join(tmpRoot, job.id)}`,
      '--progress-template',
      'download:__P__%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|' +
        '%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
      '--print', 'before_dl:__META__%(.{id,title,description,requested_formats})j',
      '--print', 'after_move:__FILE__%(filepath)s',
      // stdout encoding is unreliable on Windows; this file is always written as UTF-8
      '--print-to-file', 'after_move:%(filepath)s', join(tmpRoot, job.id, 'filepath.txt'),
      '--', job.url,
    ];
  }

  function pump() {
    while (running < cfg.concurrency && pending.length) {
      const job = pending.shift();
      if (job.cancelled || jobs.get(job.id) !== job) continue;
      running++;
      start(job);
    }
  }

  function finish(job, patch) {
    Object.assign(job, patch, { speed: null, eta: null, proc: null });
    persist(job);
    rmSync(join(tmpRoot, job.id), { recursive: true, force: true });
    running = Math.max(0, running - 1);
    pump();
  }

  function onLine(job, line) {
    if (line.startsWith('__P__')) {
      const [status, done, total, estimate, speed, eta] = line.slice(5).split('|');
      if (status === 'finished') {
        job.streamsDone++;
        return;
      }
      const size = toNum(total) ?? toNum(estimate);
      const frac = size ? Math.min(1, (toNum(done) ?? 0) / size) : 0;
      // A video+audio download is two sequential streams; spread 0-99% across them.
      const overall = ((job.streamsDone + frac) / job.streamsTotal) * 99;
      job.percent = Math.max(job.percent, Math.min(99, overall));
      job.speed = toNum(speed);
      job.eta = toNum(eta);
    } else if (line.startsWith('__META__')) {
      try {
        const meta = JSON.parse(line.slice(8));
        if (meta.id) job.videoId = String(meta.id);
        if (meta.title) job.title = meta.title;
        if (meta.description) job.description = meta.description;
        job.streamsTotal = Array.isArray(meta.requested_formats) && meta.requested_formats.length
          ? meta.requested_formats.length : 1;
        persist(job);
      } catch { /* metadata is optional */ }
    } else if (line.startsWith('__FILE__')) {
      job.file = line.slice(8).trim();
    }
  }

  function lineReader(stream, cb) {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line) cb(line);
      }
    });
    stream.on('end', () => { if (buf.trim()) cb(buf.trim()); });
  }

  // Where did yt-dlp put the file? Trust its own report if the file exists, else search by video id.
  function resolveOutput(job) {
    const reported = [];
    try {
      const txt = readFileSync(join(tmpRoot, job.id, 'filepath.txt'), 'utf8').split(/\r?\n/).filter(Boolean).at(-1);
      if (txt) reported.push(txt);
    } catch { /* fall back to stdout */ }
    if (job.file) reported.push(job.file);

    for (const f of reported) {
      const abs = resolve(f);
      if (existsSync(abs)) {
        return isInside(downloadRoot, abs)
          ? { file: abs }
          : { error: `yt-dlp wrote ${abs}, which is outside DOWNLOAD_PATH (${downloadRoot})` };
      }
    }
    if (job.videoId) {
      const tag = `[${job.videoId}]`;
      let best = null;
      try {
        for (const rel of readdirSync(downloadRoot, { recursive: true })) {
          const name = String(rel);
          if (name.startsWith('.ytdlp-tmp') || !name.includes(tag) || /\.(part|ytdl|json)$/i.test(name)) continue;
          const abs = join(downloadRoot, name);
          const st = statSync(abs);
          if (st.isFile() && (!best || st.mtimeMs > best.mtime)) best = { abs, mtime: st.mtimeMs };
        }
      } catch { /* ignore */ }
      if (best) return { file: best.abs };
    }
    return {
      error: `yt-dlp finished but the output file was not found. yt-dlp reported: ${JSON.stringify(reported)}; ` +
        `looked under ${downloadRoot}`,
    };
  }

  function start(job) {
    Object.assign(job, { state: 'downloading', percent: 0, speed: null, eta: null, error: null, streamsDone: 0, streamsTotal: 1 });
    persist(job);

    let proc;
    try {
      mkdirSync(join(tmpRoot, job.id), { recursive: true });
      proc = spawn(cfg.bin, buildArgs(job), { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return finish(job, { state: 'error', error: `Could not start download: ${err.message}` });
    }
    job.proc = proc;
    let settled = false;

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      finish(job, {
        state: 'error',
        error: err.code === 'ENOENT' ? `yt-dlp was not found (YTDLP_BIN=${cfg.bin})` : `yt-dlp failed to start: ${err.message}`,
      });
    });

    lineReader(proc.stdout, (line) => onLine(job, line));
    lineReader(proc.stderr, (line) => {
      job.stderrTail.push(line);
      if (job.stderrTail.length > 20) job.stderrTail.shift();
    });

    proc.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (job.cancelled) return; // remove() already cleaned up
      if (code === 0) {
        const found = resolveOutput(job);
        if (found.error) return finish(job, { state: 'error', error: found.error });
        return finish(job, { state: 'finished', percent: 100, file: found.file });
      }
      const errLine = [...job.stderrTail].reverse().find((l) => l.startsWith('ERROR:'));
      const msg = (errLine ?? job.stderrTail.at(-1) ?? '').replace(/^ERROR:\s*/, '').replace(/\[[\w:.-]+\]\s*/, '');
      finish(job, {
        state: 'error',
        error: msg || (signal ? `yt-dlp was killed (${signal})` : `yt-dlp exited with code ${code}`),
      });
    });
  }

  // Don't leave orphaned yt-dlp processes behind when the gateway exits.
  process.on('exit', () => {
    for (const j of jobs.values()) j.proc?.kill('SIGTERM');
  });

  // ---------------------------------------------------------------- plugin API
  return {
    name: 'ytdlp',

    async add(url) {
      const job = newJob({ url });
      jobs.set(job.id, job);
      persist(job);
      pending.push(job);
      log.info(`ytdlp: added job ${job.id} (${job.url})`);
      pump();
      return { externalId: job.id };
    },

    async status(externalId) {
      const job = jobs.get(externalId);
      if (!job) return null;

      let fileCandidates = [];
      let fileSize = null;
      if (job.state === 'finished' && job.file) {
        const abs = resolve(job.file);
        const rel = relative(downloadRoot, abs);
        if (!rel.startsWith('..') && !isAbsolute(rel)) fileCandidates = [rel];
        try { fileSize = statSync(abs).size; } catch { /* tracker reports a missing file */ }
      }
      return {
        state: job.state,
        percent: job.state === 'finished' ? 100 : job.percent,
        speed: job.speed,
        eta: job.eta,
        title: job.title,
        description: job.description,
        error: job.error,
        fileCandidates,
        fileSize,
      };
    },

    async remove(externalId, { removeFile = true } = {}) {
      const warnings = [];
      const job = jobs.get(externalId);
      if (!job) return { warnings };

      jobs.delete(externalId);
      job.cancelled = true;
      const pi = pending.indexOf(job);
      if (pi !== -1) pending.splice(pi, 1);

      if (job.proc) {
        const proc = job.proc;
        await new Promise((done) => {
          const force = setTimeout(() => proc.kill('SIGKILL'), 5000);
          proc.once('close', () => { clearTimeout(force); done(); });
          proc.kill('SIGTERM');
        });
        running = Math.max(0, running - 1);
        pump();
      }

      rmSync(join(tmpRoot, job.id), { recursive: true, force: true });
      rmSync(stateFile(job.id), { force: true });

      if (removeFile && job.file && isInside(downloadRoot, resolve(job.file))) {
        const file = resolve(job.file);
        for (const f of [file, file.replace(/\.[^./\\]+$/, '') + '.info.json']) {
          try { rmSync(f, { force: true }); } catch (err) { warnings.push(`could not delete ${f}: ${err.message}`); }
        }
      }
      return { warnings };
    },

    async info(url) {
      const out = await new Promise((resolveP, reject) => {
        const proc = spawn(cfg.bin, [...commonArgs(), '--skip-download', '--dump-single-json', '--', url],
          { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('yt-dlp info timed out')); }, cfg.infoTimeoutMs);
        proc.stdout.on('data', (d) => { stdout += d; });
        proc.stderr.on('data', (d) => { stderr += d; });
        proc.on('error', (err) => { clearTimeout(timer); reject(err); });
        proc.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolveP(stdout);
          else reject(new Error(stderr.trim().split('\n').pop() || `yt-dlp exited with code ${code}`));
        });
      });
      const d = JSON.parse(out);
      return { title: d.title ?? null, description: d.description ?? null };
    },
  };
}
