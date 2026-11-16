import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isInside } from './paths.js';
import { log } from './log.js';
import { TERMINAL, view } from './view.js';

const MAX_MISSES = 5;

/**
 * Polls the yt-dlp UI plugin for every active download, mirrors progress into
 * SQLite and publishes it to SSE listeners.
 */
export function createTracker({ db, plugin, hub, config }) {
  const misses = new Map();
  let timer = null;
  let busy = false;

  async function locate(candidates) {
    for (const rel of candidates ?? []) {
      const abs = resolve(config.downloadPath, rel);
      if (!isInside(config.downloadPath, abs)) continue;
      try {
        const st = await stat(abs);
        if (st.isFile()) return { path: abs, size: st.size };
      } catch { /* try next candidate */ }
    }
    return null;
  }

  /** Apply a patch, and publish only if something actually changed. */
  function applyPatch(uuid, patch) {
    const row = db.getByUuid(uuid);
    if (!row) return null;
    const changed = Object.entries(patch).some(([k, v]) => v !== undefined && row[k] !== v);
    if (!changed) return row;
    const next = db.update(uuid, patch);
    const payload = view(next);
    hub.emit(uuid, 'progress', payload);
    if (TERMINAL.has(next.status)) hub.emit(uuid, 'done', payload);
    return next;
  }

  async function refresh(row) {
    let st;
    try {
      st = await plugin.status(row.external_id);
    } catch (err) {
      log.warn(`${plugin.name}: status check failed for ${row.uuid}: ${err.message}`);
      return; // transient (UI restarting, network); try again next tick
    }

    if (!st) {
      const n = (misses.get(row.uuid) ?? 0) + 1;
      misses.set(row.uuid, n);
      if (n >= MAX_MISSES) {
        misses.delete(row.uuid);
        applyPatch(row.uuid, { status: 'error', error: `Download is no longer known to ${plugin.name}` });
      }
      return;
    }
    misses.delete(row.uuid);

    const patch = {};
    if (st.title && st.title !== row.title) patch.title = st.title;
    if (st.description && st.description !== row.description) patch.description = st.description;

    if (st.state === 'finished') {
      const found = await locate(st.fileCandidates);
      if (found) {
        Object.assign(patch, {
          status: 'finished', percent: 100, speed: null, eta: null, error: null,
          file_path: found.path, file_size: found.size,
        });
      } else {
        Object.assign(patch, {
          status: 'error', speed: null, eta: null,
          error: `${plugin.name} reports the download finished, but the file was not found under ` +
            `DOWNLOAD_PATH (${config.downloadPath}). Check that this matches the folder it writes to.`,
        });
      }
    } else {
      patch.status = st.state;
      if (st.percent != null) patch.percent = Math.min(100, Math.max(0, st.percent));
      patch.speed = st.state === 'downloading' ? st.speed : null;
      patch.eta = st.state === 'downloading' ? st.eta : null;
      patch.error = st.state === 'error' ? st.error : null;
    }
    applyPatch(row.uuid, patch);
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      for (const row of db.listActive()) await refresh(row);
    } catch (err) {
      log.error('tracker tick failed:', err);
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      timer = setInterval(tick, config.pollIntervalMs);
      tick(); // resume anything that was in flight before a restart
    },
    stop() { clearInterval(timer); },
    kick() { setImmediate(tick); },
    applyPatch,
    locate,
  };
}
