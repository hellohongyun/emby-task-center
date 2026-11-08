<script setup lang="ts">
import { ref } from "vue";
import { useMediaRequestApi } from "../composables/media-request-api";
import type { RequestMedia } from "../composables/media-request-types";

defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ select: [media: RequestMedia | null] }>();
const api = useMediaRequestApi();
const query = ref("");
const results = ref<RequestMedia[]>([]);
const searched = ref(false);
const selected = ref<RequestMedia | null>(null);
let revision = 0;
function changeSelection() {
  revision++;
  api.cancel();
  selected.value = null;
  emit("select", null);
}
async function search() {
  if (!query.value.trim()) return;
  const current = ++revision;
  api.cancel("details");
  selected.value = null;
  emit("select", null);
  results.value = [];
  searched.value = false;
  const result = await api.run<{ results: RequestMedia[] }>(
    "search",
    `/api/public/tmdb/search?q=${encodeURIComponent(query.value.trim())}`,
  );
  if (result && current === revision) {
    results.value = result.results;
    searched.value = true;
  }
}
async function choose(media: RequestMedia) {
  const current = ++revision;
  selected.value = null;
  emit("select", null);
  const result = await api.run<{ result: RequestMedia }>(
    "details",
    `/api/public/tmdb/details?type=${media.mediaType}&id=${media.tmdbId}`,
  );
  if (result && current === revision) {
    selected.value = result.result;
    emit("select", result.result);
  }
}
</script>

<template>
  <section class="request-picker" aria-label="选择求片作品">
    <div v-if="selected" class="selection-bar">
      <span><i aria-hidden="true">✓</i>已选择作品</span>
      <button type="button" :disabled="disabled" @click="changeSelection">更换作品</button>
    </div>
    <template v-else>
      <form class="search" @submit.prevent="search">
        <label
          >搜索作品<input
            v-model="query"
            type="search"
            maxlength="200"
            placeholder="输入想看的电影或剧名"
            :disabled="disabled"
            required
        /></label>
        <button type="submit" :disabled="disabled || api.busy.value.search">
          {{ api.busy.value.search ? "搜索中…" : "搜索" }}
        </button>
      </form>
      <p v-if="api.error.value" class="picker-error" role="alert">{{ api.error.value }}</p>
      <p v-if="api.busy.value.details" class="picker-notice" role="status">正在核对作品和分季资料…</p>
      <div
        v-if="!searched && !api.busy.value.search && !api.busy.value.details && !api.error.value"
        class="search-empty"
      >
        <span aria-hidden="true">⌕</span><strong>想看什么，搜一下</strong>
        <p>找到作品后，请核对海报、年份和名称，避免选到同名作品。</p>
      </div>
      <p v-if="searched && !results.length" class="picker-notice">未找到作品，请换一个片名搜索。</p>
      <div v-if="results.length" class="results-heading">
        <strong>选择对应作品</strong><span>{{ results.length }} 个结果</span>
      </div>
      <ul v-if="results.length" class="results">
        <li v-for="item in results" :key="`${item.mediaType}:${item.tmdbId}`">
          <button type="button" :disabled="disabled || api.busy.value.details" @click="choose(item)">
            <span class="result-poster"
              ><img
                v-if="item.posterUrl"
                :src="item.posterUrl"
                alt=""
                loading="lazy"
                @error="($event.target as HTMLImageElement).hidden = true"
              /><span aria-hidden="true">暂无海报</span></span
            >
            <span class="result-info"
              ><strong>{{ item.title }}</strong
              ><small>{{ item.originalTitle }}</small
              ><small
                >{{ item.releaseYear ?? "年份未知" }} · {{ item.mediaType === "movie" ? "电影" : "剧集" }} · TMDB
                {{ item.tmdbId }}</small
              ></span
            >
            <span class="choice">选择</span>
          </button>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped src="./MediaRequestPicker.css"></style>
