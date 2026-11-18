<script setup>
import { ref } from 'vue';
import Icon from './Icon.vue';
import { addDownload } from '../lib/store.js';
import { toast } from '../lib/toast.js';

const emit = defineEmits(['added']);
const link = ref('');
const busy = ref(false);
const error = ref('');

async function submit() {
  const value = link.value.trim();
  if (!value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const r = await addDownload(value);
    if (r.retried) toast('Retrying this download.', 'info');
    else if (r.existing && r.status === 'finished') toast('Already in your library.', 'info');
    else if (r.existing) toast('Already downloading.', 'info');
    else toast('Download started.', 'ok');
    link.value = '';
    emit('added', r);
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="w-full" @submit.prevent="submit">
    <div class="flex gap-2">
      <label class="sr-only" for="add-url">Video link</label>
      <input id="add-url" v-model="link" class="field" type="url" inputmode="url" autocomplete="off"
        placeholder="Paste a YouTube video or Twitch VOD/clip link" :aria-invalid="!!error"
        @input="error = ''" />
      <button class="btn btn-primary shrink-0" type="submit" :disabled="busy || !link.trim()">
        <Icon name="plus" :size="16" />
        {{ busy ? 'Adding…' : 'Add download' }}
      </button>
    </div>
    <p v-if="error" class="mt-1.5 text-sm text-bad" role="alert">{{ error }}</p>
  </form>
</template>
