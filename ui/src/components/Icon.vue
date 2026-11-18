<script setup>
defineProps({ name: { type: String, required: true }, size: { type: Number, default: 18 } });
const paths = {
  plus: 'M12 5v14M5 12h14',
  play: 'M7 4.5v15l12-7.5z',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3',
  film: 'M4 5h16v14H4zM8 5v14M16 5v14M4 9h4M16 9h4M4 15h4M16 15h4',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  upload: 'M12 16V4M7 9l5-5 5 5M5 20h14',
  x: 'M6 6l12 12M18 6L6 18',
  retry: 'M4 12a8 8 0 0 1 14-5.3M20 4v5h-5M20 12a8 8 0 0 1-14 5.3M4 20v-5h5',
  down: 'M12 4v12M7 11l5 5 5-5M5 20h14',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  check: 'M5 13l4 4L19 7',
  alert: 'M12 8v5M12 16.5v.01M10.3 4l-8 14a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0z',
};
</script>
<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name]" /></svg>
</template>
