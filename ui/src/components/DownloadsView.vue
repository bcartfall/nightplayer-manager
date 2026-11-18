<script setup>
import { active, failed, status } from '../lib/store.js';
import VideoCard from './VideoCard.vue';
import Icon from './Icon.vue';
defineEmits(['remove', 'retry']);
</script>

<template>
  <section>
    <div v-if="status.loaded && !active.length && !failed.length" class="grid place-items-center rounded-xl border border-dashed border-line px-6 py-20 text-center">
      <Icon name="down" :size="32" class="mb-3 text-faint" />
      <h2 class="text-lg font-semibold">Nothing is downloading</h2>
      <p class="mt-1 max-w-sm text-mute">Paste a YouTube or Twitch link above. Progress shows up here as it happens.</p>
    </div>

    <template v-else>
      <h2 v-if="active.length" class="mb-4 text-lg font-semibold">
        Downloading <span class="ml-1 text-mute">{{ active.length }}</span>
      </h2>
      <div class="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
        <VideoCard v-for="v in active" :key="v.uuid" :video="v" @remove="$emit('remove', $event)" />
      </div>

      <template v-if="failed.length">
        <h2 class="mb-4 mt-10 text-lg font-semibold">Needs attention <span class="ml-1 text-mute">{{ failed.length }}</span></h2>
        <div class="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
          <VideoCard v-for="v in failed" :key="v.uuid" :video="v" @remove="$emit('remove', $event)" @retry="$emit('retry', $event)" />
        </div>
      </template>
    </template>
  </section>
</template>
