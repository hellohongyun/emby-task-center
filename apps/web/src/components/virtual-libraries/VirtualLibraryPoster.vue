<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { VirtualLibrary } from "@emby-task-center/contracts/virtual-library";
import { virtualLibraryRequests } from "../../composables/virtual-library-requests";

const props = defineProps<{
  library: VirtualLibrary;
  requireAuth: () => void;
  authRequired?: boolean;
}>();
const emit = defineEmits<{ saved: [library: VirtualLibrary] }>();
const { run, error, cancel } = virtualLibraryRequests(props.requireAuth);
const busy = ref(false);
const file = ref<File | null>(null);
const input = ref<HTMLInputElement>();
const preview = ref("");
const notice = ref("");
const imageFailed = ref(false);
const storedImage = computed(() =>
  props.library.posterImageTag
    ? `/api/virtual-libraries/${encodeURIComponent(props.library.id)}/poster?tag=${encodeURIComponent(props.library.posterImageTag)}`
    : "",
);
const image = computed(() => preview.value || storedImage.value);

function clearSelection() {
  if (preview.value) URL.revokeObjectURL(preview.value);
  preview.value = "";
  file.value = null;
  if (input.value) input.value.value = "";
  imageFailed.value = false;
}
function selectFile(event: Event) {
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
  file.value = selected;
  preview.value = URL.createObjectURL(selected);
}
async function save(remove = false) {
  if (busy.value || (!remove && !file.value)) return;
  const id = props.library.id;
  const selected = file.value;
  const result = await run<{ library: VirtualLibrary }>("poster", busy, `/${encodeURIComponent(id)}/poster`, {
    method: remove ? "DELETE" : "PUT",
    ...(remove ? {} : { body: selected, headers: { "Content-Type": selected!.type } }),
  });
  if (!result || props.library.id !== id) return;
  clearSelection();
  emit("saved", result.library);
  notice.value = remove ? "自定义海报已移除" : "媒体库海报已保存，客户端刷新后可见";
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
  () => props.library.posterImageTag,
  () => {
    imageFailed.value = false;
  },
);
watch(
  () => props.authRequired,
  (required) => {
    if (required) cancel();
  },
);
onBeforeUnmount(clearSelection);
</script>

<template>
  <section class="vl-panel vl-library-poster" aria-label="媒体库海报">
    <div class="vl-poster-preview">
      <img v-if="image && !imageFailed" :src="image" :alt="`${library.name}媒体库海报`" @error="imageFailed = true" />
      <span v-else>{{ imageFailed ? "海报暂时无法加载" : "未设置自定义海报" }}</span>
    </div>
    <div class="vl-poster-content">
      <h2>媒体库海报</h2>
      <p class="vl-muted">设置此虚拟库在客户端媒体库列表中的封面，不会修改库内影片海报。</p>
      <label class="vl-poster-file">
        <span>{{ library.posterImageTag ? "更换图片" : "选择图片" }}</span>
        <input ref="input" type="file" accept="image/jpeg,image/png,image/webp" :disabled="busy" @change="selectFile" />
      </label>
      <p class="vl-muted vl-poster-hint">JPEG、PNG 或 WebP，最大 5 MB；建议使用横向图片。</p>
      <p v-if="file" class="vl-poster-filename">已选择：{{ file.name }}</p>
      <div class="vl-actions">
        <button class="vl-primary" type="button" :disabled="busy || !file" @click="save()">
          {{ busy ? "处理中…" : "保存海报" }}
        </button>
        <button v-if="file" type="button" :disabled="busy" @click="clearSelection">取消选择</button>
        <button v-if="library.posterImageTag" class="vl-danger" type="button" :disabled="busy" @click="save(true)">
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
