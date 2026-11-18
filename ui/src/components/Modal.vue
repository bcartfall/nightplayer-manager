<script setup>
import { onMounted, onUnmounted } from 'vue';
import Icon from './Icon.vue';
defineProps({ title: String, wide: Boolean });
const emit = defineEmits(['close']);
const onKey = (e) => { if (e.key === 'Escape') emit('close'); };
onMounted(() => document.addEventListener('keydown', onKey));
onUnmounted(() => document.removeEventListener('keydown', onKey));
</script>
<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" @mousedown.self="emit('close')">
    <div role="dialog" aria-modal="true" :aria-label="title"
      class="max-h-full w-full overflow-auto rounded-xl border border-line bg-panel shadow-2xl"
      :class="wide ? 'max-w-4xl' : 'max-w-md'">
      <div class="flex items-center justify-between gap-4 px-5 pt-4">
        <h2 class="truncate text-base font-semibold">{{ title }}</h2>
        <button class="rounded-md p-1 text-mute hover:text-fg cursor-pointer" aria-label="Close" @click="emit('close')">
          <Icon name="x" />
        </button>
      </div>
      <div class="p-5"><slot /></div>
    </div>
  </div>
</template>
