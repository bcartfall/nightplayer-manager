import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const UPDATABLE = new Set([
  'title', 'description', 'status', 'percent', 'speed', 'eta', 'error',
  'file_path', 'file_size', 'external_id', 'duration',
]);

// Everything except the thumbnail BLOB, which is only read by getThumbnail().
const COLS = `uuid, source, source_id, url, title, description, status, percent, speed, eta, error,
  file_path, file_size, plugin, external_id, created_at, updated_at, duration,
  (thumbnail IS NOT NULL) AS has_thumbnail`;

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS videos (
      uuid        TEXT PRIMARY KEY,
      source      TEXT NOT NULL,
      source_id   TEXT NOT NULL,
      url         TEXT NOT NULL,
      title       TEXT,
      description TEXT,
      status      TEXT NOT NULL DEFAULT 'queued',
      percent     REAL NOT NULL DEFAULT 0,
      speed       REAL,
      eta         REAL,
      error       TEXT,
      file_path   TEXT,
      file_size   INTEGER,
      plugin      TEXT NOT NULL,
      external_id TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      UNIQUE (source, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_videos_status ON videos (status);
  `);

  // Additive migrations for databases created by earlier versions.
  const have = new Set(db.prepare('PRAGMA table_info(videos)').all().map((c) => c.name));
  for (const [col, type] of [['duration', 'REAL'], ['thumbnail', 'BLOB'], ['thumbnail_type', 'TEXT']]) {
    if (!have.has(col)) db.exec(`ALTER TABLE videos ADD COLUMN ${col} ${type}`);
  }

  const byUuid = db.prepare(`SELECT ${COLS} FROM videos WHERE uuid = ?`);
  const bySource = db.prepare(`SELECT ${COLS} FROM videos WHERE source = ? AND source_id = ?`);
  const active = db.prepare(`SELECT ${COLS} FROM videos WHERE status IN ('queued','downloading') AND external_id IS NOT NULL`);
  const finished = db.prepare(`SELECT ${COLS} FROM videos WHERE status = 'finished' AND file_path IS NOT NULL`);
  const insert = db.prepare(`
    INSERT INTO videos (uuid, source, source_id, url, status, percent, plugin, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)`);
  const all = db.prepare(`SELECT ${COLS} FROM videos ORDER BY created_at DESC LIMIT ?`);
  const thumb = db.prepare('SELECT thumbnail, thumbnail_type FROM videos WHERE uuid = ?');
  const setThumb = db.prepare('UPDATE videos SET thumbnail = ?, thumbnail_type = ?, updated_at = ? WHERE uuid = ?');
  const del = db.prepare('DELETE FROM videos WHERE uuid = ?');

  const get = (stmt, ...args) => stmt.get(...args) ?? null;

  return {
    getByUuid: (uuid) => get(byUuid, uuid),
    getBySource: (source, sourceId) => get(bySource, source, sourceId),
    listActive: () => active.all(),
    listFinished: () => finished.all(),
    listAll: (limit = 1000) => all.all(limit),

    /** @returns {{data: Uint8Array, type: string} | null} */
    getThumbnail(uuid) {
      const r = thumb.get(uuid);
      return r?.thumbnail ? { data: r.thumbnail, type: r.thumbnail_type || 'image/jpeg' } : null;
    },
    setThumbnail(uuid, data, type) {
      setThumb.run(data, type, new Date().toISOString(), uuid);
      return get(byUuid, uuid);
    },

    insert({ uuid, source, sourceId, url, plugin }) {
      const now = new Date().toISOString();
      insert.run(uuid, source, sourceId, url, plugin, now, now);
      return get(byUuid, uuid);
    },

    update(uuid, patch) {
      const entries = Object.entries(patch).filter(([k, v]) => UPDATABLE.has(k) && v !== undefined);
      if (entries.length === 0) return get(byUuid, uuid);
      const sets = entries.map(([k]) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE videos SET ${sets}, updated_at = ? WHERE uuid = ?`)
        .run(...entries.map(([, v]) => v), new Date().toISOString(), uuid);
      return get(byUuid, uuid);
    },

    delete: (uuid) => del.run(uuid),
    close: () => db.close(),
  };
}
