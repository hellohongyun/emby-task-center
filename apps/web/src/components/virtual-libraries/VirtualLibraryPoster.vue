<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { VirtualLibrary } from "@emby-task-center/contracts/virtual-library";
import { virtualLibraryRequests } from "../../composables/virtual-library-requests";
import { compressPoster } from "../../composables/compress-poster";
import VirtualLibraryCover from "./VirtualLibraryCover.vue";

const props = defineProps<{
  library: VirtualLibrary;
  requireAuth: () => void;
  authRequired?: boolean;
  base?: string;
}>();
const emit = defineEmits<{ saved: [library: VirtualLibrary] }>();
const { run, error, cancel } = virtualLibraryRequests(props.requireAuth, props.base);
const busy = ref(false);
const compressing = ref(false);
const compressionSummary = ref("");
let compression: AbortController | undefined;
const file = ref<File | null>(null);
const input = ref<HTMLInputElement>();
const preview = ref("");
const notice = ref("");
const storedImage = computed(() =>
  props.library.posterImageTag
    ? `${props.base ?? "/api/virtual-libraries"}/${encodeURIComponent(props.library.id)}/poster?tag=${encodeURIComponent(props.library.posterImageTag)}`
    : "",
);
const image = computed(() => preview.value || storedImage.value);

function clearSelection() {
  compression?.abort();
  compression = undefined;
  compressing.value = false;
  compressionSummary.value = "";
  if (preview.value) URL.revokeObjectURL(preview.value);
  preview.value = "";
  file.value = null;
  if (input.value) input.value.value = "";
}
async function selectFile(event: Event) {
  const selected = (event.target as HTMLInputElement).files?.[0];
  clearSelection();
  error.value = "";
  notice.value = "";
  if (!selected) return;
  if (!["image/jpeg", "image/png", "image/webp"].includes(selected.type)) {
    error.value = "请选择 JPEG、PNG 或 WebP 图片";
    return;
  }
  if (selected.size === 0 || selected.size > 5 * 1024 * 1024) {
    error.value = "图片大小需大于 0 且不超过 5 MB";
    return;
  }
  const controller = new AbortController();
  compression = controller;
  compressing.value = true;
  try {
    const compressed = await compressPoster(selected, controller.signal);
    if (compression !== controller || controller.signal.aborted) return;
    file.value = compressed;
    preview.value = URL.createObjectURL(compressed);
    const size = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;
    compressionSummary.value =
      compressed === selected
        ? `图片已优化检查，保留原图（${size(selected.size)}）`
        : `已自动压缩：${size(selected.size)} → ${size(compressed.size)}`;
  } catch (caught) {
    if (!controller.signal.aborted && compression === controller)
      error.value = caught instanceof Error ? caught.message : "图片压缩失败，请重新选择图片。";
  } finally {
    if (compression === controller) compressing.value = false;
  }
}
async function save(remove = false) {
  if (busy.value || compressing.value || (!remove && !file.value)) return;
  const id = props.library.id;
  const selected = file.value;
  const result = await run<{ library: VirtualLibrary }>(
    "poster",
    busy,
    `/${encodeURIComponent(id)}/poster`,
    {
      method: remove ? "DELETE" : "PUT",
      ...(remove ? {} : { body: selected, headers: { "Content-Type": selected!.type } }),
    },
    remove ? {} : { timeoutMs: 120_000 },
  );
  if (!result || props.library.id !== id) return;
  clearSelection();
  emit("saved", result.library);
  notice.value = remove ? "自定义海报已移除，已恢复系统默认海报" : "媒体库海报已保存，客户端刷新后可见";
}
watch(
  () => props.library.id,
  () => {
    clearSelection();
    error.value = "";
    notice.value = "";
  },
);
watch(
  () => props.authRequired,
  (required) => {
    if (required) {
      clearSelection();
      cancel();
    }
  },
);
onBeforeUnmount(clearSelection);
</script>

<template>
  <section class="vl-panel vl-library-poster" aria-label="媒体库海报">
    <div class="vl-poster-preview">
      <VirtualLibraryCover :src="image" :name="library.name" />
    </div>
    <div class="vl-poster-content">
      <h2>媒体库海报</h2>
      <p class="vl-poster-state">
        {{ preview ? "新海报预览 · 尚未保存" : library.posterImageTag ? "正在使用自定义海报" : "正在使用系统默认海报" }}
      </p>
      <p class="vl-muted">未上传时自动使用系统默认海报；自定义封面不会修改库内影片海报。</p>
      <label class="vl-poster-file">
        <span>{{ library.posterImageTag ? "更换图片" : "选择图片" }}</span>
        <input ref="input" type="file" accept="image/jpeg,image/png,image/webp" :disabled="busy" @change="selectFile" />
      </label>
      <p class="vl-muted vl-poster-hint">
        JPEG、PNG 或 WebP，最大 5 MB；上传前自动压缩，最长边不超过 1600 像素，压缩更大时保留原图。
      </p>
      <p v-if="compressing" class="vl-muted" role="status">正在压缩图片…</p>
      <p v-else-if="compressionSummary" class="vl-muted" role="status">{{ compressionSummary }}</p>
      <p v-if="file" class="vl-poster-filename">已选择：{{ file.name }}</p>
      <div class="vl-actions">
        <button class="vl-primary" type="button" :disabled="busy || compressing || !file" @click="save()">
          {{ compressing ? "正在压缩…" : busy ? "处理中…" : "保存海报" }}
        </button>
        <button v-if="file || compressing" type="button" :disabled="busy" @click="clearSelection">取消选择</button>
        <button
          v-if="library.posterImageTag"
          class="vl-danger"
          type="button"
          :disabled="busy || compressing"
          @click="save(true)"
        >
          移除自定义海报
        </button>
      </div>
      <p v-if="error" class="vl-error" role="alert">{{ error }}</p>
      <p v-else-if="notice" class="vl-notice" role="status">{{ notice }}</p>
    </div>
  </section>
</template>

<style scoped>
.vl-library-poster {
  display: flex;
  align-items: flex-start;
  gap: 22px;
}
.vl-poster-preview {
  width: 240px;
  aspect-ratio: 16 / 9;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  overflow: hidden;
  border: 1px solid #2b404d;
  border-radius: 9px;
  background: #101f29;
  color: #8295a1;
  font-size: 12px;
}
.vl-poster-preview img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.vl-poster-content {
  min-width: 0;
  flex: 1;
}
.vl-poster-content p {
  margin: 8px 0;
  font-size: 12px;
}
.vl-poster-file {
  display: grid;
  gap: 8px;
  color: #d8e4eb;
  font-size: 12px;
}
.vl-poster-file input {
  width: 100%;
  max-width: 360px;
  min-height: 38px;
  font: inherit;
}
.vl-poster-file input::file-selector-button {
  min-height: 36px;
  margin-right: 10px;
  padding: 7px 12px;
  border: 1px solid #2b404d;
  border-radius: 7px;
  background: #14232e;
  color: #d8e4eb;
  cursor: pointer;
}
.vl-poster-filename {
  overflow-wrap: anywhere;
}
.vl-library-poster .vl-actions {
  flex-wrap: wrap;
}
@media (max-width: 700px) {
  .vl-library-poster {
    flex-direction: column;
    gap: 16px;
  }
  .vl-poster-preview {
    width: min(100%, 320px);
  }
  .vl-poster-content {
    width: 100%;
  }
}
</style>
