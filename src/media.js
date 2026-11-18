import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { log } from './log.js';
import { view } from './view.js';

const MAX_THUMB_BYTES = 2 * 1024 * 1024;
const SIDECAR_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

function run(bin, args, { binary = false, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err = (err + d).slice(-1000); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${bin} exited with ${code}: ${err.trim().split('\n').pop()}`));
      const buf = Buffer.concat(out);
      resolve(binary ? buf : buf.toString('utf8'));
    });
  });
}

/**
 * Keeps each video's thumbnail (stored in the DB) and duration filled in:
 *  - while downloading: from the thumbnail URL / duration the yt-dlp UI reports;
 *  - once finished: from an image next to the file, or a frame grabbed with ffmpeg,
 *    and the duration from ffprobe. Never throws; a miss just leaves the field empty.
 */
export function createMedia({ db, hub, config }) {
  const pending = new Set();

  function publish(uuid) {
    const row = db.getByUuid(uuid);
    if (row) hub.emit(uuid, 'progress', view(row));
  }

  /** Download `url` and store it as the video's thumbnail (only if it has none yet). */
  async function fromUrl(uuid, url) {
    if (!url || !/^https?:\/\//i.test(url)) return;
    const row = db.getByUuid(uuid);
    if (!row || row.has_thumbnail || pending.has(uuid)) return;
    pending.add(uuid);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!type.startsWith('image/')) throw new Error(`not an image (${type || 'no content-type'})`);
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length === 0 || data.length > MAX_THUMB_BYTES) throw new Error(`unusable size (${data.length} bytes)`);
      if (db.getByUuid(uuid)) { db.setThumbnail(uuid, data, type); publish(uuid); }
    } catch (err) {
      log.warn(`thumbnail for ${uuid} could not be fetched: ${err.message}`);
    } finally {
      pending.delete(uuid);
    }
  }

  async function probeDuration(path) {
    try {
      const out = await run(config.storyboard.ffprobe,
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path]);
      const d = Number.parseFloat(out);
      return Number.isFinite(d) && d > 0 ? d : null;
    } catch (err) {
      log.warn(`could not read the duration of ${path}: ${err.message}`);
      return null;
    }
  }

  async function grabFrame(path, duration) {
    const at = duration ? Math.min(duration * 0.1, 30) : 1;
    return run(config.storyboard.ffmpeg, [
      '-nostdin', '-loglevel', 'error', '-ss', String(at), '-i', path,
      '-frames:v', '1', '-vf', 'scale=640:-2', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '4', '-',
    ], { binary: true });
  }

  /** Fill what is still missing for a finished video. */
  async function fillFromFile(uuid) {
    let row = db.getByUuid(uuid);
    if (!row || row.status !== 'finished' || !row.file_path || !existsSync(row.file_path)) return;

    if (!row.duration) {
      const d = await probeDuration(row.file_path);
      if (d && db.getByUuid(uuid)) db.update(uuid, { duration: d });
    }
    if (!row.has_thumbnail) {
      const stem = row.file_path.slice(0, row.file_path.length - extname(row.file_path).length);
      let found = null;
      for (const [ext, type] of Object.entries(SIDECAR_TYPES)) {
        const file = stem + ext;
        if (existsSync(file)) {
          const data = await readFile(file).catch(() => null);
          if (data && data.length && data.length <= MAX_THUMB_BYTES) { found = { data, type }; break; }
        }
      }
      if (!found && config.storyboard.enabled !== false) {
        try {
          const data = await grabFrame(row.file_path, db.getByUuid(uuid)?.duration);
          if (data.length) found = { data, type: 'image/jpeg' };
        } catch (err) {
          log.warn(`could not grab a frame from ${row.file_path}: ${err.message}`);
        }
      }
      if (found && db.getByUuid(uuid)) db.setThumbnail(uuid, found.data, found.type);
    }
    publish(uuid);
  }

  return {
    fromUrl,
    fillFromFile,
    /** Finished videos from before thumbnails/durations existed. */
    backfill() {
      (async () => {
        for (const row of db.listFinished()) {
          if (!row.duration || !row.has_thumbnail) await fillFromFile(row.uuid);
        }
      })().catch((err) => log.warn(`media backfill failed: ${err.message}`));
    },
  };
}
