<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import type { VirtualLibraryItem } from "@emby-task-center/contracts/virtual-library";
import type { LibraryDraft } from "../../composables/useVirtualLibraries";
import { incompatibleItems, incompatibleMessage, sourceSelectionHint } from "./virtual-library-types";
const props = defineProps<{
  initial: LibraryDraft;
  editing: boolean;
  busy: boolean;
  items: VirtualLibraryItem[];
  itemsLoading: boolean;
}>();
const emit = defineEmits<{ save: [draft: LibraryDraft]; cancel: [] }>();
const draft = reactive({ ...props.initial });
const typeChanged = computed(() => props.editing && draft.collectionType !== props.initial.collectionType);
const conflicts = computed(() => incompatibleItems(draft.collectionType, props.items));
const blocked = computed(() => typeChanged.value && (props.itemsLoading || conflicts.value.length > 0));
function save() {
  if (!props.busy && !blocked.value) emit("save", { ...draft, name: draft.name.trim() });
}
watch(
  () => props.initial,
  (value) => Object.assign(draft, value),
);
</script>

<template>
  <form class="vl-panel vl-library-form" @submit.prevent="save">
    <h2>{{ editing ? "编辑虚拟媒体库" : "新建虚拟媒体库" }}</h2>
    <div class="vl-fields">
      <label>媒体库名称<input v-model="draft.name" required placeholder="例如：周末精选" /></label>
      <label
        >显示类型<select v-model="draft.collectionType">
          <option value="movies">电影</option>
          <option value="tvshows">剧集</option>
          <option value="mixed">混合</option>
        </select></label
      >
      <label>排序<input v-model.number="draft.sortOrder" type="number" step="1" required /></label>
    </div>
    <p class="vl-muted">
      显示类型会影响客户端筛选，类型不匹配的内容可能无法显示。{{
        sourceSelectionHint(draft.collectionType)
      }}排序数字越小越靠前。
    </p>
    <p v-if="typeChanged && itemsLoading" class="vl-type-warning" role="status">
      正在检查已加入内容，请稍候再保存类型。
    </p>
    <p v-else-if="typeChanged && conflicts.length" class="vl-type-warning" role="alert">
      无法切换到此类型。{{ incompatibleMessage(draft.collectionType, conflicts) }}
    </p>
    <div class="vl-actions">
      <button class="vl-primary" :disabled="busy || blocked || !draft.name.trim()">
        {{ busy ? "保存中…" : "保存媒体库" }}</button
      ><button type="button" :disabled="busy" @click="emit('cancel')">取消</button>
    </div>
  </form>
</template>
