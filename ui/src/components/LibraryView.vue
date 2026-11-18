<script setup>
import { computed, ref } from 'vue';
import { finished, status } from '../lib/store.js';
import { formatBytes } from '../lib/format.js';
import VideoCard from './VideoCard.vue';
import Icon from './Icon.vue';
defineEmits(['play', 'storyboard', 'remove']);

const q = ref('');
const shown = computed(() => {
  const needle = q.value.trim().toLowerCase();
  if (!needle) return finished.value;
  return finished.value.filter((v) => `${v.title ?? ''} ${v.description ?? ''}`.toLowerCase().includes(needle));
});
const total = computed(() => finished.value.reduce((n, v) => n + (v.fileSize || 0), 0));
</script>

<template>
  <section>
    <div v-if="status.loaded && !finished.length" class="grid place-items-center rounded-xl border border-dashed border-line px-6 py-20 text-center">
      <Icon name="film" :size="32" class="mb-3 text-faint" />
      <h2 class="text-lg font-semibold">Your library is empty</h2>
      <p class="mt-1 max-w-sm text-mute">Finished downloads are kept here, ready to play.</p>
    </div>

    <template v-else>
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 class="text-lg font-semibold">
          Library <span class="ml-1 text-mute">{{ finished.length }} videos · {{ formatBytes(total) }}</span>
        </h2>
        <label class="w-full sm:w-72"><span class="sr-only">Search the library</span>
          <input v-model="q" class="field" type="search" placeholder="Search titles and descriptions" /></label>
      </div>
      <p v-if="!shown.length" class="py-12 text-center text-mute">No video matches “{{ q }}”.</p>
      <div class="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
        <VideoCard v-for="v in shown" :key="v.uuid" :video="v" @play="$emit('play', $event)"
          @storyboard="$emit('storyboard', $event)" @remove="$emit('remove', $event)" />
      </div>
    </template>
  </section>
</template>
