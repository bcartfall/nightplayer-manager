import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const UPDATABLE = new Set([
  'title', 'description', 'status', 'percent', 'speed', 'eta', 'error',
  'file_path', 'file_size', 'external_id',
]);

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

  const byUuid = db.prepare('SELECT * FROM videos WHERE uuid = ?');
  const bySource = db.prepare('SELECT * FROM videos WHERE source = ? AND source_id = ?');
  const active = db.prepare("SELECT * FROM videos WHERE status IN ('queued','downloading') AND external_id IS NOT NULL");
  const insert = db.prepare(`
    INSERT INTO videos (uuid, source, source_id, url, status, percent, plugin, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)`);
  const del = db.prepare('DELETE FROM videos WHERE uuid = ?');

  const get = (stmt, ...args) => stmt.get(...args) ?? null;

  return {
    getByUuid: (uuid) => get(byUuid, uuid),
    getBySource: (source, sourceId) => get(bySource, source, sourceId),
    listActive: () => active.all(),

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
