<script setup>
import { computed } from 'vue';
import Icon from './Icon.vue';
import { url } from '../lib/api.js';
import { live } from '../lib/store.js';
import { formatBytes, formatDuration, formatEta, formatSpeed, sourceLabel, formatDate } from '../lib/format.js';

const props = defineProps({ video: { type: Object, required: true } });
const emit = defineEmits(['play', 'storyboard', 'remove', 'retry']);

const v = computed(() => props.video);
const thumb = computed(() => url(v.value.links.thumbnail));
const running = computed(() => v.value.status === 'queued' || v.value.status === 'downloading');
const pct = computed(() => Math.max(0, Math.min(100, v.value.percent ?? 0)));
const failedState = computed(() => v.value.status === 'error' || v.value.status === 'cancelled');
const title = computed(() => v.value.title || v.value.url);
const stats = computed(() => {
  if (v.value.status !== 'downloading') return [];
  return [formatSpeed(v.value.speed), formatEta(v.value.eta)].filter(Boolean);
});
</script>

<template>
  <article class="group flex flex-col overflow-hidden rounded-xl border border-line bg-panel">
    <!-- Thumbnail. While downloading it starts dim and grey; colour is revealed as the percent climbs. -->
    <div class="relative aspect-video overflow-hidden bg-raised">
      <template v-if="thumb">
        <img :src="thumb" alt="" loading="lazy" class="absolute inset-0 h-full w-full object-cover"
          :class="running ? 'brightness-[.45] grayscale' : failedState ? 'brightness-50 grayscale' : ''" />
        <img v-if="running" :src="thumb" alt="" class="absolute inset-0 h-full w-full object-cover transition-[clip-path] duration-700 ease-out"
          :style="{ clipPath: `inset(0 ${100 - pct}% 0 0)` }" />
      </template>
      <div v-else class="absolute inset-0 flex items-center justify-center text-faint"><Icon name="film" :size="36" /></div>

      <div v-if="running && pct > 0 && pct < 100" class="absolute inset-y-0 w-px bg-lantern/80 transition-[left] duration-700 ease-out"
        :style="{ left: pct + '%' }" />

      <span v-if="v.duration" class="absolute bottom-2 right-2 rounded bg-black/75 px-1.5 py-0.5 text-xs font-medium text-white">
        {{ formatDuration(v.duration) }}
      </span>
      <span v-if="running" class="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-black/70 px-2 py-0.5 text-xs">
        <span class="size-1.5 rounded-full" :class="live[v.uuid] ? 'bg-ok' : 'bg-faint'" />
        {{ live[v.uuid] ? 'Live' : 'Polling' }}
      </span>

      <button v-if="v.status === 'finished'"
        class="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/0 text-white opacity-0 transition hover:bg-black/40 hover:opacity-100 focus-visible:opacity-100"
        :aria-label="`Play ${title}`" @click="emit('play', v)">
        <span class="grid size-12 place-items-center rounded-full bg-lantern text-ink"><Icon name="play" :size="22" /></span>
      </button>
    </div>

    <div class="flex flex-1 flex-col gap-3 p-4">
      <div class="min-w-0">
        <h3 class="line-clamp-2 text-[15px] font-semibold leading-snug" :title="title">{{ title }}</h3>
        <p v-if="v.description" class="mt-1 line-clamp-2 text-sm leading-snug text-mute">{{ v.description }}</p>
      </div>

      <!-- Progress -->
      <div v-if="running" class="mt-auto">
        <div class="mb-1.5 flex items-baseline justify-between text-sm">
          <span v-if="v.status === 'queued'" class="text-mute">Waiting in queue</span>
          <span v-else class="font-semibold text-lantern">{{ pct.toFixed(pct < 10 ? 1 : 0) }}%</span>
          <span class="text-mute">{{ stats.join(' · ') }}</span>
        </div>
        <div class="h-1.5 overflow-hidden rounded-full bg-raised" role="progressbar" :aria-valuenow="Math.round(pct)" aria-valuemin="0" aria-valuemax="100">
          <div class="h-full rounded-full bg-lantern transition-[width] duration-700 ease-out" :style="{ width: pct + '%' }" />
        </div>
      </div>

      <p v-else-if="failedState" class="mt-auto flex items-start gap-2 text-sm text-bad">
        <Icon name="alert" :size="16" class="mt-0.5 shrink-0" />
        <span class="line-clamp-3">{{ v.status === 'cancelled' ? 'Cancelled.' : v.error || 'Download failed.' }}</span>
      </p>

      <dl class="flex flex-wrap gap-x-4 gap-y-1 text-sm text-mute" :class="{ 'mt-auto': !running && !failedState }">
        <div class="flex gap-1.5"><dt class="sr-only">Source</dt><dd>{{ sourceLabel(v.source) }}</dd></div>
        <div class="flex gap-1.5"><dt class="text-faint">Length</dt><dd>{{ formatDuration(v.duration) }}</dd></div>
        <div class="flex gap-1.5"><dt class="text-faint">Size</dt><dd>{{ formatBytes(v.fileSize) }}</dd></div>
        <div v-if="v.status === 'finished'" class="flex gap-1.5"><dt class="text-faint">Added</dt><dd>{{ formatDate(v.createdAt) }}</dd></div>
      </dl>

      <div class="flex gap-2">
        <template v-if="v.status === 'finished'">
          <button class="btn btn-primary flex-1" @click="emit('play', v)"><Icon name="play" :size="15" />Play</button>
          <button class="btn btn-ghost" :disabled="!v.links.storyboard" :title="v.links.storyboard ? 'Inspect storyboard' : 'Storyboard not ready yet'"
            :aria-label="`Open storyboard of ${title}`" @click="emit('storyboard', v)"><Icon name="layers" :size="16" /></button>
          <button class="btn btn-danger" :aria-label="`Delete ${title}`" @click="emit('remove', v)"><Icon name="trash" :size="16" /></button>
        </template>
        <template v-else-if="failedState">
          <button class="btn btn-ghost flex-1" @click="emit('retry', v)"><Icon name="retry" :size="15" />Try again</button>
          <button class="btn btn-danger" :aria-label="`Remove ${title}`" @click="emit('remove', v)"><Icon name="trash" :size="16" /></button>
        </template>
        <button v-else class="btn btn-ghost flex-1" @click="emit('remove', v)"><Icon name="x" :size="15" />Cancel download</button>
      </div>
    </div>
  </article>
</template>
