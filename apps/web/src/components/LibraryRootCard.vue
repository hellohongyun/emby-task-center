<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import { mdiDatabaseSearchOutline, mdiRefresh } from "@mdi/js";
import { computed } from "vue";

import { posterUrlFor, type LibrarySummary } from "../library/work-groups";
import type { WorkGroupSummary } from "../library/paged-library";
import type { LibraryRoot } from "../types";

/**
 * 媒体库目录卡片（P4：从 LibraryView 的模板拆出）。
 *
 * 只接收"这个目录的可见作品"（过滤排序已在父组件完成）与扫描状态，
 * 扫描 / 打开详情通过事件回传，避免子组件知道筛选规则。
 */
const props = defineProps<{
  root: LibraryRoot;
  summary: LibrarySummary;
  scanningRootId: string | null;
  /** 已按当前筛选条件过滤排序好的作品。 */
  groups: WorkGroupSummary[];
}>();

const emit = defineEmits<{ scan: [rootId: string]; select: [group: WorkGroupSummary, rootId: string] }>();

const rootKindLabel = computed(() =>
  props.root.mediaType === "tv" ? "剧集目录" : props.root.mediaType === "mixed" ? "混合目录" : "电影目录",
);

const scannedAtLabel = computed(() => {
  const value = props.root.lastScannedAt;
  return value
    ? `最后扫描 ${new Date(value).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" })}`
    : "尚无扫描时间记录";
});

function posterUrl(group: WorkGroupSummary): string | null {
  return posterUrlFor(group.posterPath);
}
</script>

<template>
  <article class="root-card">
    <header class="root-header">
      <div class="root-title">
        <SvgIcon type="mdi" :path="mdiDatabaseSearchOutline" :size="24" />
        <div>
          <h2>{{ root.name }}</h2>
          <span>{{ rootKindLabel }} · {{ root.id }}</span>
        </div>
      </div>
      <button type="button" :disabled="scanningRootId !== null" @click="emit('scan', root.id)">
        <SvgIcon type="mdi" :path="mdiRefresh" :size="19" />{{ scanningRootId === root.id ? "扫描中…" : "立即扫描" }}
      </button>
    </header>

    <template v-if="summary">
      <div class="scan-meta">
        <strong>{{ summary.totalFiles }} 个条目 · {{ summary.workCount }} 个作品</strong>
        <span>{{ scannedAtLabel }}</span>
      </div>
      <div v-if="groups.length" class="poster-wall">
        <button
          v-for="group in groups"
          :key="group.key"
          type="button"
          class="poster-card"
          :aria-label="`查看 ${group.title}`"
          @click="emit('select', group, root.id)"
        >
          <img v-if="posterUrl(group)" :src="posterUrl(group)!" :alt="`${group.title} 海报`" loading="lazy" />
          <span v-else class="poster-fallback">{{ group.title.slice(0, 1) }}</span>
          <span class="poster-badge">{{ group.isTv ? "整部剧" : "电影" }}</span>
          <span v-if="group.resolution" class="poster-res">{{ group.resolution }}</span>
          <span class="poster-caption"
            ><strong>{{ group.title }}</strong
            ><small>{{ group.year ?? "年份未知" }}</small></span
          >
        </button>
      </div>
      <div v-else-if="summary.totalFiles" class="empty">无匹配作品。</div>
      <div v-else class="empty">目录为空。</div>
    </template>
  </article>
</template>

<style scoped src="./LibraryRootCard.css"></style>
<style scoped src="./library-shared.css"></style>
