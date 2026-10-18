<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import { mdiClose, mdiDatabaseCheckOutline, mdiFilmstrip, mdiFolderOutline, mdiLinkVariant } from "@mdi/js";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { useDialogFocus } from "../composables/useDialogFocus";
import type { LibraryItem } from "../types";

interface AdminWorkGroup {
  key: string;
  title: string;
  year: number | null;
  isTv: boolean;
  posterPath: string | null;
  tags: string[];
  resolution: string | null;
  items: LibraryItem[];
}

interface MediaItemRow {
  id: number;
  tmdbId: number | null;
  mediaType: "movie" | "tv";
  title: string;
  originalTitle: string | null;
  releaseYear: number | null;
  overview: string | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  genres: string[];
  seasonCount: number | null;
  episodeCount: number | null;
  tmdbPayload?: Record<string, unknown>;
}

const props = defineProps<{
  group: AdminWorkGroup;
  rootId: string;
  posterUrl?: string | null;
}>();
const emit = defineEmits<{ close: []; bound: [] }>();

const bindTmdbId = ref("");
const binding = ref(false);
const bindMessage = ref("");
const searchQuery = ref("");
const searchResults = ref<
  Array<{
    tmdbId: number;
    mediaType: string;
    title: string;
    releaseYear: number | null;
    posterUrl: string | null;
    originalTitle?: string | null;
    overview?: string | null;
  }>
>([]);
const searching = ref(false);
const searchMessage = ref("");
const showAllResults = ref(false);

const focus = useDialogFocus(() => emit("close"));
const dialogSurface = focus.surface;
const media = ref<MediaItemRow | null>(null);
const mediaLoading = ref(false);
const posterFailed = ref(false);

const matched = computed(
  () => media.value != null || props.group.items.some((item) => item.recognitionStatus === "matched"),
);
const mediaItemId = computed(() => props.group.items.find((item) => item.mediaItemId)?.mediaItemId ?? null);
const mediaCast = computed(() => {
  const value = media.value?.tmdbPayload?.cast;
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
});
const mediaDirectors = computed(() => {
  const value = media.value?.tmdbPayload?.directors;
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
});
const mediaVote = computed(() => {
  const value = media.value?.tmdbPayload?.voteAverage;
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "";
});
const episodeLabel = (item: LibraryItem): string => {
  const identity = item.identity;
  if (identity.numberingMode === "seasonal") {
    const episodes = [...new Set(identity.episodeNumbers)].sort((a, b) => a - b);
    return `S${identity.parsedSeason ?? identity.physicalSeason ?? "?"} · ${episodes.length ? `共 ${episodes.length} 集` : "无集号"}`;
  }
  if (identity.numberingMode === "absolute") return `绝对编号 · 共 ${identity.absoluteEpisodeNumbers.length} 集`;
  return props.group.isTv ? "未读取到分集信息" : "电影";
};

/** 作品文件夹路径（首条目的父目录），便于按"一个作品文件夹"整体绑定。 */
const groupFolder = computed(() => {
  const path = props.group.items[0]?.relativePath ?? "";
  const parts = path.split("/");
  return parts.slice(0, -1).join("/") || path;
});

onMounted(() => {
  document.body.style.overflow = "hidden";
  focus.activate();
  if (mediaItemId.value) {
    mediaLoading.value = true;
    void fetch(`/api/library/media/${mediaItemId.value}`, { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) return null;
        const body = (await response.json()) as { item?: MediaItemRow };
        media.value = body.item ?? null;
      })
      .catch(() => undefined)
      .finally(() => {
        mediaLoading.value = false;
      });
  }
});
onBeforeUnmount(() => {
  document.body.style.overflow = "";
  focus.deactivate();
});

async function bindTmdb() {
  const databaseId = props.group.items.find((item) => item.databaseId)?.databaseId;
  const tmdbId = Number(bindTmdbId.value.trim());
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    bindMessage.value = "请输入有效的 TMDB ID";
    return;
  }
  binding.value = true;
  bindMessage.value = "";
  try {
    const response = await fetch("/api/library/bind-unresolved", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        databaseId,
        tmdbId,
        // 扫描会重建 library_items：带上目录 id + 相对路径，旧快照也能定位到行。
        rootId: props.rootId,
        relativePath: props.group.items[0]?.relativePath,
      }),
    });
    if (!response.ok) throw new Error("bind_failed");
    const body = (await response.json()) as { linked: number };
    bindMessage.value = `绑定成功（关联 ${body.linked} 条）`;
    emit("bound");
  } catch {
    bindMessage.value = "绑定失败，请确认 TMDB ID 是否正确";
  } finally {
    binding.value = false;
  }
}

/** 管理端 TMDB 图片走服务端代理（解决直连 image.tmdb.org 破图）。 */
function adminImageUrl(url: string | null | undefined): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return url ?? null;
  return `/api/library/tmdb-image?url=${encodeURIComponent(url)}&v=1`;
}

async function searchTmdb() {
  const q = searchQuery.value.trim();
  if (!q || searching.value) return;
  searching.value = true;
  searchMessage.value = "";
  try {
    const response = await fetch(`/api/public/tmdb/search?q=${encodeURIComponent(q)}`, { credentials: "include" });
    if (!response.ok) throw new Error("search_failed");
    const body = (await response.json()) as { results?: typeof searchResults.value };
    searchResults.value = (body.results ?? []).slice(0, 20);
    showAllResults.value = false;
    if (!searchResults.value.length) searchMessage.value = "没有找到结果，换个关键词再试。";
  } catch {
    searchMessage.value = "搜索失败，请稍后再试";
  } finally {
    searching.value = false;
  }
}

async function bindResult(tmdbId: number) {
  bindTmdbId.value = String(tmdbId);
  await bindTmdb();
}
</script>

<template>
  <div ref="dialogSurface" class="detail-layer" @click.self="emit('close')" @keydown="focus.onKeydown">
    <section class="detail-sheet" role="dialog" aria-modal="true" :aria-label="`${group.title} 管理详情`">
      <button type="button" class="detail-close" aria-label="关闭详情" @click="emit('close')">
        <SvgIcon type="mdi" :path="mdiClose" :size="20" />
      </button>

      <div class="hero" :class="{ 'hero-fallback': !posterUrl || posterFailed }">
        <img v-if="posterUrl && !posterFailed" :src="posterUrl" alt="" @error="posterFailed = true" />
        <div class="hero-wash" aria-hidden="true"></div>
        <div class="hero-badges">
          <span v-if="media?.tmdbId" class="hero-tmdb">TMDB ID {{ media.tmdbId }}</span>
        </div>
      </div>

      <div class="content">
        <div class="title-row">
          <div class="poster-wrap">
            <img
              v-if="posterUrl && !posterFailed"
              :src="posterUrl"
              :alt="`${group.title} 海报`"
              @error="posterFailed = true"
            />
            <span v-else class="poster-fallback">{{ group.title.slice(0, 1) }}</span>
          </div>
          <div class="title-main">
            <span class="pill" :class="{ unmatched: !matched }">{{ matched ? "已匹配 TMDB" : "未匹配 TMDB" }}</span>
            <h2>{{ group.title }}</h2>
            <p class="meta">
              {{ group.year ?? "年份未知" }} · {{ group.isTv ? "剧集" : "电影" }} · {{ group.items.length }} 个条目
            </p>
            <p v-if="groupFolder" class="folder-path" :title="groupFolder">
              <SvgIcon type="mdi" :path="mdiFolderOutline" :size="12" />{{ groupFolder }}
            </p>
          </div>
        </div>

        <!-- TMDB 匹配情况 -->
        <section class="info-section">
          <h3><SvgIcon type="mdi" :path="mdiFilmstrip" :size="17" />TMDB 匹配情况</h3>
          <template v-if="media">
            <div v-if="media.genres?.length" class="chips">
              <span v-for="genre in media.genres" :key="genre" class="chip">{{ genre }}</span>
            </div>
            <p v-if="media.overview" class="overview">{{ media.overview }}</p>
            <dl class="info-grid">
              <div>
                <dt>TMDB ID</dt>
                <dd>{{ media.tmdbId ?? "—" }}</dd>
              </div>
              <div>
                <dt>媒体条目 ID</dt>
                <dd>{{ media.id }}</dd>
              </div>
              <div>
                <dt>评分</dt>
                <dd>{{ mediaVote || "—" }}</dd>
              </div>
              <div>
                <dt>原名</dt>
                <dd>{{ media.originalTitle || "—" }}</dd>
              </div>
              <div>
                <dt>年份</dt>
                <dd>{{ media.releaseYear ?? "—" }}</dd>
              </div>
              <div v-if="mediaDirectors.length">
                <dt>导演</dt>
                <dd>{{ mediaDirectors.slice(0, 3).join(" / ") }}</dd>
              </div>
              <div v-if="mediaCast.length">
                <dt>主演</dt>
                <dd>{{ mediaCast.slice(0, 4).join(" / ") }}</dd>
              </div>
            </dl>
          </template>
          <p v-else-if="mediaLoading" class="loading-hint" role="status">正在读取媒体条目…</p>
          <p v-else class="loading-hint">
            {{
              matched
                ? "已匹配，但媒体条目未返回（可能已被清理）"
                : "尚未匹配到 TMDB 元数据，等待后台自动补齐或手动绑定。"
            }}
          </p>
          <div v-if="!media && !mediaLoading" class="bind-box">
            <div class="tmdb-search">
              <input
                v-model="searchQuery"
                type="search"
                placeholder="按片名搜索 TMDB…"
                aria-label="按片名搜索 TMDB"
                @keydown.enter="searchTmdb"
              />
              <button type="button" :disabled="searching" @click="searchTmdb">
                {{ searching ? "搜索中…" : "搜索" }}
              </button>
            </div>
            <ul v-if="searchResults.length" class="tmdb-results" role="listbox">
              <li v-for="item in showAllResults ? searchResults : searchResults.slice(0, 10)" :key="item.tmdbId">
                <button type="button" class="tmdb-result" @click="bindResult(item.tmdbId)">
                  <span class="tr-poster">
                    <img
                      v-if="item.posterUrl"
                      :src="adminImageUrl(item.posterUrl)!"
                      :alt="`${item.title} 海报`"
                      loading="lazy"
                    />
                    <i v-else aria-hidden="true">{{ item.title.slice(0, 1) }}</i>
                  </span>
                  <span class="tr-main">
                    <span class="tr-title"
                      >{{ item.title }}<small v-if="item.releaseYear">（{{ item.releaseYear }}）</small></span
                    >
                    <span class="tr-overview">{{ item.overview || "暂无简介" }}</span>
                  </span>
                  <span class="tr-meta">{{ item.mediaType === "tv" ? "剧集" : "电影" }} · TMDB {{ item.tmdbId }}</span>
                </button>
              </li>
            </ul>
            <button
              v-if="searchResults.length > 10"
              type="button"
              class="more-results"
              @click="showAllResults = !showAllResults"
            >
              {{ showAllResults ? "收起结果" : `查看全部 ${searchResults.length} 条` }}
            </button>
            <p v-if="searchMessage" class="bind-note" role="status">{{ searchMessage }}</p>
            <div class="bind-divider">或直接输入 TMDB ID</div>
            <div class="tmdb-search">
              <input
                v-model="bindTmdbId"
                type="number"
                inputmode="numeric"
                placeholder="TMDB ID（例如 15909）"
                aria-label="TMDB ID"
                @keydown.enter="bindTmdb"
              />
              <button type="button" :disabled="binding" @click="bindTmdb">
                {{ binding ? "绑定中…" : "按 ID 绑定" }}
              </button>
            </div>
            <small v-if="bindMessage" role="status">{{ bindMessage }}</small>
          </div>
        </section>

        <!-- 本地库存 -->
        <section class="info-section">
          <h3>
            <SvgIcon type="mdi" :path="mdiDatabaseCheckOutline" :size="17" />本地库存（{{ group.items.length }} 个文件）
          </h3>
          <div class="tag-row">
            <span v-if="group.resolution" class="chip">{{ group.resolution }}</span>
            <span
              v-for="tag in group.tags.filter((t) => t !== group.resolution).slice(0, 10)"
              :key="tag"
              class="chip"
              >{{ tag }}</span
            >
          </div>
          <ul class="file-list">
            <li v-for="item in group.items" :key="item.relativePath">
              <div class="file-main">
                <code>{{ item.relativePath }}</code>
                <small v-if="item.recognitionStatus === 'matched'"
                  ><SvgIcon type="mdi" :path="mdiLinkVariant" :size="12" />已匹配</small
                >
                <small v-else>未匹配</small>
              </div>
              <span class="file-meta">{{ episodeLabel(item) }}</span>
            </li>
          </ul>
        </section>
      </div>
    </section>
  </div>
</template>

<style scoped>
.detail-layer {
  position: fixed;
  z-index: 130;
  inset: 0;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 0;
  background: rgb(0 4 7 / 72%);
  backdrop-filter: blur(6px);
}
.detail-sheet {
  position: relative;
  width: 100%;
  max-width: 780px;
  max-height: 92dvh;
  overflow-y: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--line-strong);
  border-bottom: 0;
  border-radius: 22px 22px 0 0;
  background: linear-gradient(180deg, #0e1b24, #09131a);
  box-shadow: var(--shadow-lg);
  padding-bottom: env(safe-area-inset-bottom);
}
.detail-close {
  position: sticky;
  z-index: 3;
  top: max(12px, env(safe-area-inset-top));
  float: right;
  margin: 10px 10px -46px 0;
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border: 1px solid #42515a;
  border-radius: 50%;
  color: #fff;
  background: rgb(4 12 18 / 82%);
  cursor: pointer;
}
.hero {
  position: relative;
  height: 150px;
  overflow: hidden;
  background: linear-gradient(180deg, #12212c, #0d1921);
}
.hero img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center 25%;
  display: block;
  filter: blur(6px) brightness(0.72) saturate(1.1);
  transform: scale(1.12);
}
.hero-wash {
  position: absolute;
  inset: 0;
  background: linear-gradient(to bottom, rgb(9 19 26 / 22%) 0%, transparent 35%, rgb(9 19 26 / 72%) 78%, #0e1b24 100%);
}
.hero-badges {
  position: absolute;
  right: 14px;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.hero-tmdb {
  display: inline-flex;
  align-items: center;
  padding: 5px 10px;
  border: 1px solid rgb(255 255 255 / 18%);
  border-radius: 999px;
  color: #d8e0e5;
  background: rgb(4 12 18 / 82%);
  font-size: 12px;
  font-weight: 700;
  box-shadow: 0 8px 22px rgb(0 0 0 / 32%);
}
.content {
  position: relative;
  display: grid;
  gap: 14px;
  padding: 0 18px 22px;
}
.title-row {
  display: flex;
  gap: 14px;
  margin-top: -42px;
  align-items: flex-end;
}
.poster-wrap {
  flex: none;
  width: 96px;
  aspect-ratio: 2 / 3;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid rgb(255 255 255 / 14%);
  background: #0a1218;
  box-shadow: 0 14px 30px rgb(0 0 0 / 48%);
}
.poster-wrap img,
.poster-fallback {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.poster-fallback {
  display: grid;
  place-items: center;
  font-size: 30px;
  font-weight: 800;
  color: #3a5a6d;
  background: linear-gradient(160deg, #163244, #0b1a26);
}
.title-main {
  display: grid;
  gap: 4px;
  min-width: 0;
  padding-bottom: 2px;
}
.pill {
  justify-self: start;
  padding: 3px 9px;
  border-radius: 999px;
  color: #8fd0a0;
  background: rgb(18 43 28 / 86%);
  font-size: 11px;
  font-weight: 750;
}
.pill.unmatched {
  color: #e6c06a;
  background: rgb(55 44 16 / 86%);
}
.title-main h2 {
  margin: 0;
  font-size: 21px;
  line-height: 1.25;
  overflow-wrap: anywhere;
}
.meta {
  margin: 0;
  color: var(--text-dim);
  font-size: 12px;
}
.info-section {
  display: grid;
  gap: 10px;
}
.info-section h3 {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  color: var(--text);
  font-size: 14px;
  font-weight: 750;
}
.overview {
  margin: 0;
  color: var(--text-dim);
  font-size: 13px;
  line-height: 1.75;
}
.loading-hint {
  margin: 0;
  color: var(--text-faint);
  font-size: 12px;
}
.bind-box {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.bind-box input {
  flex: 1;
  min-width: 140px;
  min-height: 38px;
  padding: 0 11px;
  border: 1px solid #22343e;
  border-radius: 9px;
  color: var(--text);
  background: #0d1921;
}
.bind-box button {
  min-height: 38px;
  padding: 0 14px;
  border: 1px solid #3e6b48;
  border-radius: 9px;
  color: #b9e8bb;
  background: #10241b;
  cursor: pointer;
}
.bind-box button:disabled {
  opacity: 0.6;
}
.bind-box small {
  flex-basis: 100%;
  color: #9aa6ae;
  font-size: 12px;
}
.folder-path {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #7f8e97;
  font-size: 11px;
}
.folder-path svg {
  flex: none;
  color: #5f7480;
}
.tmdb-search {
  display: flex;
  gap: 8px;
  min-width: 0;
  flex: 1 1 100%;
}
.tmdb-search input {
  flex: 1;
  min-width: 0;
  min-height: 38px;
  padding: 0 11px;
  border: 1px solid #22343e;
  border-radius: 9px;
  color: var(--text);
  background: #0d1921;
}
.tmdb-search button {
  min-height: 38px;
  padding: 0 14px;
  border: 1px solid #3e6b48;
  border-radius: 9px;
  color: #b9e8bb;
  background: #10241b;
  cursor: pointer;
}
.tmdb-results {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
  flex-basis: 100%;
}
.tmdb-result {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid #1e303a;
  border-radius: 9px;
  color: var(--text);
  background: #0d1921;
  cursor: pointer;
  text-align: left;
  font-size: 12px;
  transition:
    border-color 0.18s,
    background 0.18s;
}
.tmdb-result:hover {
  border-color: #4d9b51;
  background: #12241c;
}
.tr-poster {
  flex: none;
  width: 38px;
  aspect-ratio: 2 / 3;
  border-radius: 5px;
  overflow: hidden;
  background: #0a1218;
}
.tr-poster img,
.tr-poster i {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: grid;
  place-items: center;
  font-style: normal;
  font-weight: 800;
  color: #3a5a6d;
  background: linear-gradient(160deg, #163244, #0b1a26);
  font-size: 15px;
}
.tr-main {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 3px;
}
.tr-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 700;
}
.tr-title small {
  color: #7f8e97;
  margin-left: 6px;
  font-weight: 500;
}
.tr-overview {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  color: #7f8e97;
  font-size: 11px;
  line-height: 1.5;
}
.tr-meta {
  flex: none;
  color: #7f8e97;
  font-size: 11px;
}
.more-results {
  min-height: 34px;
  padding: 0 14px;
  width: auto;
  margin: 0;
  border: 1px dashed #3a4b58;
  border-radius: 999px;
  color: #7ea1e8;
  background: #0d141c;
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 0.18s,
    color 0.18s;
}
.more-results:hover {
  border-color: #5d86c9;
  color: #b8d3ff;
}
.bind-note {
  flex-basis: 100%;
  margin: 0;
  color: #e6c06a;
  font-size: 12px;
}
.bind-divider {
  flex-basis: 100%;
  margin: 4px 0;
  display: flex;
  align-items: center;
  gap: 8px;
  color: #5f7480;
  font-size: 11px;
}
.bind-divider::after {
  content: "";
  height: 1px;
  flex: 1;
  background: #1e303a;
}
.chips,
.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  padding: 3px 9px;
  border: 1px solid #2a3d48;
  border-radius: 999px;
  color: #aab8c0;
  background: #0d1921;
  font-size: 11px;
}
.info-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  margin: 0;
  overflow: hidden;
  border: 1px solid #1e303a;
  border-radius: 10px;
  background: #1e303a;
}
.info-grid > div {
  display: grid;
  gap: 3px;
  padding: 11px 12px;
  background: #0d1921;
}
.info-grid dt {
  color: #81909b;
  font-size: 11px;
}
.info-grid dd {
  margin: 0;
  color: var(--text);
  font-size: 13px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-list {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  max-height: 230px;
  overflow-y: auto;
  list-style: none;
}
.file-list li {
  display: grid;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid #1e303a;
  border-radius: 8px;
  background: #0d1921;
}
.file-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}
.file-main code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #b9c5cb;
  font-size: 12px;
}
.file-main small {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
  color: #8fd0a0;
  font-size: 11px;
}
.file-meta {
  color: #7f8e97;
  font-size: 11px;
}
@media (min-width: 720px) {
  .detail-layer {
    align-items: center;
    padding: 28px;
  }
  .detail-sheet {
    border-bottom: 1px solid var(--line-strong);
    border-radius: 18px;
    max-height: 86dvh;
  }
  .hero {
    height: 210px;
  }
  .content {
    gap: 16px;
    padding: 0 26px 30px;
  }
  .poster-wrap {
    width: 128px;
  }
  .title-row {
    margin-top: -66px;
  }
  .title-main h2 {
    font-size: 26px;
  }
  .info-grid {
    grid-template-columns: repeat(4, 1fr);
  }
}
</style>
<style scoped src="./LibraryAdminDetailDialog.mobile.css"></style>
