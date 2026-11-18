export function formatBytes(n, digits = 1) {
  if (n == null || !Number.isFinite(n)) return '–';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : digits)} ${units[i]}`;
}

/** 3725 -> "1:02:05", 75 -> "1:15" */
export function formatDuration(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '–';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

/** Same, with tenths — for positions inside a video. */
export function formatPosition(sec) {
  if (sec == null || !Number.isFinite(sec)) return '–';
  const base = formatDuration(Math.floor(sec));
  const tenth = Math.floor((sec - Math.floor(sec)) * 10);
  return tenth ? `${base}.${tenth}` : base;
}

export function formatSpeed(bytesPerSec) {
  return bytesPerSec == null ? null : `${formatBytes(bytesPerSec)}/s`;
}

export function formatEta(sec) {
  if (sec == null || !Number.isFinite(sec)) return null;
  const s = Math.round(sec);
  if (s < 60) return `${s}s left`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s left`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m left`;
}

export const sourceLabel = (s) => ({ youtube: 'YouTube', twitch: 'Twitch' })[s] || s;

export function formatDate(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
