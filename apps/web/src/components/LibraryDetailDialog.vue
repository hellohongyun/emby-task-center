<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import { mdiClose, mdiDatabaseCheckOutline, mdiFilmstrip, mdiOpenInNew, mdiPlay, mdiStar } from "@mdi/js";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { useDialogFocus } from "../composables/useDialogFocus";
import { useLibraryPortal, type PublicLibraryItem, type TmdbDetail } from "../composables/useLibraryPortal";

const props = defineProps<{
  item: PublicLibraryItem;
  loading?: boolean;
}>();
const emit = defineEmits<{ close: [] }>();

const library = useLibraryPortal();
const focus = useDialogFocus(() => emit("close"));
const dialogSurface = focus.surface;
const posterFailed = ref(false);
const heroBackdropFailed = ref(false);
const heroPosterFailed = ref(false);
const tmdb = ref<TmdbDetail | null>(null);
const tmdbLoading = ref(false);

const isTv = computed(() => props.item.mediaType === "tv");
const isUnresolved = computed(() => props.item.status === "unresolved");

const heroSource = computed(() => {
  if (props.item.backdropUrl && !heroBackdropFailed.value) return props.item.backdropUrl;
  if (props.item.posterUrl && !heroPosterFailed.value && !posterFailed.value) return props.item.posterUrl;
  return null;
});
function heroError() {
  if (props.item.backdropUrl && !heroBackdropFailed.value) {
    heroBackdropFailed.value = true;
  } else if (props.item.posterUrl) {
    heroPosterFailed.value = true;
  }
}

const metaParts = computed(() => {
  const parts: string[] = [];
  if (props.item.year) parts.push(String(props.item.year));
  parts.push(isTv.value ? "剧集" : "电影");
  if (props.item.fileCount && props.item.fileCount > 0)
    parts.push(isTv.value ? `已入库 ${props.item.fileCount} 集` : `${props.item.fileCount} 个文件`);
  if (props.item.resolution) parts.push(props.item.resolution);
  return parts;
});

const localStats = computed(() => {
  const list: Array<{ label: string; value: string }> = [];
  list.push({ label: "入库状态", value: "已入库" });
  list.push({ label: "匹配状态", value: isUnresolved.value ? "未匹配 TMDB" : "已匹配 TMDB" });
  list.push({ label: isTv.value ? "已入库集数" : "文件数", value: String(props.item.fileCount ?? 1) });
  if (props.item.resolution) list.push({ label: "画质", value: props.item.resolution });
  if (props.item.languages?.length) list.push({ label: "语言", value: props.item.languages.slice(0, 3).join(" / ") });
  if (props.item.regions?.length) list.push({ label: "地区", value: props.item.regions.slice(0, 3).join(" / ") });
  if (isTv.value && props.item.seasonCount != null) list.push({ label: "季数", value: String(props.item.seasonCount) });
  if (isTv.value && props.item.episodeCount != null)
    list.push({ label: "总集数", value: String(props.item.episodeCount) });
  return list;
});

const runtimeText = computed(() => {
  const minutes = tmdb.value?.runtime;
  if (!minutes || minutes <= 0) return "—";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours} 小时 ${rest} 分钟` : `${rest} 分钟`;
});

const statusText = computed(() => {
  const status = tmdb.value?.status;
  if (!status) return "—";
  const map: Record<string, string> = {
    Released: "已上映",
    "Returning Series": "连载中",
    Ended: "已完结",
    Canceled: "已取消",
    "In Production": "制作中",
    Planned: "计划中",
    Pilot: "试播",
  };
  return map[status] ?? status;
});

const ratingText = computed(() => (tmdb.value?.voteAverage ? tmdb.value.voteAverage.toFixed(1) : ""));
const tmdbIdText = computed(() => props.item.tmdbId ?? null);
const hasBackdrop = computed(() => Boolean(props.item.backdropUrl && !heroBackdropFailed.value));

watch(
  () => [props.item.id, props.item.mediaType, props.item.tmdbId] as const,
  async ([, mediaType, tmdbId], _previous, onCleanup) => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    tmdb.value = null;
    tmdbLoading.value = Boolean(tmdbId);
    if (!tmdbId) return;
    try {
      const result = await library.tmdbDetails(mediaType, tmdbId, controller.signal);
      if (!controller.signal.aborted) tmdb.value = result;
    } finally {
      if (!controller.signal.aborted) tmdbLoading.value = false;
    }
  },
  { immediate: true },
);

onMounted(() => {
  document.body.style.overflow = "hidden";
  focus.activate();
});
onBeforeUnmount(() => {
  document.body.style.overflow = "";
  focus.deactivate();
});

function tmdbUrl(): string | null {
  if (!props.item.tmdbId) return null;
  return `https://www.themoviedb.org/${isTv.value ? "tv" : "movie"}/${props.item.tmdbId}`;
}
</script>

<template>
  <div ref="dialogSurface" class="detail-layer" @click.self="emit('close')" @keydown="focus.onKeydown">
    <section class="detail-sheet" role="dialog" aria-modal="true" :aria-label="`${item.title} 详情`">
      <button type="button" class="detail-close" aria-label="关闭详情" @click="emit('close')">
        <SvgIcon type="mdi" :path="mdiClose" :size="20" />
      </button>

      <div class="hero" :class="{ 'hero-fallback': !heroSource }">
        <img v-if="heroSource" :src="heroSource" alt="" :class="{ 'hero-blur': !hasBackdrop }" @error="heroError" />
        <div class="hero-wash" aria-hidden="true"></div>
        <div class="hero-badges">
          <span v-if="tmdbIdText" class="hero-tmdb">TMDB ID {{ tmdbIdText }}</span>
          <span v-if="ratingText" class="hero-rating">
            <SvgIcon type="mdi" :path="mdiStar" :size="14" />{{ ratingText }}
          </span>
        </div>
      </div>

      <div class="content">
        <div class="title-row">
          <div class="poster-wrap">
            <img
              v-if="item.posterUrl && !posterFailed"
              :src="item.posterUrl"
              :alt="`${item.title} 海报`"
              @error="posterFailed = true"
            />
            <span v-else class="poster-fallback" :class="{ unresolved: isUnresolved }">{{
              item.title.slice(0, 1)
            }}</span>
          </div>
          <div class="title-main">
            <span class="pill" :class="{ unresolved: isUnresolved }">
              {{ isUnresolved ? "已入库 · 未匹配" : isTv ? "剧集" : "电影" }}
            </span>
            <h2>{{ item.title }}</h2>
            <p v-if="item.originalTitle && item.originalTitle !== item.title" class="original-title">
              {{ item.originalTitle }}
            </p>
            <p class="meta">{{ metaParts.join(" · ") }}</p>
          </div>
        </div>

        <!-- TMDB 资料 -->
        <section v-if="tmdb || item.overview || tmdbLoading" class="info-section">
          <h3><SvgIcon type="mdi" :path="mdiFilmstrip" :size="17" />TMDB 详情</h3>
          <p v-if="item.overview" class="overview">{{ item.overview }}</p>
          <p v-else-if="tmdb?.overview" class="overview">{{ tmdb.overview }}</p>
          <p v-if="tmdbLoading && !tmdb" class="loading-hint" role="status">正在加载 TMDB 详情…</p>
          <div v-if="tmdb?.genres?.length" class="chips" aria-label="题材标签">
            <span v-for="genre in tmdb.genres" :key="genre" class="chip">{{ genre }}</span>
          </div>
          <dl v-if="tmdb" class="info-grid">
            <div>
              <dt>TMDB ID</dt>
              <dd>{{ tmdbIdText ?? "—" }}</dd>
            </div>
            <div v-if="tmdb.originalTitle">
              <dt>原作名</dt>
              <dd>{{ tmdb.originalTitle }}</dd>
            </div>
            <div>
              <dt>评分</dt>
              <dd>{{ ratingText || "—" }}</dd>
            </div>
            <div>
              <dt>时长</dt>
              <dd>{{ runtimeText }}</dd>
            </div>
            <div>
              <dt>状态</dt>
              <dd>{{ statusText }}</dd>
            </div>
            <div v-if="tmdb.directors?.length">
              <dt>导演</dt>
              <dd>{{ tmdb.directors.slice(0, 2).join(" / ") }}</dd>
            </div>
            <div v-if="tmdb.cast?.length">
              <dt>主演</dt>
              <dd>{{ tmdb.cast.slice(0, 3).join(" / ") }}</dd>
            </div>
          </dl>
        </section>

        <!-- 本地库存 -->
        <section class="info-section local-section">
          <h3><SvgIcon type="mdi" :path="mdiDatabaseCheckOutline" :size="17" />本地入库信息</h3>
          <dl class="info-grid">
            <div v-for="stat in localStats" :key="stat.label">
              <dt>{{ stat.label }}</dt>
              <dd>{{ stat.value }}</dd>
            </div>
          </dl>
        </section>

        <p v-if="isUnresolved" class="info-line">该片源已入库，尚未匹配到 TMDB 元数据；不影响正常观看。</p>
        <p v-if="loading" class="loading-hint" role="status">正在补充详细资料…</p>

        <div class="actions">
          <a v-if="item.watchUrl" class="primary" :href="item.watchUrl" target="_blank" rel="noopener">
            <SvgIcon type="mdi" :path="mdiPlay" :size="17" />去观看
          </a>
          <a v-if="tmdbUrl()" class="ghost" :href="tmdbUrl()!" target="_blank" rel="noopener">
            TMDB<SvgIcon type="mdi" :path="mdiOpenInNew" :size="14" />
          </a>
        </div>
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
  background:
    radial-gradient(420px 160px at 30% 0%, rgb(60 110 140 / 28%), transparent 70%),
    linear-gradient(180deg, #12212c, #0d1921);
}
.hero img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center 25%;
  display: block;
}
.hero img.hero-blur {
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
.hero-rating {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border-radius: 999px;
  color: #07120d;
  background: linear-gradient(180deg, #f0c96b, #d8a844);
  font-size: 12px;
  font-weight: 800;
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
.poster-fallback.unresolved {
  color: #c8a054;
  background: linear-gradient(160deg, #2b2417, #191510);
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
.pill.unresolved {
  color: #e6c06a;
  background: rgb(55 44 16 / 86%);
}
.title-main h2 {
  margin: 0;
  font-size: 21px;
  line-height: 1.25;
  overflow-wrap: anywhere;
}
.original-title {
  margin: 0;
  color: var(--text-faint);
  font-size: 12px;
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
  max-height: 7.2em;
  overflow: hidden;
}
.overview.muted {
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.6;
}
.loading-hint {
  margin: 0;
  color: var(--text-faint);
  font-size: 12px;
}

.chips {
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

.info-line {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid #2c3e4b;
  border-radius: 9px;
  color: #9aa9b2;
  background: rgb(13 25 33 / 72%);
  font-size: 12px;
  line-height: 1.6;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
  padding-top: 2px;
}
.actions .primary,
.actions .ghost {
  min-height: 42px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 0 16px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 700;
  text-decoration: none;
  cursor: pointer;
}
.primary {
  border: 0;
  color: #eaf6ea;
  background: linear-gradient(180deg, #3170b8, #245a95);
  box-shadow: 0 8px 22px rgb(36 90 149 / 26%);
}
.ghost {
  border: 1px solid var(--line-strong);
  color: #cdd6dc;
  background: #14202b;
}
.ghost:hover {
  border-color: #3f5a6b;
  background: #182836;
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
    grid-template-columns: repeat(3, 1fr);
  }
}
</style>
