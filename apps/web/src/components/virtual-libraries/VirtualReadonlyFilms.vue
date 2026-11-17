<script setup lang="ts">
import { computed, ref } from "vue";
import type { VirtualLibraryItem } from "@emby-task-center/contracts/virtual-library";
const props = defineProps<{
  libraryId: string;
  items: VirtualLibraryItem[];
  posterBase?: string;
  paginated?: boolean;
  emptyHint?: string;
}>();
const search = ref("");
const type = ref("");
const failed = ref(new Set<string>());
const typeName = (value: string) => ({ Movie: "电影", Series: "剧集", Season: "季", Episode: "分集" })[value] ?? "其他";
const types = computed(() => [...new Set(props.items.map((item) => item.type))]);
const visible = computed(() =>
  props.items.filter(
    (item) =>
      (!type.value || item.type === type.value) &&
      `${item.name} ${item.year ?? ""}`.toLowerCase().includes(search.value.trim().toLowerCase()),
  ),
);
const poster = (item: VirtualLibraryItem) =>
  `${props.posterBase ?? `/api/virtual-library-market/user-libraries/${encodeURIComponent(props.libraryId)}`}/items/${encodeURIComponent(item.itemId)}/poster${item.imageTag ? `?tag=${encodeURIComponent(item.imageTag)}` : ""}`;
</script>
<template>
  <section class="vul-films" aria-label="库内影片">
    <div class="vul-film-toolbar">
      <label class="vul-search"
        >{{ paginated ? "搜索本页影片" : "搜索当前库影片"
        }}<input v-model="search" type="search" placeholder="影片名称或年份"
      /></label>
      <label class="vul-type"
        >内容类型<select v-model="type">
          <option value="">全部类型</option>
          <option v-for="value in types" :key="value" :value="value">{{ typeName(value) }}</option>
        </select></label
      >
      <span class="vul-results">{{ visible.length }} / {{ items.length }} 项</span>
    </div>
    <div v-if="!items.length" class="vul-state">
      <strong>此库尚无影片。</strong>
      <p>{{ emptyHint ?? "作者添加内容后会在这里展示。" }}</p>
    </div>
    <div v-else-if="!visible.length" class="vul-state">
      <strong>没有匹配的影片</strong>
      <p>试试其他片名、年份或类型。</p>
      <button
        type="button"
        @click="
          search = '';
          type = '';
        "
      >
        清除筛选
      </button>
    </div>
    <div v-else class="vul-film-grid">
      <article v-for="item in visible" :key="item.itemId" class="vul-film" :aria-label="item.name">
        <div class="vul-film-art">
          <img
            v-if="!failed.has(item.itemId)"
            :src="poster(item)"
            :alt="`${item.name} 海报`"
            loading="lazy"
            decoding="async"
            @error="failed = new Set([...failed, item.itemId])"
          />
          <div v-else class="vul-film-fallback" :aria-label="`${item.name}暂无海报`" role="img">
            <span aria-hidden="true">▤</span><span>暂无海报</span>
          </div>
          <span class="vul-film-kind">{{ typeName(item.type) }}</span>
        </div>
        <h3>{{ item.name }}</h3>
        <p class="vul-film-year">{{ item.year ?? "年份未知" }}</p>
      </article>
    </div>
  </section>
</template>
