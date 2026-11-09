<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import { mdiChevronRight, mdiMagnify } from "@mdi/js";
import { nextTick, ref } from "vue";
import { useMediaRequestApi } from "../composables/media-request-api";
import type { RequestMedia } from "../composables/media-request-types";

defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ select: [media: RequestMedia | null] }>();
const api = useMediaRequestApi();
const searchInput = ref<HTMLInputElement | null>(null);
const query = ref("");
const results = ref<RequestMedia[]>([]);
const searched = ref(false);
let revision = 0;

function focusSearch() {
  searchInput.value?.focus();
}
async function changeSelection() {
  revision++;
  api.cancel();
  emit("select", null);
  await nextTick();
  focusSearch();
}
defineExpose({ changeSelection, focusSearch });

async function search() {
  const keyword = query.value.trim();
  if (!keyword || api.busy.value.search) return;
  const current = ++revision;
  api.cancel("details");
  results.value = [];
  searched.value = false;
  const result = await api.run<{ results: RequestMedia[] }>(
    "search",
    `/api/public/tmdb/search?q=${encodeURIComponent(keyword)}`,
  );
  if (result && current === revision) {
    results.value = result.results;
    searched.value = true;
  }
}
async function choose(media: RequestMedia) {
  const current = ++revision;
  const result = await api.run<{ result: RequestMedia }>(
    "details",
    `/api/public/tmdb/details?type=${media.mediaType}&id=${media.tmdbId}`,
  );
  if (result && current === revision) emit("select", result.result);
}
</script>

<template>
  <section class="request-picker" aria-label="选择求片作品">
    <header class="picker-heading">
      <h2>查找电影或剧集</h2>
      <p>用中文名或原名搜索，核对海报和年份后选择作品。</p>
    </header>
    <form class="search" role="search" aria-label="查找求片作品" @submit.prevent="search">
      <label class="search-field">
        <span class="sr-only">搜索作品</span>
        <SvgIcon type="mdi" :path="mdiMagnify" :size="21" aria-hidden="true" />
        <input
          ref="searchInput"
          v-model="query"
          type="search"
          maxlength="200"
          placeholder="输入电影名或剧名"
          enterkeyhint="search"
          :disabled="disabled"
          required
        />
      </label>
      <button type="submit" :disabled="disabled || api.busy.value.search || !query.trim()">
        {{ api.busy.value.search ? "搜索中…" : "搜索" }}
      </button>
    </form>
    <p v-if="api.error.value" class="picker-error" role="alert">{{ api.error.value }}</p>
    <p v-else-if="api.busy.value.search" class="picker-notice" role="status">正在搜索作品…</p>
    <p v-else-if="api.busy.value.details" class="picker-notice" role="status">正在核对作品和分季资料…</p>
    <div v-else-if="searched && !results.length" class="picker-empty" role="status">
      <strong>没有找到匹配的作品</strong>
      <p>试试作品原名，或缩短搜索关键词。</p>
    </div>
    <div v-if="results.length" class="results-heading">
      <h3>搜索结果</h3>
      <span role="status">{{ results.length }} 部作品</span>
    </div>
    <ul v-if="results.length" class="results">
      <li v-for="item in results" :key="`${item.mediaType}:${item.tmdbId}`">
        <button type="button" :disabled="disabled || api.busy.value.details" @click="choose(item)">
          <span class="result-poster">
            <img
              v-if="item.posterUrl"
              :src="item.posterUrl"
              alt=""
              loading="lazy"
              @error="($event.target as HTMLImageElement).hidden = true"
            />
            <span aria-hidden="true">暂无海报</span>
          </span>
          <span class="result-info">
            <small class="result-type"
              >{{ item.mediaType === "movie" ? "电影" : "剧集" }} · {{ item.releaseYear ?? "年份未知" }}</small
            >
            <strong>{{ item.title }}</strong>
            <small v-if="item.originalTitle && item.originalTitle !== item.title">{{ item.originalTitle }}</small>
            <small>TMDB {{ item.tmdbId }}</small>
          </span>
          <span class="choice">选择<SvgIcon type="mdi" :path="mdiChevronRight" :size="17" aria-hidden="true" /></span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped src="./MediaRequestPicker.css"></style>
