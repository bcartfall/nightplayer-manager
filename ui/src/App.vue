<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { active, failed, finished, removeVideo, start, status, addDownload } from './lib/store.js';
import { toast, toasts, dismiss } from './lib/toast.js';
import { url } from './lib/api.js';
import AddDownload from './components/AddDownload.vue';
import DownloadsView from './components/DownloadsView.vue';
import LibraryView from './components/LibraryView.vue';
import SbbViewer from './components/SbbViewer.vue';
import Modal from './components/Modal.vue';
import Icon from './components/Icon.vue';

const TABS = ['downloads', 'library', 'sbb'];
const tab = ref(TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'downloads');
watch(tab, (t) => { history.replaceState(null, '', '#' + t); });
window.addEventListener('hashchange', () => { const t = location.hash.slice(1); if (TABS.includes(t)) tab.value = t; });

const playing = ref(null);
const confirming = ref(null);
const sbbVideo = ref(null); // video whose storyboard the viewer should open

onMounted(start);

const badge = computed(() => active.value.length + failed.value.length);

function openStoryboard(v) { sbbVideo.value = v; tab.value = 'sbb'; }

async function retry(v) {
  try { await addDownload(v.url); toast('Retrying this download.', 'info'); } catch (e) { toast(e.message, 'bad'); }
}
async function confirmRemove() {
  const v = confirming.value;
  confirming.value = null;
  try { await removeVideo(v.uuid); toast(v.status === 'finished' ? 'Video deleted.' : 'Removed.', 'ok'); } catch (e) { toast(e.message, 'bad'); }
}
const askRemove = (v) => { confirming.value = v; };
const running = (v) => v.status === 'queued' || v.status === 'downloading';
</script>

<template>
  <header class="sticky top-0 z-30 border-b border-line bg-ink/95 backdrop-blur">
    <div class="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-8 gap-y-3 px-5 py-3">
      <a href="#downloads" class="flex items-center gap-2.5" aria-label="Nightplayer Manager">
        <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><path d="M20.5 6.5a10 10 0 1 0 5 15.6 8 8 0 0 1-5-15.6z" fill="#f2b45c" /></svg>
        <span class="text-lg font-semibold tracking-tight">Nightplayer <span class="font-normal text-mute">manager</span></span>
      </a>

      <nav class="flex gap-1" aria-label="Sections">
        <button v-for="[id, label, count] in [['downloads', 'Downloads', badge], ['library', 'Library', finished.length], ['sbb', 'SBB viewer', 0]]"
          :key="id" class="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
          :class="tab === id ? 'bg-raised text-fg' : 'text-mute hover:text-fg'" :aria-current="tab === id ? 'page' : undefined"
          @click="tab = id">
          {{ label }}
          <span v-if="count" class="rounded-full px-1.5 text-xs" :class="id === 'downloads' ? 'bg-lantern text-ink' : 'bg-line text-mute'">{{ count }}</span>
        </button>
      </nav>

      <div class="min-w-[260px] flex-1 lg:max-w-xl lg:ml-auto"><AddDownload @added="tab = 'downloads'" /></div>
    </div>
  </header>

  <div v-if="status.offline" class="bg-[#3a2230] px-5 py-2 text-center text-sm text-bad" role="alert">
    Cannot reach the manager. Retrying…
  </div>

  <main class="mx-auto max-w-[1500px] px-5 py-8">
    <DownloadsView v-show="tab === 'downloads'" @remove="askRemove" @retry="retry" />
    <LibraryView v-show="tab === 'library'" @play="playing = $event" @storyboard="openStoryboard" @remove="askRemove" />
    <SbbViewer v-show="tab === 'sbb'" :video="sbbVideo" @clear="sbbVideo = null" />
  </main>

  <Modal v-if="playing" :title="playing.title || playing.url" wide @close="playing = null">
    <video class="aspect-video w-full rounded-lg bg-black" controls autoplay :src="url(playing.links.stream)" />
  </Modal>

  <Modal v-if="confirming" :title="running(confirming) ? 'Cancel this download?' : 'Delete this video?'" @close="confirming = null">
    <p class="text-mute">
      <template v-if="running(confirming)">The download stops and its partial files are removed.</template>
      <template v-else-if="confirming.status === 'finished'">The video file, its storyboard and its library entry are deleted from disk. This cannot be undone.</template>
      <template v-else>The entry is removed from the list.</template>
    </p>
    <p class="mt-2 line-clamp-2 font-medium">{{ confirming.title || confirming.url }}</p>
    <div class="mt-5 flex justify-end gap-2">
      <button class="btn btn-ghost" @click="confirming = null">Keep it</button>
      <button class="btn btn-danger" @click="confirmRemove">{{ running(confirming) ? 'Cancel download' : confirming.status === 'finished' ? 'Delete video' : 'Remove' }}</button>
    </div>
  </Modal>

  <div class="pointer-events-none fixed bottom-5 right-5 z-[60] flex w-80 max-w-[calc(100vw-2.5rem)] flex-col gap-2" aria-live="polite">
    <div v-for="t in toasts" :key="t.id" class="pointer-events-auto flex items-start gap-3 rounded-lg border border-line bg-raised px-4 py-3 text-sm shadow-xl">
      <Icon :name="t.kind === 'bad' ? 'alert' : 'check'" :size="16" :class="['mt-0.5 shrink-0', t.kind === 'bad' ? 'text-bad' : t.kind === 'ok' ? 'text-ok' : 'text-info']" />
      <span class="flex-1">{{ t.message }}</span>
      <button class="cursor-pointer text-mute hover:text-fg" aria-label="Dismiss" @click="dismiss(t.id)"><Icon name="x" :size="14" /></button>
    </div>
  </div>
</template>
