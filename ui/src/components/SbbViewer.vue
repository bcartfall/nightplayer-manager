<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { parseSbb, locateFrame, SbbError, HEADER_SIZE, ENTRY_SIZE } from '../lib/sbb.js';
import { formatBytes, formatDuration, formatPosition } from '../lib/format.js';
import { finished } from '../lib/store.js';
import { url } from '../lib/api.js';
import Icon from './Icon.vue';

const props = defineProps({ video: Object });
const emit = defineEmits(['clear']);

const sb = ref(null);
const sheetUrls = ref([]);
const name = ref('');
const origin = ref('');
const loading = ref(false);
const error = ref('');
const dragging = ref(false);
const frame = ref(0);
const sheetIndex = ref(0);
const hover = ref(null); // { col, row, tile, time } on the sheet browser
const fileInput = ref(null);

const available = computed(() => finished.value.filter((v) => v.links.storyboard));

function clear() {
  sheetUrls.value.forEach((u) => URL.revokeObjectURL(u));
  sheetUrls.value = [];
  sb.value = null;
}
onBeforeUnmount(clear);

async function load(buffer, label, from) {
  error.value = '';
  try {
    const parsed = parseSbb(buffer);
    clear();
    sheetUrls.value = parsed.sheets.map((s) => URL.createObjectURL(new Blob([s.data], { type: 'image/jpeg' })));
    sb.value = parsed;
    name.value = label;
    origin.value = from;
    frame.value = 0;
    sheetIndex.value = 0;
  } catch (e) {
    error.value = e instanceof SbbError ? e.message : `Could not read this file: ${e.message}`;
  }
}

async function loadFile(file) {
  if (!file) return;
  loading.value = true;
  try { await load(await file.arrayBuffer(), file.name, 'Opened from your computer'); } finally { loading.value = false; }
}

async function loadVideo(v) {
  loading.value = true;
  error.value = '';
  try {
    const res = await fetch(url(v.links.storyboard));
    if (!res.ok) throw new Error(`The manager answered ${res.status} for this storyboard.`);
    await load(await res.arrayBuffer(), `${v.title || v.sourceId}.sbb`, 'From your library');
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

watch(() => props.video, (v) => { if (v?.links?.storyboard) loadVideo(v); }, { immediate: true });

function onDrop(e) { dragging.value = false; loadFile(e.dataTransfer.files[0]); }
function reset() { clear(); emit('clear'); error.value = ''; }

// ---- frame navigation
const here = computed(() => (sb.value ? locateFrame(sb.value, frame.value) : null));
watch(here, (h) => { if (h) sheetIndex.value = h.sheet.index; });
const step = (d) => { frame.value = Math.min(sb.value.totalFrames - 1, Math.max(0, frame.value + d)); };

const bg = (sheetUrl, col, row) => {
  const { columns, rows } = sb.value.header;
  return {
    backgroundImage: `url(${sheetUrl})`,
    backgroundSize: `${columns * 100}% ${rows * 100}%`,
    backgroundPosition: `${columns > 1 ? (col / (columns - 1)) * 100 : 0}% ${rows > 1 ? (row / (rows - 1)) * 100 : 0}%`,
  };
};
const previewStyle = computed(() => (here.value ? bg(sheetUrls.value[here.value.sheet.index], here.value.col, here.value.row) : {}));
const frameAspect = computed(() => `${sb.value.header.thumbWidth} / ${sb.value.header.thumbHeight}`);

// ---- sheet browser
const sheet = computed(() => sb.value?.sheets[sheetIndex.value]);
function tileAt(e) {
  const r = e.currentTarget.getBoundingClientRect();
  const { columns, rows } = sb.value.header;
  const col = Math.min(columns - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * columns)));
  const row = Math.min(rows - 1, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * rows)));
  const tile = row * columns + col;
  return tile < sheet.value.frames ? { col, row, tile, time: sheet.value.start + tile * sb.value.interval } : null;
}
const pickTile = (e) => { const t = tileAt(e); if (t) frame.value = sheet.value.firstFrame + t.tile; };
const cellBox = (col, row) => ({
  left: `${(col / sb.value.header.columns) * 100}%`, top: `${(row / sb.value.header.rows) * 100}%`,
  width: `${100 / sb.value.header.columns}%`, height: `${100 / sb.value.header.rows}%`,
});
const currentOnSheet = computed(() => here.value && here.value.sheet.index === sheetIndex.value ? here.value : null);

// ---- tables
const hex = (n) => '0x' + n.toString(16).toUpperCase().padStart(8, '0');
const headerRows = computed(() => {
  const h = sb.value.header;
  const sig = 'STORYsb\\x1a';
  return [
    [0, 8, 'Signature', sig], [8, 4, 'Version', h.version], [12, 4, 'Sheet count', h.count],
    [16, 4, 'Image width', `${h.thumbWidth} px`], [20, 4, 'Image height', `${h.thumbHeight} px`],
    [24, 8, 'Images per second', `${+h.fps.toPrecision(6)} (one every ${sb.value.interval ? +sb.value.interval.toFixed(3) : '?'} s)`],
    [32, 4, 'Rows per sheet', h.rows], [36, 4, 'Columns per sheet', h.columns],
    [40, 24, 'Reserved', h.reservedZero ? 'all zero' : 'not zero'],
    [HEADER_SIZE, ENTRY_SIZE * h.count, 'Index', `${h.count} entries × ${ENTRY_SIZE} bytes`],
    [HEADER_SIZE + ENTRY_SIZE * h.count, ENTRY_SIZE, 'Terminator', `${hex(sb.value.terminator.marker)}, end offset ${sb.value.terminator.endOffset.toLocaleString()}`],
  ];
});
const facts = computed(() => {
  const s = sb.value; const h = s.header;
  return [
    ['File size', formatBytes(s.fileSize)],
    ['Covers', formatDuration(s.covered)],
    ['Images', s.totalFrames.toLocaleString()],
    ['Sampling', s.interval ? `1 every ${+s.interval.toFixed(2)} s` : '–'],
    ['Sheets', h.count.toLocaleString()],
    ['Image size', `${h.thumbWidth} × ${h.thumbHeight}`],
    ['Sheet grid', `${h.columns} × ${h.rows}`],
    ['Sheet size', `${s.sheetPixels.width} × ${s.sheetPixels.height}`],
  ];
});
const levelIcon = { ok: 'check', warn: 'alert', error: 'alert' };
const levelColor = { ok: 'text-ok', warn: 'text-lantern', error: 'text-bad' };
</script>

<template>
  <section>
    <!-- No file yet -->
    <div v-if="!sb" class="mx-auto max-w-3xl">
      <h2 class="text-lg font-semibold">SBB viewer</h2>
      <p class="mt-1 text-mute">A storyboard (.sbb) packs a small preview image for every few seconds of a video into JPEG sheets. Open one to see what it holds.</p>

      <div class="mt-6 flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center transition-colors"
        :class="dragging ? 'border-lantern bg-raised' : 'border-line'"
        @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="onDrop">
        <Icon name="upload" :size="30" class="text-faint" />
        <p class="font-medium">{{ loading ? 'Reading…' : 'Drop an .sbb file here' }}</p>
        <button class="btn btn-ghost" :disabled="loading" @click="fileInput.click()">Choose a file</button>
        <input ref="fileInput" type="file" accept=".sbb" class="hidden" @change="loadFile($event.target.files[0]); $event.target.value = ''" />
        <p v-if="error" class="max-w-md text-sm text-bad" role="alert">{{ error }}</p>
      </div>

      <template v-if="available.length">
        <h3 class="mb-3 mt-8 font-semibold">From your library</h3>
        <ul class="grid gap-2 sm:grid-cols-2">
          <li v-for="v in available" :key="v.uuid">
            <button class="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-line bg-panel p-2 text-left transition-colors hover:border-lantern-dim"
              :disabled="loading" @click="loadVideo(v)">
              <span class="relative aspect-video w-24 shrink-0 overflow-hidden rounded bg-raised">
                <img v-if="v.links.thumbnail" :src="url(v.links.thumbnail)" alt="" class="h-full w-full object-cover" loading="lazy" />
              </span>
              <span class="line-clamp-2 text-sm font-medium">{{ v.title || v.url }}</span>
            </button>
          </li>
        </ul>
      </template>
    </div>

    <!-- Loaded -->
    <div v-else class="space-y-8">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0">
          <h2 class="truncate text-lg font-semibold">{{ name }}</h2>
          <p class="text-sm text-mute">{{ origin }}</p>
        </div>
        <button class="btn btn-ghost" @click="reset"><Icon name="upload" :size="15" />Open another file</button>
      </div>

      <div class="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <!-- Frame preview -->
        <div class="rounded-xl border border-line bg-panel p-4">
          <div class="mx-auto w-full max-w-[640px] overflow-hidden rounded-lg bg-black" :style="{ aspectRatio: frameAspect }">
            <div v-if="here" class="h-full w-full" :style="previewStyle" role="img" :aria-label="`Preview image at ${formatPosition(here.time)}`" />
            <div v-else class="grid h-full place-items-center text-sm text-mute">No images in this file.</div>
          </div>
          <div v-if="here" class="mx-auto mt-4 max-w-[640px]">
            <div class="mb-2 flex items-baseline justify-between">
              <span class="text-2xl font-semibold">{{ formatPosition(here.time) }}</span>
              <span class="text-sm text-mute">image {{ (frame + 1).toLocaleString() }} of {{ sb.totalFrames.toLocaleString() }}</span>
            </div>
            <div class="flex items-center gap-3">
              <button class="btn btn-ghost !px-2.5" aria-label="Previous image" :disabled="frame <= 0" @click="step(-1)">‹</button>
              <input v-model.number="frame" type="range" min="0" :max="Math.max(0, sb.totalFrames - 1)" step="1"
                class="h-1.5 w-full cursor-pointer accent-[#f2b45c]" aria-label="Position in the video" />
              <button class="btn btn-ghost !px-2.5" aria-label="Next image" :disabled="frame >= sb.totalFrames - 1" @click="step(1)">›</button>
            </div>
            <p class="mt-2 text-sm text-mute">Sheet {{ here.sheet.index + 1 }}, row {{ here.row + 1 }}, column {{ here.col + 1 }}</p>
          </div>
        </div>

        <!-- Facts and checks -->
        <div class="space-y-6">
          <dl class="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
            <div v-for="[k, v] in facts" :key="k" class="bg-panel px-4 py-3">
              <dt class="text-sm text-mute">{{ k }}</dt>
              <dd class="mt-0.5 text-lg font-semibold">{{ v }}</dd>
            </div>
          </dl>

          <div class="rounded-xl border border-line bg-panel p-4">
            <h3 class="mb-3 flex items-center gap-2 font-semibold">
              <Icon :name="sb.healthy ? 'check' : 'alert'" :size="18" :class="sb.healthy ? 'text-ok' : 'text-bad'" />
              {{ sb.healthy ? 'File is well formed' : 'File has problems' }}
            </h3>
            <ul class="space-y-1.5 text-sm">
              <li v-for="(c, i) in sb.checks" :key="i" class="flex gap-2.5">
                <Icon :name="levelIcon[c.level]" :size="15" :class="['mt-0.5 shrink-0', levelColor[c.level]]" />
                <span :class="c.level === 'ok' ? 'text-mute' : ''">{{ c.text }}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <!-- Sheet browser -->
      <div class="rounded-xl border border-line bg-panel p-4">
        <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h3 class="font-semibold">Sheets</h3>
          <p class="text-sm text-mute">Hover a sheet to see the time of each image. Click one to preview it.</p>
        </div>
        <div class="mb-4 flex gap-2 overflow-x-auto pb-2" role="tablist" aria-label="Sheets">
          <button v-for="(s, i) in sb.sheets" :key="i" role="tab" :aria-selected="i === sheetIndex" :aria-label="`Sheet ${i + 1}`"
            class="relative h-12 w-[86px] shrink-0 cursor-pointer overflow-hidden rounded-md border-2 bg-raised transition-colors"
            :class="i === sheetIndex ? 'border-lantern' : 'border-transparent opacity-70 hover:opacity-100'" @click="sheetIndex = i">
            <img :src="sheetUrls[i]" alt="" class="h-full w-full object-cover" loading="lazy" />
            <span class="absolute bottom-0 right-0 rounded-tl bg-black/75 px-1 text-xs">{{ i + 1 }}</span>
          </button>
        </div>

        <div v-if="sheet" class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_260px]">
          <div class="relative cursor-crosshair select-none overflow-hidden rounded-lg bg-black"
            :style="{ aspectRatio: `${sb.sheetPixels.width} / ${sb.sheetPixels.height}` }"
            @mousemove="hover = tileAt($event)" @mouseleave="hover = null" @click="pickTile">
            <img :src="sheetUrls[sheetIndex]" alt="Contact sheet of small preview images" class="pointer-events-none absolute inset-0 h-full w-full" draggable="false" />
            <div v-if="currentOnSheet" class="pointer-events-none absolute border-2 border-lantern" :style="cellBox(currentOnSheet.col, currentOnSheet.row)" />
            <div v-if="hover" class="pointer-events-none absolute border border-white bg-white/20" :style="cellBox(hover.col, hover.row)" />
            <div v-if="hover" class="pointer-events-none absolute rounded bg-black/85 px-2 py-0.5 text-xs font-medium"
              :style="{ left: `calc(${((hover.col + 0.5) / sb.header.columns) * 100}% )`, top: `calc(${(hover.row / sb.header.rows) * 100}% - 4px)`, transform: 'translate(-50%,-100%)' }">
              {{ formatPosition(hover.time) }}
            </div>
          </div>
          <dl class="grid h-fit grid-cols-2 gap-x-4 gap-y-3 text-sm xl:grid-cols-1">
            <div><dt class="text-mute">Sheet</dt><dd class="font-semibold">{{ sheetIndex + 1 }} of {{ sb.sheets.length }}</dd></div>
            <div><dt class="text-mute">Time range</dt><dd class="font-semibold">{{ formatDuration(sheet.start) }} to {{ formatDuration(sheet.start + sheet.duration) }}</dd></div>
            <div><dt class="text-mute">Images on this sheet</dt><dd class="font-semibold">{{ sheet.frames }} of {{ sb.header.rows * sb.header.columns }}</dd></div>
            <div><dt class="text-mute">JPEG size</dt><dd class="font-semibold">{{ formatBytes(sheet.size) }}</dd></div>
            <div><dt class="text-mute">Position in file</dt><dd class="font-mono text-[13px]">{{ hex(sheet.offset) }}</dd></div>
          </dl>
        </div>
      </div>

      <!-- Raw structure -->
      <div class="grid gap-6 xl:grid-cols-2">
        <div class="overflow-x-auto rounded-xl border border-line bg-panel">
          <h3 class="px-4 pt-4 font-semibold">Header</h3>
          <table class="mt-2 w-full text-left text-sm">
            <thead class="text-mute"><tr><th class="px-4 py-2 font-medium">Offset</th><th class="px-2 py-2 font-medium">Bytes</th><th class="px-2 py-2 font-medium">Field</th><th class="px-4 py-2 font-medium">Value</th></tr></thead>
            <tbody>
              <tr v-for="r in headerRows" :key="r[0]" class="border-t border-line">
                <td class="px-4 py-2 font-mono text-[13px] text-mute">{{ r[0] }}</td>
                <td class="px-2 py-2 font-mono text-[13px] text-mute">{{ r[1].toLocaleString() }}</td>
                <td class="px-2 py-2">{{ r[2] }}</td>
                <td class="px-4 py-2 font-mono text-[13px]">{{ r[3] }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <details class="overflow-hidden rounded-xl border border-line bg-panel" :open="sb.sheets.length <= 12">
          <summary class="cursor-pointer px-4 py-4 font-semibold">Index <span class="font-normal text-mute">{{ sb.sheets.length }} entries</span></summary>
          <div class="max-h-[420px] overflow-auto">
            <table class="w-full text-left text-sm">
              <thead class="sticky top-0 bg-panel text-mute"><tr>
                <th class="px-4 py-2 font-medium">#</th><th class="px-2 py-2 font-medium">Offset</th><th class="px-2 py-2 font-medium">Size</th>
                <th class="px-2 py-2 font-medium">Starts</th><th class="px-2 py-2 font-medium">Covers</th><th class="px-4 py-2 font-medium">JPEG</th></tr></thead>
              <tbody>
                <tr v-for="s in sb.sheets" :key="s.index" class="cursor-pointer border-t border-line hover:bg-raised" @click="sheetIndex = s.index">
                  <td class="px-4 py-2 font-mono text-[13px]">{{ s.index }}</td>
                  <td class="px-2 py-2 font-mono text-[13px] text-mute">{{ hex(s.offset) }}</td>
                  <td class="px-2 py-2">{{ formatBytes(s.size) }}</td>
                  <td class="px-2 py-2">{{ formatDuration(s.start) }}</td>
                  <td class="px-2 py-2">{{ +s.duration.toFixed(2) }} s</td>
                  <td class="px-4 py-2" :class="s.jpeg.soi && s.jpeg.eoi ? 'text-ok' : 'text-bad'">{{ s.jpeg.width ? `${s.jpeg.width}×${s.jpeg.height}` : s.jpeg.soi ? 'no size' : 'invalid' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </div>
  </section>
</template>
