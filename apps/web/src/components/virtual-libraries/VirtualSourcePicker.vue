<script setup lang="ts">
import { computed } from "vue";
import {
  isVirtualLibraryItemCompatible,
  type VirtualLibraryItem,
  type VirtualLibraryCollectionType,
} from "@emby-task-center/contracts/virtual-library";
import { isSelectableWork, itemTypeLabel, selectionError, sourceSelectionHint } from "./virtual-library-types";
const props = defineProps<{
  items: VirtualLibraryItem[];
  collectionType: VirtualLibraryCollectionType;
  roots: Array<{ id: string; name: string }>;
  selected: string[];
  added: Set<string>;
  search: string;
  parent: string;
  loading: boolean;
  busy: boolean;
  total: number;
  start: number;
  limit: number;
}>();
const selectableItems = computed(() => props.items.filter((item) => isSelectableWork(item.type)));
const emit = defineEmits<{
  "update:search": [value: string];
  "update:parent": [value: string];
  search: [];
  toggle: [id: string];
  add: [];
  page: [direction: number];
}>();
function poster(item: VirtualLibraryItem) {
  return /^\d+$/.test(item.itemId) && item.imageTag
    ? `/api/library/emby-poster?id=${encodeURIComponent(item.itemId)}`
    : undefined;
}
</script>

<template>
  <section class="vl-panel" aria-label="从 Emby 选择内容" :aria-busy="loading">
    <div class="vl-section-head">
      <div>
        <h2>从 Emby 选择内容</h2>
        <p class="vl-muted">直接读取已有媒体库，选择电影或整部剧映射到当前虚拟库，不单独选择季和分集。</p>
        <p class="vl-muted">{{ sourceSelectionHint(collectionType) }}</p>
      </div>
      <button class="vl-primary" type="button" :disabled="!selected.length || busy || loading" @click="emit('add')">
        {{ busy ? "加入中…" : `加入已选（${selected.length}）` }}
      </button>
    </div>
    <form class="vl-search" @submit.prevent="emit('search')">
      <label
        ><span class="sr-only">搜索 Emby 内容</span
        ><input
          :value="search"
          type="search"
          placeholder="搜索影片或剧集名称"
          @input="emit('update:search', ($event.target as HTMLInputElement).value)"
      /></label>
      <label
        ><span class="sr-only">源媒体库</span
        ><select
          :value="parent"
          @change="
            emit('update:parent', ($event.target as HTMLSelectElement).value);
            emit('search');
          "
        >
          <option value="">所有源媒体库</option>
          <option v-for="root in roots" :key="root.id" :value="root.id">{{ root.name }}</option>
        </select></label
      >
      <button type="submit" :disabled="loading">搜索</button>
    </form>
    <p v-if="loading" class="vl-empty" role="status">正在读取 Emby 内容…</p>
    <p v-else-if="!selectableItems.length" class="vl-empty">
      未找到电影或整部剧。请调整搜索条件，或检查 Emby 连接配置。
    </p>
    <div v-else class="vl-source-grid">
      <label
        v-for="item in selectableItems"
        :key="item.itemId"
        class="vl-source-card"
        :class="{
          selected: selected.includes(item.itemId),
          added: added.has(item.itemId),
          incompatible: !isVirtualLibraryItemCompatible(collectionType, item.type),
        }"
      >
        <div class="vl-poster">
          <img
            v-if="poster(item)"
            :src="poster(item)"
            :alt="`${item.name} 海报`"
            loading="lazy"
            @error="($event.target as HTMLImageElement).style.visibility = 'hidden'"
          /><span v-else class="vl-poster-placeholder">{{ itemTypeLabel(item.type) }}</span
          ><span v-if="added.has(item.itemId)" class="vl-added">已加入</span
          ><input
            v-else
            type="checkbox"
            :checked="selected.includes(item.itemId)"
            :disabled="busy || loading || !isVirtualLibraryItemCompatible(collectionType, item.type)"
            :aria-label="`选择 ${item.name}`"
            @change="emit('toggle', item.itemId)"
          />
        </div>
        <strong :title="item.name">{{ item.name }}</strong
        ><small>{{ item.year ?? "年份未知" }} · {{ itemTypeLabel(item.type) }}</small>
        <small v-if="!isVirtualLibraryItemCompatible(collectionType, item.type)" class="vl-type-reason">{{
          selectionError(collectionType, item)
        }}</small>
      </label>
    </div>
    <div class="vl-pagination">
      <span>{{ total ? `${start + 1}–${Math.min(start + limit, total)} / ${total}` : "0 条内容" }}</span
      ><button type="button" :disabled="!start || loading || busy" @click="emit('page', -1)">上一页</button
      ><button type="button" :disabled="start + limit >= total || loading || busy" @click="emit('page', 1)">
        下一页
      </button>
    </div>
  </section>
</template>
