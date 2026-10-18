<script setup lang="ts">
import { computed, reactive } from "vue";
import type {
  VirtualLibraryItem,
  VirtualLibraryCollectionType,
  VirtualLibraryMappingIssue,
} from "@emby-task-center/contracts/virtual-library";
import { posterUrlFor } from "../../library/work-groups";
import { incompatibleItems, incompatibleMessage, itemTypeLabel } from "./virtual-library-types";
const props = withDefaults(
  defineProps<{
    items: VirtualLibraryItem[];
    issues?: VirtualLibraryMappingIssue[];
    collectionType: VirtualLibraryCollectionType;
    loading: boolean;
    busy: boolean;
  }>(),
  { issues: () => [] },
);
const conflicts = computed(() => incompatibleItems(props.collectionType, props.items));
const emit = defineEmits<{ remove: [id: string]; refresh: [] }>();
const failedPosters = reactive(new Set<string>());
function posterKey(item: VirtualLibraryItem) {
  return `${item.itemId}:${item.imageTag ?? ""}`;
}
function poster(item: VirtualLibraryItem) {
  return /^\d+$/.test(item.itemId) && item.imageTag && !failedPosters.has(posterKey(item))
    ? posterUrlFor(`emby:${item.itemId}`)
    : undefined;
}
</script>

<template>
  <section class="vl-panel" aria-label="已加入的内容" :aria-busy="loading">
    <div class="vl-section-head">
      <h2>
        已加入的内容 <span>{{ items.length }}</span>
      </h2>
      <button type="button" :disabled="loading || busy" @click="emit('refresh')">刷新</button>
    </div>
    <p v-if="!loading && conflicts.length" class="vl-type-warning" role="alert">
      {{ incompatibleMessage(collectionType, conflicts) }}
    </p>
    <div v-if="!loading && issues.length" class="vl-type-warning vl-mapping-warning" role="alert">
      <strong>部分内容需要检查关联</strong>
      <ul>
        <li v-for="issue in issues" :key="`${issue.itemId}:${issue.reason}`">{{ issue.message }}</li>
      </ul>
      <p>关联已保留。可点击“刷新”重试，或从下方 Emby 图库重新选择对应作品。</p>
    </div>
    <p v-if="loading" class="vl-empty" role="status">正在加载已加入内容…</p>
    <p v-else-if="!items.length" class="vl-empty">还没有内容，从下方 Emby 图库中选择影片或剧集加入。</p>
    <ul v-else class="poster-wall vl-added-items">
      <li v-for="item in items" :key="item.itemId" class="poster-card">
        <img
          v-if="poster(item)"
          :src="poster(item)!"
          :alt="`${item.name} 海报`"
          loading="lazy"
          @error="failedPosters.add(posterKey(item))"
        />
        <span v-else class="poster-fallback">{{ item.name.slice(0, 1) }}</span>
        <span class="poster-badge">{{ itemTypeLabel(item.type) }}</span>
        <div class="poster-caption">
          <strong :title="item.name">{{ item.name }}</strong>
          <small>{{ item.year ?? "年份未知" }}</small>
        </div>
        <button
          class="vl-remove-item"
          type="button"
          :disabled="busy"
          :aria-label="`从虚拟库移除 ${item.name}`"
          @click="emit('remove', item.itemId)"
        >
          移除关联
        </button>
      </li>
    </ul>
    <p class="vl-muted">此处移除只解除虚拟库关联；客户端原有的 Emby 删除媒体功能保持原样。</p>
  </section>
</template>

<style scoped src="../LibraryRootCard.css"></style>
<style scoped src="./virtual-library-added-items.css"></style>
