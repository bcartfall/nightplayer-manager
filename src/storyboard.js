import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rename, rm, open, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { log } from './log.js';

/**
 * Storyboard (.sbb) files: small preview images spread evenly over a video, packed into big
 * JPEG contact sheets and stored in one binary file next to the video.
 *
 * Number of small images: one per second, but never more than 1920 per video, so the interval is
 * max(1 s, duration / 1920):  1 min -> 60 images (1 s apart), 32 min -> 1920 (1 s), 8 h -> 1920 (15 s).
 *
 * Layout (all integers little-endian):
 *   0   8   magic   53 54 4F 52 59 73 62 1A  ("STORYsb\x1a")
 *   8   4   version (0)
 *   12  4   image count (number of BIG sheets)
 *   16  4   width  of one small image
 *   20  4   height of one small image
 *   24  8   fps of the small images (double; 1 / seconds between images, e.g. 1 or 0.0667)
 *   32  4   rows    per BIG sheet
 *   36  4   columns per BIG sheet
 *   40  24  reserved (zeros)
 *   64  20 * count   index entries: u32 index, u32 offset, u32 size, f64 duration (s)
 *   ..  20           terminator:    u32 0xFFFFFFFF, u32 end offset, u32 0, f64 0
 *   ..  JPEG data of each BIG sheet, back to back
 */
export const SBB = Object.freeze({
  width: 320,
  height: 180,
  rows: 10,
  columns: 10,
  maxImages: 1920, // per video
  minIntervalSec: 1, // never more than one small image per second
  extension: '.sbb',
});

const MAGIC = Buffer.from([0x53, 0x54, 0x4f, 0x52, 0x59, 0x73, 0x62, 0x1a]);
const HEADER_SIZE = 64;
const INDEX_ENTRY_SIZE = 20;

/** `/dl/Some Video [id].mp4` -> `/dl/Some Video [id].sbb` */
export function storyboardPath(videoPath) {
  const ext = extname(videoPath);
  return (ext ? videoPath.slice(0, -ext.length) : videoPath) + SBB.extension;
}

/**
 * How a video of `durationSec` seconds is sampled: one image per second, at most `maxImages` in total.
 * @returns {{interval: number, fps: number, frames: number} | null}  null if the duration is unusable
 */
export function storyboardPlan(durationSec) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  const interval = Math.max(SBB.minIntervalSec, durationSec / SBB.maxImages);
  const frames = Math.min(SBB.maxImages, Math.max(1, Math.ceil(durationSec / interval - 1e-9)));
  return { interval, fps: 1 / interval, frames };
}

/** True when a finished video has its storyboard on disk. */
export function hasStoryboard(videoPath) {
  return !!videoPath && existsSync(storyboardPath(videoPath));
}

/**
 * Write an .sbb file.
 * @param {string} outPath
 * @param {{path: string, duration: number}[]} sheets  JPEG files + seconds of video each covers
 */
export async function writeSbb(outPath, sheets, { width = SBB.width, height = SBB.height, rows = SBB.rows, columns = SBB.columns, fps } = {}) {
  if (!(fps > 0)) throw new Error('writeSbb needs fps > 0');
  const count = sheets.length;

  const header = Buffer.alloc(HEADER_SIZE); // zero-filled, so the reserved bytes are already 0
  MAGIC.copy(header, 0);
  header.writeUInt32LE(0, 8); // version
  header.writeUInt32LE(count, 12);
  header.writeUInt32LE(width, 16);
  header.writeUInt32LE(height, 20);
  header.writeDoubleLE(fps, 24);
  header.writeUInt32LE(rows, 32);
  header.writeUInt32LE(columns, 36);

  const sizes = [];
  for (const s of sheets) sizes.push((await stat(s.path)).size);

  const index = Buffer.alloc(INDEX_ENTRY_SIZE * (count + 1));
  let offset = HEADER_SIZE + INDEX_ENTRY_SIZE * count + INDEX_ENTRY_SIZE; // start of image data
  sheets.forEach((s, i) => {
    const at = i * INDEX_ENTRY_SIZE;
    index.writeUInt32LE(i, at);
    index.writeUInt32LE(offset, at + 4);
    index.writeUInt32LE(sizes[i], at + 8);
    index.writeDoubleLE(s.duration, at + 12);
    offset += sizes[i];
  });
  const end = count * INDEX_ENTRY_SIZE;
  index.writeUInt32LE(0xffffffff, end);
  index.writeUInt32LE(offset, end + 4);
  index.writeUInt32LE(0, end + 8);
  index.writeDoubleLE(0, end + 12);

  const fh = await open(outPath, 'w');
  try {
    await fh.write(header);
    await fh.write(index);
    for (const s of sheets) await fh.write(await readFile(s.path));
  } finally {
    await fh.close();
  }
}

/**
 * Background storyboard generator. Jobs run one at a time (ffmpeg is heavy),
 * never block the API, and never throw: a failure is logged and the video
 * simply has no storyboard (`links.storyboard` stays null).
 */
export function createStoryboards({ db, config }) {
  const queue = [];
  const queued = new Set(); // uuids waiting or running
  let running = false;
  let child = null;
  let stopped = false;

  /** Run a program to completion; resolves with its stdout, rejects with its stderr tail on failure. */
  function run(bin, args, envVar) {
    return new Promise((resolve, reject) => {
      const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      child = p;
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => { out = (out + d).slice(-10_000); });
      p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
      p.on('error', (e) => reject(e.code === 'ENOENT'
        ? new Error(`${bin} was not found; install it or set ${envVar}`)
        : e));
      p.on('close', (code) => {
        child = null;
        if (code === 0) resolve(out);
        else reject(new Error(`${bin} exited with ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
      });
    });
  }
  const ffmpeg = (args) => run(config.storyboard.ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', ...args], 'FFMPEG_BIN');

  /** Video length in seconds, or null if it cannot be determined. */
  async function probeDuration(videoPath) {
    try {
      const out = await run(config.storyboard.ffprobe,
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath], 'FFPROBE_BIN');
      const d = Number.parseFloat(out);
      return Number.isFinite(d) && d > 0 ? d : null;
    } catch (err) {
      log.warn(`could not read the duration of ${videoPath}: ${err.message}`);
      return null;
    }
  }

  async function generate(videoPath, uuid) {
    const outPath = storyboardPath(videoPath);
    const tmp = await mkdtemp(join(tmpdir(), 'sbb-'));
    try {
      // 1. Decide the sampling from the video length: 1 image/s, at most SBB.maxImages in total.
      let plan = storyboardPlan(await probeDuration(videoPath));
      if (!plan) {
        log.warn(`unknown duration for ${uuid}; sampling one image every 10 s`);
        plan = { interval: 10, fps: 0.1, frames: SBB.maxImages };
      }
      log.info(`creating storyboard for ${uuid}: videoPath=${videoPath}, plan=${JSON.stringify(plan)}`);

      // 2. Extract the small images. (-r rather than the fps filter: the filter emits no frame at
      //    all for a clip shorter than the interval. -frames:v drops the duplicated tail frames
      //    that -r can add, so the limit is never exceeded.)
      await ffmpeg([
        '-i', videoPath, '-threads', '2', '-an', '-sn', '-dn',
        '-r', String(plan.fps), '-s', `${SBB.width}x${SBB.height}`, '-frames:v', String(plan.frames),
        join(tmp, 'f%08d.png'),
      ]);
      const frames = (await readdir(tmp)).filter((f) => f.startsWith('f') && f.endsWith('.png'));
      if (frames.length === 0) throw new Error('ffmpeg produced no frames (no video stream?)');

      // 3. Pack them into BIG rows x columns sheets; a partial last sheet is padded with black.
      const perSheet = SBB.rows * SBB.columns;
      const sheets = [];
      for (let first = 0; first < frames.length; first += perSheet) {
        const inSheet = Math.min(perSheet, frames.length - first);
        const sheetPath = join(tmp, `sheet-${sheets.length}.jpg`);
        await ffmpeg([
          '-framerate', '1', '-start_number', String(first + 1), '-i', join(tmp, 'f%08d.png'),
          '-frames:v', '1', '-vf', `tile=${SBB.columns}x${SBB.rows}`, '-q:v', '3', '-update', '1', sheetPath,
        ]);
        sheets.push({ path: sheetPath, duration: inSheet * plan.interval });
      }

      // 4. Build the .sbb next to the video; rename so a half-written file is never served.
      const partial = outPath + '.part';
      await writeSbb(partial, sheets, { fps: plan.fps });

      // The video may have been deleted while we were working; don't leave an orphan behind.
      const cur = db.getByUuid(uuid);
      if (!cur || cur.file_path !== videoPath || !existsSync(videoPath)) {
        await rm(partial, { force: true });
        log.info(`storyboard for ${uuid} discarded: video was deleted meanwhile`);
        return;
      }
      await rename(partial, outPath);
      log.info(`storyboard created for ${uuid}: ${sheets.length} sheet(s), ${frames.length} frame(s), 1 every ${plan.interval.toFixed(2)} s`);
    } catch (err) {
      await rm(outPath + '.part', { force: true }).catch(() => { });
      throw err;
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => { });
    }
  }

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length && !stopped) {
        const { uuid } = queue.shift();
        try {
          const row = db.getByUuid(uuid);
          if (row?.status === 'finished' && row.file_path) await generate(row.file_path, uuid);
        } catch (err) {
          log.warn(`storyboard failed for ${uuid}: ${err.message}`);
        } finally {
          queued.delete(uuid);
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    /** Queue a finished video; returns immediately. Always regenerates (overwrites an old file). */
    enqueue(uuid) {
      if (!config.storyboard.enabled || stopped || queued.has(uuid)) return;
      queued.add(uuid);
      queue.push({ uuid });
      setImmediate(drain);
    },
    /** Queue every finished video that has no storyboard yet (e.g. downloaded before this feature, or interrupted by a restart). */
    backfill() {
      if (!config.storyboard.enabled) return;
      for (const row of db.listFinished()) {
        if (row.file_path && existsSync(row.file_path) && !hasStoryboard(row.file_path)) this.enqueue(row.uuid);
      }
    },
    stop() {
      stopped = true;
      queue.length = 0;
      child?.kill('SIGKILL');
    },
  };
}