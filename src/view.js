import { hasStoryboard } from './storyboard.js';

export const ACTIVE = new Set(['queued', 'downloading']);
export const TERMINAL = new Set(['finished', 'error', 'cancelled']);

/** Public JSON representation of a DB row. */
export function view(row) {
  const base = `/api/videos/${row.uuid}`;
  return {
    uuid: row.uuid,
    source: row.source,
    sourceId: row.source_id,
    url: row.url,
    title: row.title,
    description: row.description,
    status: row.status, // queued | downloading | finished | error | cancelled
    percent: row.percent,
    speed: row.speed, // bytes/second, null when unknown
    eta: row.eta, // seconds, null when unknown
    error: row.error,
    fileSize: row.file_size,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    links: {
      self: base,
      stream: row.status === 'finished' ? `${base}/stream` : null,
      events: ACTIVE.has(row.status) ? `${base}/events` : null,
      // Generated in the background after the download finishes; null until the .sbb file exists.
      storyboard: row.status === 'finished' && hasStoryboard(row.file_path) ? `${base}/storyboard` : null,
    },
  };
}
