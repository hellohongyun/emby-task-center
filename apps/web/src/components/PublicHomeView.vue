<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import { mdiDownload, mdiFire, mdiMagnify, mdiPlay, mdiStar, mdiTrendingUp } from "@mdi/js";
import { computed, onMounted, ref } from "vue";

import { useTrending, type TrendingItem } from "../composables/useTrending";
import { useLibraryPortal } from "../composables/useLibraryPortal";
import { useTrendingDetails } from "../composables/useTrendingDetails";
import { usePortalSession } from "../composables/usePortalSession";

const emit = defineEmits<{
  navigate: [view: "profile" | "library"];
  search: [query: string];
}>();

const s = usePortalSession();
const trending = useTrending();
const library = useLibraryPortal();
const selected = ref<TrendingItem | null>(null);
const localSearch = ref("");
const { libraryStatus, checkingLibrary, checkingOverview } = useTrendingDetails(selected);
const activeSource = ref<string>("all");

/** 完整榜单弹层：首页只放 12 部预览，点「完整榜单」看全部。 */
const PREVIEW_ITEMS = 12;
interface FullListData {
  key: string;
  label: string;
  source: string;
  items: TrendingItem[];
  updatedAt: number;
}
const fullListSection = ref<FullListData | null>(null);

onMounted(() => {
  void trending.load();
  void library.loadRecent(40);
});

function previewItems(section: FullListData): TrendingItem[] {
  return section.items.slice(0, PREVIEW_ITEMS);
}
function openFullList(section: FullListData) {
  fullListSection.value = section;
}
function closeFullList() {
  fullListSection.value = null;
}

const visibleSections = computed(() => trending.sections.value.filter((section) => section.items.length > 0));

/** 首页焦点：优先选“已在库 + 有横版背景”的作品，其次有背景图，最后取榜单第一名。 */
const featureItem = computed<TrendingItem | null>(() => {
  const items = visibleSections.value.flatMap((section) => section.items);
  return (
    items.find((item) => item.inLibrary && item.backdropUrl) ??
    items.find((item) => item.backdropUrl) ??
    items[0] ??
    null
  );
});

/** 汇总所有榜单里“已在库可看”的条目，形成首页“现在就能看”。 */
const watchableItems = computed(() => {
  const seen = new Set<string>();
  const result: TrendingItem[] = [];
  for (const section of visibleSections.value) {
    for (const item of section.items) {
      if (item.inLibrary && item.watchUrl && !seen.has(item.id)) {
        seen.add(item.id);
        result.push(item);
      }
    }
  }
  return result;
});

/** “现在就能看”按虚拟榜单展示，支持完整榜单弹层。 */
const quickWatchSection = computed<FullListData | null>(() =>
  watchableItems.value.length
    ? {
        key: "quick-watch",
        label: "现在就能看",
        source: "emby",
        items: watchableItems.value,
        updatedAt: Date.now(),
      }
    : null,
);

/** “最近入库”同样转成同款榜单，预览 + 完整榜单弹层。 */
const recentSection = computed<FullListData | null>(() =>
  library.recent.value.length
    ? {
        key: "recent-added",
        label: "最近入库",
        source: "emby",
        items: library.recent.value.map((item) => ({
          id: item.id,
          title: item.title,
          mediaType: item.mediaType,
          year: item.year,
          posterUrl: item.posterUrl,
          rating: null,
          rank: 0,
          source: "emby",
          tmdbId: item.tmdbId,
          inLibrary: true,
          watchUrl: item.watchUrl,
        })),
        updatedAt: Date.now(),
      }
    : null,
);

const totalTrendingCount = computed(() =>
  visibleSections.value.reduce((sum, section) => sum + section.items.length, 0),
);

const sourceTabs = computed(() => {
  const tabs: Array<{ key: string; label: string; count: number; source?: string }> = [
    {
      key: "all",
      label: "全部榜单",
      count: totalTrendingCount.value,
    },
  ];
  const bySource = new Map<string, { label: string; count: number }>();
  for (const section of visibleSections.value) {
    const existing = bySource.get(section.source) ?? { label: sourceLabel(section.source), count: 0 };
    existing.count += section.items.length;
    bySource.set(section.source, existing);
  }
  for (const [key, value] of bySource.entries()) {
    tabs.push({ key, ...value, source: key });
  }
  return tabs;
});

const activeSections = computed(() =>
  activeSource.value === "all"
    ? visibleSections.value
    : visibleSections.value.filter((section) => section.source === activeSource.value),
);

function sourceLabel(source: string): string {
  return { tmdb: "TMDB", imdb: "IMDB", douban: "豆瓣", emby: "本库" }[source] ?? source;
}
function platformInitial(source: string): string {
  return { tmdb: "T", imdb: "IM", douban: "豆", emby: "本" }[source] ?? source.slice(0, 2).toUpperCase();
}
function sectionKind(key: string): string {
  return (
    {
      douban_hot: "豆瓣实时热门",
      douban_top250: "影史经典 · 高分必看",
      tmdb_trending: "每日热度趋势",
      tmdb_hot: "热门推荐",
      imdb_hot: "热门推荐",
      imdb_top: "影史高分榜",
      "quick-watch": "热门榜单已入库 · 可直接看",
      "recent-added": "按 Emby 入库时间 · 刚补齐",
    }[key] ?? "热门榜单"
  );
}
function sectionIconPath(key: string): string {
  return (
    {
      douban_hot: mdiFire,
      douban_top250: mdiStar,
      tmdb_trending: mdiTrendingUp,
      tmdb_hot: mdiFire,
      imdb_hot: mdiFire,
      imdb_top: mdiStar,
      "quick-watch": mdiPlay,
      "recent-added": mdiDownload,
    }[key] ?? mdiStar
  );
}
function ratingText(item: TrendingItem): string {
  if (item.rating == null) return "";
  return item.rating.toFixed(1);
}

/** 评分带平台标识：豆瓣/TMDB/IMDB 等，让用户一眼知道评分来源。 */
function ratingWithSource(item: TrendingItem): string {
  if (item.rating == null) return "";
  return `${sourceLabel(item.source)} ${item.rating.toFixed(1)}`;
}
function mediaTypeLabel(item: TrendingItem): string {
  return item.mediaType === "tv" ? "剧集" : "电影";
}
function cardMeta(item: TrendingItem): string {
  const type = mediaTypeLabel(item);
  const parts = [item.year ? String(item.year) : "年份未知", type];
  if (item.rating != null) parts.push(`${item.rating.toFixed(1)} 分`);
  return parts.join(" · ");
}

function formatUpdatedAt(timestamp: number): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay ? `今天 ${time} 更新` : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time} 更新`;
}
function memberStatusText(status: string): string {
  return { active: "有效", expiring: "即将到期", expired: "已过期", none: "未开通" }[status] ?? status;
}
// 到期文案统一走 usePortalSession 的 memberExpiryText：自定义卡密的「到期时间名称」优先，
// 这一页不再自己拼日期（否则用户会在首页看到日期、在「我的」看到名称）。
function submitSearch() {
  const query = localSearch.value.trim();
  if (!query) return;
  emit("search", query);
  localSearch.value = "";
}
</script>

<template>
  <section class="home">
    <header class="hero">
      <div>
        <h1>影迷影视中心</h1>
        <p>发现热门影片，看看本库已入库的片子，点开即可去 Emby 观看。</p>
      </div>
    </header>

    <!-- 移动端搜索（桌面在顶栏，移动端在首页提供） -->
    <form class="home-search" role="search" @submit.prevent="submitSearch">
      <SvgIcon type="mdi" :path="mdiMagnify" :size="16" aria-hidden="true" />
      <input v-model="localSearch" type="search" enterkeyhint="search" placeholder="搜影视库 / 影片…" />
      <button type="submit">搜索</button>
    </form>

    <!-- 与我相关：登录后展示会员摘要 -->
    <section v-if="s.loggedInEmail.value" class="my-zone">
      <div class="my-card" :class="s.memberStatus.value">
        <div class="my-main">
          <b>欢迎回来，{{ s.loggedInEmail.value }}</b>
          <span class="my-meta"
            >会员：<em>{{ memberStatusText(s.memberStatus.value) }}</em> · 到期：{{ s.memberExpiryText.value
            }}<small v-if="s.memberExpiryNote.value">（{{ s.memberExpiryNote.value }}）</small></span
          >
        </div>
      </div>
    </section>

    <div v-if="trending.loading.value && !visibleSections.length" class="trending-loading" role="status">
      <span v-for="n in 3" :key="n" class="skeleton row-skeleton" />
    </div>

    <p v-else-if="trending.error.value" class="trending-error" role="alert">{{ trending.error.value }}</p>
    <div v-else-if="!visibleSections.length" class="trending-empty">
      <strong>{{ trending.refreshing.value ? "榜单正在更新" : "热门数据暂不可用" }}</strong>
      <span>{{
        trending.refreshing.value
          ? "有结果后会自动显示，也可以先逛逛影视库。"
          : "可以先逛逛影视库，看看本库已入库的片子。"
      }}</span>
      <div class="empty-actions">
        <button type="button" class="ghost" @click="emit('navigate', 'library')">去影视库</button>
      </div>
    </div>

    <template v-else>
      <!-- 今日焦点：首页视觉重心，优先展示“可看”的作品 -->
      <section
        v-if="featureItem"
        class="spotlight"
        :class="{ 'has-backdrop': featureItem.backdropUrl }"
        @click="selected = featureItem"
      >
        <div v-if="featureItem.backdropUrl" class="spotlight-bg" aria-hidden="true">
          <img :src="featureItem.backdropUrl" alt="" loading="eager" />
        </div>
        <div class="spotlight-scrim" aria-hidden="true"></div>
        <div class="spotlight-layout">
          <div class="spotlight-poster">
            <img v-if="featureItem.posterUrl" :src="featureItem.posterUrl" :alt="featureItem.title" />
            <span v-else class="feature-fallback">{{ featureItem.title.slice(0, 1) }}</span>
            <span v-if="ratingText(featureItem)" class="feature-rating">{{ ratingWithSource(featureItem) }}</span>
          </div>
          <div class="spotlight-body">
            <div class="spotlight-tags">
              <span class="source-tag" :class="`source-${featureItem.source}`"
                >本周精选 · {{ sourceLabel(featureItem.source) }}</span
              >
              <span v-if="featureItem.inLibrary" class="lib-chip on">已在库 · 可看</span>
              <span v-else-if="featureItem.inLibrary === false" class="lib-chip off">本库暂无</span>
            </div>
            <h2>{{ featureItem.title }}</h2>
            <p class="spotlight-meta">
              {{ featureItem.year ?? "" }}{{ featureItem.year ? " · " : "" }}{{ mediaTypeLabel(featureItem)
              }}{{ ratingText(featureItem) ? ` · ${ratingWithSource(featureItem)} 分` : "" }}
            </p>
            <p v-if="featureItem.overview" class="spotlight-overview">{{ featureItem.overview }}</p>
            <div class="spotlight-actions">
              <a
                v-if="featureItem.inLibrary && featureItem.watchUrl"
                :href="featureItem.watchUrl"
                target="_blank"
                rel="noopener"
                class="primary primary-link"
                @click.stop
              >
                <SvgIcon type="mdi" :path="mdiPlay" :size="15" aria-hidden="true" />去观看
              </a>
              <button type="button" class="ghost" @click.stop="selected = featureItem">查看详情</button>
            </div>
          </div>
        </div>
      </section>

      <!-- 现在就能看：与热门榜单同款卡片，支持完整榜单弹层 -->
      <section v-if="quickWatchSection" class="trend-block quick-block">
        <div class="section-head trend-head">
          <div class="section-title">
            <span class="platform-mark pm-emby" aria-hidden="true">本</span>
            <div class="section-title-text">
              <h2><SvgIcon type="mdi" :path="mdiPlay" :size="15" aria-hidden="true" />现在就能看</h2>
              <p class="section-sub">
                从豆瓣 / TMDB / IMDB 热门自动汇总 · 已入库可直接看 · {{ quickWatchSection.items.length }} 部 · 点击去
                Emby 播放
              </p>
            </div>
          </div>
          <div class="trend-head-right">
            <span class="source-tag source-emby">本库</span>
            <button
              v-if="quickWatchSection.items.length > PREVIEW_ITEMS"
              type="button"
              class="full-list-btn"
              @click="openFullList(quickWatchSection)"
            >
              完整榜单 <b>{{ quickWatchSection.items.length }}</b>
            </button>
          </div>
        </div>
        <div class="media-grid">
          <article
            v-for="item in previewItems(quickWatchSection)"
            :key="`watch-${item.id}`"
            class="media-card"
            role="button"
            tabindex="0"
            @click="selected = item"
            @keydown.enter="selected = item"
          >
            <div class="media-poster">
              <img v-if="item.posterUrl" :src="item.posterUrl" :alt="item.title" loading="lazy" />
              <span v-else class="poster-fallback">{{ item.title.slice(0, 1) }}</span>
              <span v-if="item.rank <= 10" class="rank-badge">#{{ item.rank }}</span>
              <span v-if="ratingText(item)" class="rating-badge">{{ ratingWithSource(item) }}</span>
              <span v-if="item.inLibrary === true" class="lib-badge">可看</span>
              <div class="media-hover">
                <a
                  v-if="item.inLibrary && item.watchUrl"
                  :href="item.watchUrl"
                  target="_blank"
                  rel="noopener"
                  class="hover-watch"
                  @click.stop
                >
                  <SvgIcon type="mdi" :path="mdiPlay" :size="13" aria-hidden="true" />去观看
                </a>
              </div>
            </div>
            <div class="media-info">
              <b :title="item.title">{{ item.title }}</b>
              <small>{{ cardMeta(item) }}</small>
            </div>
          </article>
        </div>
      </section>

      <!-- 榜单来源切换：避免一屏堆满多个榜单 -->
      <nav class="source-tabs" aria-label="热门榜单来源">
        <button
          v-for="tab in sourceTabs"
          :key="tab.key"
          type="button"
          :class="{ active: activeSource === tab.key }"
          @click="activeSource = tab.key"
        >
          <span v-if="tab.source" class="tab-mark" :class="`pm-${tab.source}`" aria-hidden="true">{{
            platformInitial(tab.source)
          }}</span>
          <span>{{ tab.label }}</span>
          <small>{{ tab.count }} 部</small>
        </button>
      </nav>

      <section v-for="section in activeSections" :id="`trend-${section.key}`" :key="section.key" class="trend-block">
        <div class="section-head trend-head">
          <div class="section-title">
            <span class="platform-mark" :class="`pm-${section.source}`" aria-hidden="true">{{
              platformInitial(section.source)
            }}</span>
            <div class="section-title-text">
              <h2>
                <SvgIcon type="mdi" :path="sectionIconPath(section.key)" :size="15" aria-hidden="true" />{{
                  section.label
                }}
              </h2>
              <p class="section-sub">
                {{ sectionKind(section.key) }} · {{ section.items.length }} 部 · {{ formatUpdatedAt(section.updatedAt)
                }}<template v-if="section.stale"> · 数据可能滞后</template>
              </p>
            </div>
          </div>
          <div class="trend-head-right">
            <span class="source-tag" :class="`source-${section.source}`">{{ sourceLabel(section.source) }}</span>
            <button
              v-if="section.items.length > PREVIEW_ITEMS"
              type="button"
              class="full-list-btn"
              @click="openFullList(section)"
            >
              完整榜单 <b>{{ section.items.length }}</b>
            </button>
          </div>
        </div>
        <div class="media-grid">
          <article
            v-for="item in previewItems(section)"
            :key="item.id"
            class="media-card"
            role="button"
            tabindex="0"
            @click="selected = item"
            @keydown.enter="selected = item"
          >
            <div class="media-poster">
              <img v-if="item.posterUrl" :src="item.posterUrl" :alt="item.title" loading="lazy" />
              <span v-else class="poster-fallback">{{ item.title.slice(0, 1) }}</span>
              <span v-if="item.rank <= 10" class="rank-badge">#{{ item.rank }}</span>
              <span v-if="ratingText(item)" class="rating-badge">{{ ratingWithSource(item) }}</span>
              <span v-if="item.inLibrary === true" class="lib-badge">可看</span>
              <div class="media-hover">
                <a
                  v-if="item.inLibrary && item.watchUrl"
                  :href="item.watchUrl"
                  target="_blank"
                  rel="noopener"
                  class="hover-watch"
                  @click.stop
                >
                  <SvgIcon type="mdi" :path="mdiPlay" :size="13" aria-hidden="true" />去观看
                </a>
              </div>
            </div>
            <div class="media-info">
              <b :title="item.title">{{ item.title }}</b>
              <small>{{ cardMeta(item) }}</small>
            </div>
          </article>
        </div>
      </section>
    </template>

    <!-- 最近入库：与热门榜单同款卡片，按 Emby 的入库时间排序 -->
    <section v-if="recentSection" class="trend-block recent-block">
      <div class="section-head trend-head">
        <div class="section-title">
          <span class="platform-mark pm-emby" aria-hidden="true">本</span>
          <div class="section-title-text">
            <h2><SvgIcon type="mdi" :path="mdiDownload" :size="15" aria-hidden="true" />最近入库</h2>
            <p class="section-sub">
              {{ sectionKind("recent-added") }} · {{ recentSection.items.length }} 部 · 点击直接去 Emby 看
            </p>
          </div>
        </div>
        <div class="trend-head-right">
          <span class="source-tag source-emby">本库</span>
          <button
            v-if="recentSection.items.length > PREVIEW_ITEMS"
            type="button"
            class="full-list-btn"
            @click="openFullList(recentSection)"
          >
            完整榜单 <b>{{ recentSection.items.length }}</b>
          </button>
        </div>
      </div>
      <div class="media-grid">
        <article
          v-for="item in previewItems(recentSection)"
          :key="`recent-${item.id}`"
          class="media-card"
          role="button"
          tabindex="0"
          @click="selected = item"
          @keydown.enter="selected = item"
        >
          <div class="media-poster">
            <img v-if="item.posterUrl" :src="item.posterUrl" :alt="item.title" loading="lazy" />
            <span v-else class="poster-fallback">{{ item.title.slice(0, 1) }}</span>
            <span v-if="item.inLibrary === true" class="lib-badge">可看</span>
            <div class="media-hover">
              <a
                v-if="item.inLibrary && item.watchUrl"
                :href="item.watchUrl"
                target="_blank"
                rel="noopener"
                class="hover-watch"
                @click.stop
              >
                <SvgIcon type="mdi" :path="mdiPlay" :size="13" aria-hidden="true" />去观看
              </a>
            </div>
          </div>
          <div class="media-info">
            <b :title="item.title">{{ item.title }}</b>
            <small>{{ cardMeta(item) }}</small>
          </div>
        </article>
      </div>
    </section>

    <!-- 详情弹层：点卡片先看详情，再决定去观看 -->
    <Teleport to="body">
      <div v-if="selected" class="detail-mask" @click.self="selected = null">
        <div class="detail-card" role="dialog" aria-modal="true" :aria-label="selected.title">
          <button type="button" class="detail-close" aria-label="关闭" @click="selected = null">×</button>
          <div class="detail-poster">
            <img v-if="selected.posterUrl" :src="selected.posterUrl" :alt="selected.title" />
            <span v-else class="detail-fallback">{{ selected.title.slice(0, 1) }}</span>
          </div>
          <div class="detail-body">
            <h2>{{ selected.title }}</h2>
            <p class="detail-meta">
              <template v-if="selected.year">{{ selected.year }} · </template>{{ mediaTypeLabel(selected) }} ·
              {{ sourceLabel(selected.source) }}
              <template v-if="ratingText(selected)">
                · 评分 <b>{{ ratingWithSource(selected) }}</b></template
              >
            </p>
            <p v-if="selected.originalTitle && selected.originalTitle !== selected.title" class="detail-original">
              原名：{{ selected.originalTitle }}
            </p>
            <p v-if="selected.overview" class="detail-overview">
              {{ selected.overview }}
            </p>
            <p v-if="checkingOverview" class="detail-checking">正在加载影片简介…</p>
            <p v-if="checkingLibrary" class="detail-checking">正在确认是否已入库…</p>
            <div class="detail-actions">
              <a
                v-if="
                  (selected.inLibrary || libraryStatus?.inLibrary) && (selected.watchUrl || libraryStatus?.watchUrl)
                "
                :href="selected.watchUrl ?? libraryStatus?.watchUrl ?? undefined"
                target="_blank"
                rel="noopener"
                class="primary primary-link"
                >去观看</a
              >
              <a
                v-if="selected.externalUrl"
                :href="selected.externalUrl"
                target="_blank"
                rel="noopener"
                class="ghost-link"
                >查看源站</a
              >
            </div>
            <small v-if="selected.inLibrary || libraryStatus?.inLibrary" class="detail-inlibrary"
              >已在库：直接观看即可。</small
            >
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 完整榜单弹层：一次性看某个榜单的全部条目 -->
    <Teleport to="body">
      <div v-if="fullListSection" class="full-mask" @click.self="closeFullList">
        <div class="full-panel" role="dialog" aria-modal="true" :aria-label="`${fullListSection.label} 完整榜单`">
          <div class="full-head">
            <div class="section-title">
              <span class="platform-mark" :class="`pm-${fullListSection.source}`" aria-hidden="true">{{
                platformInitial(fullListSection.source)
              }}</span>
              <div class="section-title-text">
                <span class="source-tag" :class="`source-${fullListSection.source}`">{{
                  sourceLabel(fullListSection.source)
                }}</span>
                <h2>
                  <SvgIcon type="mdi" :path="sectionIconPath(fullListSection.key)" :size="15" aria-hidden="true" />{{
                    fullListSection.label
                  }}
                </h2>
                <p>
                  {{ sectionKind(fullListSection.key) }} · 共 {{ fullListSection.items.length }} 部 ·
                  {{ formatUpdatedAt(fullListSection.updatedAt) }}
                </p>
              </div>
            </div>
            <button type="button" class="detail-close" aria-label="关闭完整榜单" @click="closeFullList">×</button>
          </div>
          <div class="full-grid">
            <article
              v-for="item in fullListSection.items"
              :key="item.id"
              class="media-card"
              role="button"
              tabindex="0"
              @click="selected = item"
              @keydown.enter="selected = item"
            >
              <div class="media-poster">
                <img v-if="item.posterUrl" :src="item.posterUrl" :alt="item.title" loading="lazy" />
                <span v-else class="poster-fallback">{{ item.title.slice(0, 1) }}</span>
                <span v-if="item.rank <= 10" class="rank-badge">#{{ item.rank }}</span>
                <span v-if="ratingText(item)" class="rating-badge">{{ ratingWithSource(item) }}</span>
                <span v-if="item.inLibrary === true" class="lib-badge">可看</span>
                <div class="media-hover">
                  <a
                    v-if="item.inLibrary && item.watchUrl"
                    :href="item.watchUrl"
                    target="_blank"
                    rel="noopener"
                    class="hover-watch"
                    @click.stop
                  >
                    <SvgIcon type="mdi" :path="mdiPlay" :size="13" aria-hidden="true" />去观看
                  </a>
                </div>
              </div>
              <div class="media-info">
                <b :title="item.title">{{ item.title }}</b>
                <small>{{ cardMeta(item) }}</small>
              </div>
            </article>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.home {
  display: grid;
  gap: 28px;
}
.hero {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 18px;
  padding: 18px 6px 4px;
}
.hero h1 {
  margin: 0 0 8px;
  font-size: 26px;
  font-weight: 780;
  letter-spacing: 0.2px;
}
.hero p {
  margin: 0;
  color: var(--text-dim);
  font-size: 14px;
  line-height: 1.7;
}
.hero-actions {
  display: flex;
  gap: 10px;
  flex: none;
}
button {
  min-height: 42px;
  padding: 0 16px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  color: #cdd6dc;
  background: #14202b;
  cursor: pointer;
  font-size: 13px;
  font-weight: 650;
}
button.primary {
  border-color: transparent;
  color: var(--accent-ink);
  background: linear-gradient(180deg, #74c574, #5aa95a);
  box-shadow: 0 8px 22px rgb(93 175 93 / 24%);
}
button.ghost:hover {
  border-color: #3f5a6b;
  background: #182836;
}
button.small {
  min-height: 34px;
  padding: 0 12px;
  font-size: 12px;
}

/* 移动端搜索条：桌面隐藏（顶栏已有） */
.home-search {
  display: none;
  align-items: center;
  gap: 8px;
  height: 42px;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--input);
  color: var(--text-dim);
}
.home-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
  font-size: 13px;
}
.home-search input::placeholder {
  color: #5f7480;
}
.home-search button {
  min-height: 30px;
  padding: 0 12px;
  border: 0;
  border-radius: 999px;
  color: var(--accent-ink);
  background: linear-gradient(180deg, #74c574, #5aa95a);
  font-size: 12px;
}

/* 与我相关 */
.my-zone {
  display: grid;
  gap: 12px;
}
.my-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  border: 1px solid #2c4a35;
  border-radius: var(--radius-lg);
  background: linear-gradient(180deg, #0e1f16, #0c1812);
}
.my-card.expired {
  border-color: #4a2a2a;
  background: linear-gradient(180deg, #1a0f0f, #150c0c);
}
.my-main {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.my-main b {
  color: var(--text);
  font-size: 16px;
}
.my-meta {
  color: var(--text-dim);
  font-size: 12px;
}
.my-meta em {
  color: #7fd08a;
  font-style: normal;
  font-weight: 700;
}
.my-card.expired .my-meta em {
  color: #ef8585;
}

.trending-loading {
  display: grid;
  gap: 12px;
}
.row-skeleton {
  height: 150px;
  border-radius: var(--radius-lg);
}
.trending-error,
.trending-empty {
  padding: 42px 18px;
  border: 1px dashed var(--line);
  border-radius: var(--radius-lg);
  color: var(--text-dim);
  text-align: center;
}
.trending-empty {
  display: grid;
  gap: 10px;
  place-items: center;
}
.trending-empty strong {
  color: var(--text);
  font-size: 16px;
}
.trending-empty span {
  font-size: 13px;
}
.empty-actions {
  display: flex;
  gap: 10px;
  margin-top: 4px;
}
.empty-actions button {
  min-height: 38px;
  padding: 0 16px;
  border-radius: 9px;
  font-size: 13px;
}
.empty-actions button.primary {
  border-color: transparent;
  color: var(--accent-ink);
  background: linear-gradient(180deg, #74c574, #5aa95a);
}

/* 今日焦点 */
.spotlight {
  position: relative;
  display: grid;
  min-height: 300px;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-lg);
  background: linear-gradient(135deg, #101d26, #0a141c);
  cursor: pointer;
  transition:
    border-color 0.18s var(--ease),
    transform 0.18s var(--ease);
}
.spotlight:hover {
  border-color: #4f7a52;
  transform: translateY(-2px);
}
.spotlight-bg,
.spotlight-scrim {
  position: absolute;
  inset: 0;
}
.spotlight-bg img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.spotlight-scrim {
  background:
    linear-gradient(90deg, rgb(3 11 17 / 92%) 0%, rgb(3 11 17 / 66%) 48%, rgb(3 11 17 / 18%) 100%),
    linear-gradient(0deg, rgb(3 11 17 / 70%), transparent 55%);
}
.spotlight-layout {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: 168px minmax(0, 1fr);
  gap: 22px;
  align-items: center;
  padding: 26px;
}
.spotlight-poster {
  position: relative;
  aspect-ratio: 2 / 3;
  border-radius: 12px;
  overflow: hidden;
  background: #0d1921;
  box-shadow: var(--shadow-lg);
}
.spotlight-poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.feature-fallback {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  font-size: 44px;
  color: #33505f;
}
.feature-rating {
  position: absolute;
  right: 8px;
  bottom: 8px;
  padding: 3px 8px;
  border-radius: 7px;
  color: #07120d;
  background: rgb(116 197 116 / 94%);
  font-size: 12px;
  font-weight: 780;
}
.spotlight-body {
  display: grid;
  gap: 10px;
  min-width: 0;
}
.spotlight-tags {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.spotlight-body h2 {
  margin: 0;
  font-size: clamp(22px, 3.2vw, 32px);
  font-weight: 800;
  line-height: 1.2;
}
.spotlight-meta {
  margin: 0;
  color: var(--text-dim);
  font-size: 13px;
}
.spotlight-overview {
  margin: 0;
  color: #b9c4cc;
  font-size: 13px;
  line-height: 1.7;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  max-width: 640px;
}
.spotlight-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.spotlight .primary,
.spotlight .ghost {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.lib-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 720;
}
.lib-chip.on {
  color: #7fd08a;
  background: rgb(21 48 31 / 80%);
  border: 1px solid #2c4a35;
}
.lib-chip.off {
  color: #e6c06a;
  background: rgb(55 44 16 / 70%);
  border: 1px solid #5e4b1d;
}

/* 现在就能看 */
.quick-watch {
  display: grid;
  gap: 12px;
}
.quick-row {
  list-style: none;
  margin: 0;
  padding: 2px 4px 8px;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 248px;
  gap: 12px;
  overflow-x: auto;
  scroll-snap-type: x proximity;
  scrollbar-width: thin;
}
.quick-card {
  scroll-snap-align: start;
}
.quick-link {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 92px;
  padding: 10px;
  border: 1px solid #234d2f;
  border-radius: 14px;
  background: linear-gradient(180deg, #0e1f16, #0c1812);
  color: inherit;
  text-decoration: none;
  transition:
    border-color 0.18s var(--ease),
    transform 0.18s var(--ease);
}
.quick-link:hover {
  border-color: #3e6b48;
  transform: translateY(-2px);
}
.quick-poster {
  position: relative;
  width: 54px;
  height: 76px;
  flex: none;
  border-radius: 8px;
  overflow: hidden;
  background: #0d1921;
}
.quick-poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.quick-fallback {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  font-size: 22px;
  color: #33505f;
}
.rating-mini {
  position: absolute;
  right: 4px;
  bottom: 4px;
  padding: 1px 5px;
  border-radius: 5px;
  color: #07120d;
  background: rgb(116 197 116 / 94%);
  font-size: 10px;
  font-weight: 780;
}
.quick-info {
  display: grid;
  gap: 4px;
  min-width: 0;
  flex: 1;
}
.quick-info b {
  color: var(--text);
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.quick-info small {
  color: var(--text-faint);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.quick-go {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: #9cc1f2;
  font-size: 12px;
  font-weight: 700;
}

/* 通用区块头 */
.section-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  padding: 0 4px;
}
.section-head h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 750;
}
.section-sub {
  margin: 3px 0 0;
  color: var(--text-faint);
  font-size: 11px;
}
.section-count {
  color: #7fd08a;
  font-size: 12px;
  font-weight: 700;
  flex: none;
}

/* 平台视觉标识 */
.section-title {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.section-title-text {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.section-title h2 {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.platform-mark,
.tab-mark {
  display: inline-grid;
  place-items: center;
  flex: none;
  border-radius: 8px;
  color: #07120d;
  background: #7fd08a;
  font-weight: 820;
}
.platform-mark {
  width: 26px;
  height: 26px;
  font-size: 12px;
}
.tab-mark {
  width: 22px;
  height: 22px;
  font-size: 10px;
  border-radius: 7px;
}
.pm-tmdb {
  color: #eaf4ff;
  background: #31508a;
}
.pm-imdb {
  color: #241c05;
  background: #e7c36c;
}
.pm-emby {
  color: #eaf4ff;
  background: #31508a;
}

/* 来源切换 */
.source-tabs {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding: 2px 4px 4px;
  scrollbar-width: thin;
}
.source-tabs button {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 38px;
  flex: none;
  padding: 0 14px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text-dim);
  font-size: 13px;
  font-weight: 700;
}
.source-tabs button:hover {
  border-color: #4f7a52;
  background: var(--surface-hi);
}
.source-tabs button.active {
  color: var(--accent-strong);
  border-color: #4f7a52;
  background: rgb(104 189 104 / 12%);
}
.source-tabs button small {
  color: var(--text-faint);
  font-size: 11px;
}

.trend-block {
  display: grid;
  gap: 14px;
  scroll-margin-top: 76px;
}
.trend-head {
  min-height: 44px;
}
.trend-head-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.full-list-btn {
  min-height: 32px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: transparent;
  color: var(--accent-strong);
  font-size: 12px;
  font-weight: 700;
}
.full-list-btn:hover {
  border-color: #4f7a52;
  color: var(--text);
  background: var(--surface-hi);
}
.full-list-btn b {
  color: inherit;
  font-size: 12px;
}
.source-tag {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 720;
  color: #8fb7e8;
  background: rgb(21 36 56 / 70%);
}
.source-douban {
  color: #7fd08a;
  background: rgb(21 48 31 / 70%);
}
.source-imdb {
  color: #e7c36c;
  background: rgb(48 42 18 / 70%);
}
.source-emby {
  color: #8fb7e8;
  background: rgb(18 38 62 / 70%);
}

/* 榜单卡片网格：桌面为自适应网格，移动端横向滑动 */
.media-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 14px;
  padding: 2px 4px 10px;
}
.media-card {
  display: grid;
  gap: 8px;
  min-width: 0;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface);
  cursor: pointer;
  transition:
    border-color 0.18s var(--ease),
    transform 0.18s var(--ease),
    background-color 0.18s var(--ease);
}
.media-card:hover,
.media-card:focus-visible {
  border-color: #4f7a52;
  background: var(--surface-hi);
  transform: translateY(-3px);
}
.media-poster {
  position: relative;
  aspect-ratio: 2 / 3;
  border-radius: 10px;
  overflow: hidden;
  background: #0a1218;
}
.media-poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.poster-fallback {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  font-size: 34px;
  color: #33505f;
  background: #0d1921;
}
.rank-badge {
  position: absolute;
  top: 6px;
  left: 6px;
  padding: 2px 7px;
  border-radius: 6px;
  color: #0b1420;
  background: rgb(237 242 244 / 92%);
  font-size: 11px;
  font-weight: 820;
}
.rating-badge {
  position: absolute;
  right: 6px;
  bottom: 6px;
  padding: 2px 6px;
  border-radius: 6px;
  color: #07120d;
  background: rgb(116 197 116 / 92%);
  font-size: 11px;
  font-weight: 780;
}
.lib-badge {
  position: absolute;
  right: 6px;
  top: 6px;
  padding: 2px 7px;
  border-radius: 999px;
  color: #07120d;
  background: rgb(127 208 138 / 95%);
  font-size: 10px;
  font-weight: 800;
}
.media-hover {
  position: absolute;
  inset: auto 6px 6px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px;
  opacity: 0;
  transform: translateY(6px);
  transition:
    opacity 0.18s var(--ease),
    transform 0.18s var(--ease);
}
.media-card:hover .media-hover,
.media-card:focus-visible .media-hover {
  opacity: 1;
  transform: none;
}
.hover-watch,
.hover-submit {
  min-height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 0 8px;
  border: 0;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 750;
  text-decoration: none;
}
.hover-watch {
  color: var(--accent-ink);
  background: linear-gradient(180deg, #74c574, #5aa95a);
}
.hover-submit {
  color: #e6ebef;
  background: rgb(10 20 28 / 88%);
  border: 1px solid var(--line-strong);
}
.media-info {
  display: grid;
  gap: 3px;
  min-width: 0;
}
.media-info b {
  color: var(--text);
  font-size: 13px;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 36px;
}
.media-info small {
  color: var(--text-faint);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 最近入库 */
.trend-row {
  list-style: none;
  margin: 0;
  padding: 2px 4px 10px;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 128px;
  gap: 12px;
  overflow-x: auto;
  scroll-snap-type: x proximity;
  scrollbar-width: thin;
}
.trend-card {
  scroll-snap-align: start;
  display: grid;
  gap: 7px;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface);
  transition:
    border-color 0.18s var(--ease),
    transform 0.18s var(--ease),
    background-color 0.18s var(--ease);
}
.trend-card:hover {
  border-color: #4f7a52;
  background: var(--surface-hi);
  transform: translateY(-3px);
}
.poster {
  position: relative;
  aspect-ratio: 2 / 3;
  border-radius: 8px;
  overflow: hidden;
  background: #0a1218;
}
.poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.card-title {
  color: var(--text);
  font-size: 13px;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 36px;
}
.card-meta {
  color: var(--text-faint);
  font-size: 11px;
}

/* 完整榜单弹层 */
.full-mask {
  position: fixed;
  inset: 0;
  z-index: 110;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgb(0 0 0 / 66%);
  backdrop-filter: blur(6px);
}
.full-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: min(1200px, 100%);
  max-height: 92dvh;
  padding: 20px 20px 16px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-lg);
  background: linear-gradient(180deg, #101d26, #0a141c);
  box-shadow: var(--shadow-lg);
}
.full-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding-right: 38px;
}
.full-head h2 {
  margin: 4px 0 0;
  font-size: 20px;
  font-weight: 780;
}
.full-head p {
  margin: 3px 0 0;
  color: var(--text-dim);
  font-size: 12px;
}
.full-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 12px;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 4px 8px;
  scrollbar-width: thin;
}

/* 详情弹层 */
.detail-mask {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgb(0 0 0 / 66%);
  backdrop-filter: blur(6px);
}
.detail-card {
  position: relative;
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 20px;
  width: min(620px, 100%);
  max-height: 90dvh;
  overflow: auto;
  padding: 22px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-lg);
  background: linear-gradient(180deg, #101d26, #0a141c);
  box-shadow: var(--shadow-lg);
}
.detail-close {
  position: absolute;
  top: 10px;
  right: 10px;
  width: 30px;
  height: 30px;
  min-height: 30px;
  padding: 0;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  color: var(--text-dim);
  background: #101d25;
  font-size: 16px;
}
.detail-poster {
  aspect-ratio: 2 / 3;
  border-radius: 10px;
  overflow: hidden;
  background: #0d1921;
}
.detail-poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.detail-fallback {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  font-size: 54px;
  color: #33505f;
}
.detail-body {
  display: grid;
  align-content: center;
  gap: 12px;
  min-width: 0;
}
.detail-body h2 {
  margin: 0;
  font-size: 22px;
  font-weight: 780;
}
.detail-meta {
  margin: 0;
  color: var(--text-dim);
  font-size: 13px;
}
.detail-original {
  margin: 2px 0 0;
  color: #6d8794;
  font-size: 12px;
}
.detail-meta b {
  color: #7fd08a;
}
.detail-overview {
  margin: 0;
  color: var(--text-dim);
  font-size: 13px;
  line-height: 1.7;
}
.detail-checking {
  margin: 0;
  color: var(--text-faint);
  font-size: 12px;
}
.detail-inlibrary {
  color: #7fd08a;
  font-size: 12px;
}
.primary-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 42px;
  padding: 0 18px;
  border-radius: 9px;
  color: var(--accent-ink);
  background: linear-gradient(180deg, #74c574, #5aa95a);
  text-decoration: none;
  font-size: 13px;
  font-weight: 650;
  box-shadow: 0 8px 22px rgb(93 175 93 / 24%);
}
.detail-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.detail-actions .primary {
  min-height: 42px;
  padding: 0 18px;
}
.ghost-link {
  display: inline-flex;
  align-items: center;
  min-height: 42px;
  padding: 0 14px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  color: #cdd6dc;
  text-decoration: none;
  font-size: 13px;
}
.ghost-link:hover {
  border-color: #3f5a6b;
  background: #182836;
}

@media (max-width: 840px) {
  .home-search {
    display: flex;
  }
}
@media (max-width: 720px) {
  .hero {
    flex-direction: column;
    align-items: stretch;
  }
  .hero-actions {
    display: flex;
  }
  .hero-actions button {
    flex: 1;
  }
  .home {
    gap: 22px;
  }

  /* 焦点卡：移动端改为纵向布局，背景铺满 */
  .spotlight {
    min-height: 0;
  }
  .spotlight-scrim {
    background: linear-gradient(180deg, rgb(3 11 17 / 12%) 0%, rgb(3 11 17 / 55%) 42%, rgb(3 11 17 / 92%) 88%);
  }
  .spotlight-layout {
    grid-template-columns: 118px minmax(0, 1fr);
    gap: 14px;
    align-items: end;
    padding: 20px 18px 18px;
  }
  .spotlight-poster {
    border-radius: 10px;
  }
  .spotlight-body h2 {
    font-size: 20px;
  }
  .spotlight-overview {
    -webkit-line-clamp: 2;
  }

  /* 卡片改为横向滑动，单手即可浏览 */
  .media-grid {
    grid-auto-flow: column;
    grid-auto-columns: 142px;
    grid-template-columns: none;
    overflow-x: auto;
    scroll-snap-type: x proximity;
    scrollbar-width: thin;
  }
  .media-card {
    scroll-snap-align: start;
  }
  .quick-row {
    grid-auto-columns: min(238px, calc(100vw - 46px));
  }
  .trend-row {
    grid-auto-columns: 116px;
  }
  .trend-head {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  .trend-head-right {
    width: 100%;
    justify-content: space-between;
  }
  .full-mask {
    padding: 12px;
  }
  .full-panel {
    padding: 14px 14px 12px;
    width: 100%;
    max-height: 94dvh;
  }
  .full-grid {
    grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
    gap: 10px;
  }
  .full-list-btn {
    padding: 0 10px;
    font-size: 11px;
  }
  .detail-card {
    grid-template-columns: 1fr;
  }
  .detail-poster {
    width: 200px;
  }
}
@media (max-width: 420px) {
  .spotlight-layout {
    grid-template-columns: 96px minmax(0, 1fr);
    padding: 16px 14px 14px;
    gap: 10px;
  }
  .spotlight-body h2 {
    font-size: 18px;
  }
  .spotlight-actions .ghost {
    min-height: 38px;
    padding: 0 12px;
    font-size: 12px;
  }
}
</style>
