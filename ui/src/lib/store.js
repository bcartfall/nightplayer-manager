import { computed, reactive } from 'vue';
import { api, url } from './api.js';

/**
 * Single source of truth for the UI.
 *  - GET /api/videos is polled to discover downloads and to reconcile state.
 *  - Each running download also gets a Server-Sent Events stream (links.events) for live progress.
 *    Browsers allow only ~6 HTTP/1.1 connections per origin, so at most MAX_STREAMS are opened;
 *    the rest are covered by the faster poll.
 */
const MAX_STREAMS = 4;

export const videos = reactive({}); // uuid -> view JSON from the API
export const live = reactive({}); // uuid -> true while its event stream is open
export const status = reactive({ loaded: false, offline: false });

const streams = new Map(); // uuid -> EventSource
let timer = null;
let started = false;

const isActive = (v) => v.status === 'queued' || v.status === 'downloading';
const byNewest = (a, b) => (a.createdAt < b.createdAt ? 1 : -1);

export const active = computed(() => Object.values(videos).filter(isActive)
  .sort((a, b) => (a.status === b.status ? byNewest(a, b) : a.status === 'downloading' ? -1 : 1)));
export const failed = computed(() => Object.values(videos).filter((v) => v.status === 'error' || v.status === 'cancelled').sort(byNewest));
export const finished = computed(() => Object.values(videos).filter((v) => v.status === 'finished').sort(byNewest));

function merge(v) {
  const old = videos[v.uuid];
  if (old && old.updatedAt > v.updatedAt) return; // a newer SSE event beat a slower poll
  videos[v.uuid] = v;
}

function drop(uuid) {
  delete videos[uuid];
  closeStream(uuid);
}

function closeStream(uuid) {
  streams.get(uuid)?.close();
  streams.delete(uuid);
  delete live[uuid];
}

function openStream(v) {
  const es = new EventSource(url(v.links.events));
  streams.set(v.uuid, es);
  es.onopen = () => { live[v.uuid] = true; };
  es.onerror = () => { delete live[v.uuid]; }; // the browser reconnects by itself
  es.addEventListener('progress', (e) => merge(JSON.parse(e.data)));
  es.addEventListener('done', (e) => {
    merge(JSON.parse(e.data));
    closeStream(v.uuid);
    refresh(); // pick up the thumbnail/duration/storyboard added after completion
  });
  es.addEventListener('deleted', () => drop(v.uuid));
}

function syncStreams() {
  const wanted = active.value.filter((v) => v.links.events).slice(0, MAX_STREAMS);
  const ids = new Set(wanted.map((v) => v.uuid));
  for (const uuid of [...streams.keys()]) if (!ids.has(uuid)) closeStream(uuid);
  for (const v of wanted) if (!streams.has(v.uuid)) openStream(v);
}

export async function refresh() {
  try {
    const { items } = await api.list();
    const seen = new Set(items.map((v) => v.uuid));
    for (const v of items) merge(v);
    for (const uuid of Object.keys(videos)) if (!seen.has(uuid)) drop(uuid);
    status.offline = false;
  } catch {
    status.offline = true;
  } finally {
    status.loaded = true;
    syncStreams();
  }
}

function loop() {
  timer = setTimeout(async () => {
    await refresh();
    loop();
  }, active.value.length > 0 ? 2000 : 8000);
}

export function start() {
  if (started) return;
  started = true;
  refresh().then(loop);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}

export async function addDownload(videoUrl) {
  const res = await api.add(videoUrl);
  merge(res);
  await refresh();
  return res;
}

export async function removeVideo(uuid) {
  await api.remove(uuid);
  drop(uuid);
}
