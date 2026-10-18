<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import { mdiAlertCircleOutline, mdiCheckCircleOutline, mdiMagnify, mdiPlaylistRemove, mdiRefresh } from "@mdi/js";
import MissingMetadataNotice from "./MissingMetadataNotice.vue";
import { useMissingEpisodesView, type MissingViewProps, type MissingViewEmits } from "./MissingEpisodesView.state";
import {
  pendingEpisodesText,
  seasonLabel,
  episodeCode,
  libraryLine,
  unmatchedText,
  suspectText,
} from "./missing-episode-format";
const props = defineProps<MissingViewProps>();
const emit = defineEmits<MissingViewEmits>();
const {
  search,
  inventoryNotice,
  sortKey,
  selectLibrary,
  selected,
  confirmOpen,
  embyItemUrl,
  shows,
  libraryTabs,
  activeLibrary,
  visibleShows,
  selectedShows,
  emptyHint,
  scanStateText,
  toggleSelect,
  selectVisible,
  clearSelection,
  confirmDelete,
} = useMissingEpisodesView(props, emit);
</script>

<template>
  <section class="missing-view" aria-labelledby="missing-title">
    <header class="page-head">
      <div class="page-title">
        <span class="eyebrow">MISSING EPISODES</span>
        <h1 id="missing-title">缺集总览</h1>
        <p>按当前启用媒体库独立比对 TMDB 已播与 Emby 已存分集；其他库的副本和停用库不参与计算。</p>
      </div>
      <div class="head-actions">
        <span v-if="payload" class="total">共 {{ payload.showCount }} 部剧缺 {{ payload.episodeCount }} 集</span>
        <span v-if="payload?.pendingEpisodeCount" class="pending-total">
          另有 {{ payload.pendingEpisodeCount }} 集今日更新待入库
        </span>
        <span
          v-if="payload?.pendingShowCount"
          class="pending-total"
          title="这些剧只差「今日更新待入库」：不计缺集，也不在批量删除范围"
        >
          其中 {{ payload.pendingShowCount }} 部仅此一项
        </span>
        <span v-if="payload" class="generated">{{ scanStateText }}</span>
        <button type="button" :disabled="scanStarting || payload?.scanning" @click="triggerScan?.()">
          <SvgIcon type="mdi" :path="mdiPlaylistRemove" :size="18" />{{ payload?.scanning ? "检测中…" : "立即检测" }}
        </button>
        <button type="button" :disabled="loading" @click="emit('refresh')">
          <SvgIcon type="mdi" :path="mdiRefresh" :size="18" />{{ loading ? "刷新中…" : "刷新" }}
        </button>
      </div>
    </header>
    <!-- 口径说明单独占整宽的一行：塞进页头左栏会被右侧动作区挤成一条竖线（实测 104px 宽 / 144px 高） -->
    <p class="page-note">
      「今日更新」＝当天播出、还在入库宽限期内的集（默认次日 0 点前），不计入缺集，避免当天晚间才入库的集在白天被误判。
    </p>

    <p v-if="actionMessage" class="action-message" role="status">{{ actionMessage }}</p>
    <p v-if="error" class="error" role="alert">
      <SvgIcon type="mdi" :path="mdiAlertCircleOutline" :size="20" />{{ error }}
    </p>

    <MissingMetadataNotice :issues="payload?.metadataIssues ?? []" scope-label="当前媒体库" />
    <p v-if="inventoryNotice" class="error" role="status">
      <SvgIcon type="mdi" :path="mdiAlertCircleOutline" :size="20" />{{ inventoryNotice }}
    </p>

    <!-- 放在最上面：这些剧不进缺集清单，混在几百部剧的列表后面根本看不到 -->
    <section v-if="payload?.mismatches.length" class="mismatch-section" aria-labelledby="mismatch-title">
      <h3 id="mismatch-title">未纳入检测：{{ payload.mismatches.length }} 部剧的 TMDB 标识与 Emby 实际不一致</h3>
      <p class="mismatch-hint">
        这些剧本地记录的 TMDB 条目与 Emby
        里实际登记的标识对不上（多为同名剧匹配错误），因此不判缺集、也不会参与批量删除；可在「系统设置 →
        媒体库」重扫后由元数据补齐修正。
      </p>
      <ul class="mismatch-list">
        <li v-for="item in payload.mismatches" :key="item.mediaItemId">
          <span class="mismatch-name">{{ item.title }}</span>
          <span class="mismatch-ids">
            本地 TMDB {{ item.tmdbId ?? "—" }} · Emby 实际 {{ item.embyTmdbId ?? "未登记 TMDB id" }}
          </span>
          <a
            v-if="embyItemUrl(item.embySeriesId)"
            class="emby-link"
            :href="embyItemUrl(item.embySeriesId)!"
            target="_blank"
            rel="noopener noreferrer"
            >在 Emby 查看 ↗</a
          >
        </li>
      </ul>
    </section>

    <div v-if="libraryTabs.length" class="library-tabs" role="tablist" aria-label="按媒体库筛选">
      <button
        v-for="library in libraryTabs"
        :key="library.id"
        type="button"
        role="tab"
        :aria-selected="activeLibrary === library.id"
        :disabled="deleting"
        :class="['library-tab', { active: activeLibrary === library.id }]"
        @click="selectLibrary(library.id)"
      >
        {{ library.name }}<b v-if="library.count !== undefined">{{ library.count }}</b>
      </button>
    </div>

    <div v-if="loading && !payload" class="empty" role="status">正在读取缺集清单…</div>
    <div v-else-if="error && !payload" class="empty">缺集清单未读取成功，请重试。</div>
    <div v-else-if="payload?.libraries?.length === 0" class="empty">没有启用的剧集媒体库。</div>
    <div v-else-if="!shows.length" class="empty">
      <SvgIcon type="mdi" :path="inventoryNotice ? mdiAlertCircleOutline : mdiCheckCircleOutline" :size="38" />
      <strong>{{ inventoryNotice || payload?.metadataIssueCount ? "检测结果不完整" : "当前媒体库未发现缺集" }}</strong>
      <span>{{
        inventoryNotice
          ? "请先完成库存同步，再核对当前媒体库的缺集结果。"
          : payload?.metadataIssueCount
            ? "部分剧集尚未完成检测，不能确认当前媒体库已齐。"
            : payload?.lastScanAt
              ? "当前媒体库最近一次检测没有发现缺集。"
              : "还没有检测过，点「立即检测」跑一轮。"
      }}</span>
    </div>

    <template v-else>
      <div class="toolbar">
        <label class="search">
          <span class="sr-only">搜索剧名</span>
          <SvgIcon type="mdi" :path="mdiMagnify" :size="20" />
          <input v-model="search" type="search" placeholder="搜索剧名" />
        </label>
        <div class="sort" role="group" aria-label="排序方式">
          <button type="button" :class="{ active: sortKey === 'missing' }" @click="sortKey = 'missing'">缺集数</button>
          <button type="button" :class="{ active: sortKey === 'title' }" @click="sortKey = 'title'">剧名</button>
        </div>
      </div>

      <div class="selection-bar">
        <button type="button" @click="selectVisible">全选当前</button>
        <button type="button" :disabled="!selected.size" @click="clearSelection">清空选择</button>
        <button type="button" class="danger" :disabled="!selected.size || deleting" @click="confirmOpen = true">
          删除选中{{ selected.size ? `（${selected.size}）` : "" }}
        </button>
      </div>

      <div v-if="!visibleShows.length" class="empty">
        <SvgIcon type="mdi" :path="mdiPlaylistRemove" :size="30" />
        <span>{{ emptyHint }}</span>
      </div>
      <ul v-else class="show-list">
        <li v-for="show in visibleShows" :key="show.mediaItemId" class="show-card">
          <header class="show-head">
            <!-- 仅"今日更新待入库"的剧缺 0 集：不给勾选框（删除对象是有缺集的剧），占位保持标题对齐 -->
            <label v-if="show.missingCount > 0" class="pick">
              <input
                type="checkbox"
                :checked="selected.has(show.mediaItemId)"
                :aria-label="`选择 ${show.title}`"
                @change="toggleSelect(show.mediaItemId)"
              />
            </label>
            <span v-else class="pick placeholder" aria-hidden="true"></span>
            <img v-if="show.posterUrl" class="poster" :src="show.posterUrl" alt="" loading="lazy" />
            <div class="show-meta">
              <h2>
                {{ show.title
                }}<span v-if="show.missingCount === 0" class="pending-only-tag">{{
                  show.pendingCount > 0 ? "仅今日更新待入库" : "检测待核对"
                }}</span>
              </h2>
              <p class="numbers">
                已播 {{ show.airProgress ?? "—" }} · 已存 {{ show.storedProgress ?? "—" }} ·
                <b v-if="show.missingCount > 0">缺 {{ show.missingCount }} 集</b>
                <span v-else class="no-missing">{{ show.pendingCount > 0 ? "无缺集" : "未判定缺集" }}</span>
              </p>
              <p v-if="show.pendingSeasons.length" class="pending">
                今日更新 {{ pendingEpisodesText(show.pendingSeasons) }}（当天播出，宽限期内不计缺集）
              </p>
              <p class="libraries">{{ libraryLine(show.libraries) }}</p>
              <p v-if="show.unmatchedSeasons.length" class="unmatched">{{ unmatchedText(show.unmatchedSeasons) }}</p>
              <p v-if="show.suspectSeasons.length" class="suspect">{{ suspectText(show.suspectSeasons) }}</p>
              <p v-if="show.error === 'metadata_incomplete'" class="stale">尚无完整的分集元数据，暂不判定缺集。</p>
              <p v-else-if="show.error" class="stale">
                {{
                  show.error === "tmdb_partial_unavailable" ? "部分季的 TMDB 数据读取失败" : "TMDB 暂时不可用"
                }}，这一行按已有 TMDB 数据与当前库库存比对，元数据尚未完整刷新。
              </p>
            </div>
          </header>
          <div v-for="season in show.seasons" :key="season.seasonNumber" class="season-block">
            <p class="season-head">
              <span class="season-name">{{ seasonLabel(season.seasonNumber) }}</span>
              <span class="season-side">
                <span class="season-meta"
                  >缺 {{ season.episodes.length }} 集 · 已播 {{ season.aired }} / 已存 {{ season.stored }}</span
                >
                <a
                  v-if="season.embyUrl"
                  class="emby-link"
                  :href="season.embyUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  title="在 Emby 打开这一季，核对是否真的缺"
                  >在 Emby 查看 ↗</a
                >
              </span>
            </p>
            <ul class="episode-list">
              <li v-for="episode in season.episodes" :key="episode.episodeNumber" class="episode">
                <a
                  v-if="season.embyUrl"
                  class="episode-inner"
                  :href="season.embyUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  :title="`在 Emby 打开${seasonLabel(season.seasonNumber)}，核对这一集是否真的缺`"
                >
                  <span class="code">{{ episodeCode(season.seasonNumber, episode.episodeNumber) }}</span>
                  <span class="name">{{ episode.name ?? "集名待补" }}</span>
                  <time v-if="episode.airDate">{{ episode.airDate }}</time>
                </a>
                <span v-else class="episode-inner">
                  <span class="code">{{ episodeCode(season.seasonNumber, episode.episodeNumber) }}</span>
                  <span class="name">{{ episode.name ?? "集名待补" }}</span>
                  <time v-if="episode.airDate">{{ episode.airDate }}</time>
                </span>
              </li>
            </ul>
          </div>
        </li>
      </ul>
    </template>

    <div v-if="confirmOpen" class="modal-backdrop" @click.self="confirmOpen = false">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="delete-title">
        <h2 id="delete-title">
          从「{{ libraryTabs.find((tab) => tab.id === activeLibrary)?.name }}」删除 {{ selectedShows.length }} 部剧？
        </h2>
        <p class="warning">
          只删除当前媒体库中的这些剧，其他媒体库中的副本保留。将调用 Emby 删除接口移除条目（Emby
          会按其策略联动片源清理），<strong>此操作不可恢复</strong>。
        </p>
        <ul class="delete-list">
          <li v-for="show in selectedShows.slice(0, 8)" :key="show.mediaItemId">{{ show.title }}</li>
          <li v-if="selectedShows.length > 8">…等 {{ selectedShows.length - 8 }} 部</li>
        </ul>
        <div class="modal-actions">
          <button type="button" :disabled="deleting" @click="confirmOpen = false">取消</button>
          <button type="button" class="danger" :disabled="deleting" @click="confirmDelete">
            {{ deleting ? "删除中…" : `确认删除 ${selectedShows.length} 部` }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.missing-view {
  max-width: 1100px;
  margin: 0 auto;
}
.page-head {
  display: flex;
  /* 窄屏时动作区整块掉到下一行：不然它 flex:none 会把左侧标题/说明挤成一条竖线 */
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px 20px;
  margin: 10px 0 10px;
}
/* 左栏必须能收缩，否则长句会被压成每行 2–3 个字；给个宽度基准，让右侧动作区留在同一行（原版观感）。 */
.page-title {
  flex: 1 1 320px;
  min-width: 0;
}
.eyebrow {
  color: #68bf6a;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.14em;
}
.page-head h1 {
  margin: 5px 0;
  color: var(--text);
  font-size: 28px;
}
.page-head p {
  margin: 0;
  color: #84929c;
}
.head-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px 12px;
  /* 原来是 flex: none：窗口一窄就横向溢出（实测 1024 宽时右边界 1073 被切掉） */
  flex: 0 1 auto;
}
.total {
  color: var(--warn);
  font-size: 13px;
}
.generated {
  color: #7f8e97;
  font-size: 12px;
}
.head-actions button {
  min-height: 42px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  border: 1px solid #315244;
  border-radius: 8px;
  color: #bce8be;
  background: #10241b;
  cursor: pointer;
}
.head-actions button:disabled {
  opacity: 0.6;
  cursor: default;
}
.action-message {
  margin: 0 0 12px;
  padding: 9px 12px;
  border: 1px solid #2c4a35;
  border-radius: 8px;
  color: #9fd7a1;
  background: #0e1913;
  font-size: 12.5px;
}
.mismatch-section {
  margin-top: 22px;
  padding: 16px;
  border: 1px solid #3a4a5c;
  border-radius: var(--radius-lg);
  background: #101a22;
}
.mismatch-section h3 {
  margin: 0 0 6px;
  color: var(--text);
  font-size: 15px;
}
.mismatch-hint {
  margin: 0 0 12px;
  color: #8fa2b3;
  font-size: 12px;
  line-height: 1.6;
}
.mismatch-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.mismatch-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
}
.mismatch-name {
  color: var(--text);
  font-size: 13px;
  font-weight: 700;
}
.mismatch-ids {
  color: var(--text-dim);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.mismatch-list .emby-link {
  margin-left: auto;
}
.error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  border-radius: 8px;
  color: var(--danger);
  background: #241315;
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 34px 20px;
  color: #7e8c96;
  text-align: center;
}
.empty strong {
  color: var(--text);
  font-size: 16px;
}
.toolbar {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
.search {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  max-width: 320px;
  min-height: 44px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  color: #84929c;
  background: var(--input);
}
.search input {
  width: 100%;
  border: 0;
  color: var(--text);
  background: transparent;
  font: inherit;
}
.sort {
  display: flex;
  gap: 6px;
}
.sort button,
.selection-bar button {
  min-height: 44px;
  padding: 0 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  color: #93a0aa;
  background: var(--surface);
  cursor: pointer;
}
.sort button.active {
  color: var(--accent-strong);
  border-color: rgb(93 175 93 / 40%);
  background: var(--accent-dim);
}
.library-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: -2px 0 14px;
}
.library-tab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 36px;
  padding: 0 13px;
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  color: var(--text-dim);
  background: var(--surface);
  cursor: pointer;
  font-size: 12.5px;
}
.library-tab b {
  color: var(--text-faint);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.library-tab.active {
  border-color: var(--line-strong);
  color: var(--text);
  background: var(--surface-hi);
}
.library-tab.active b {
  color: var(--text);
}
/* 触控目标：窄屏下筛选按钮同样不小于 44px（与任务看板一致）。 */
@media (max-width: 900px) {
  .library-tab {
    min-height: 44px;
    padding: 0 16px;
    font-size: 13.5px;
  }
}
.selection-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 14px;
}
.selection-bar button:disabled {
  opacity: 0.55;
  cursor: default;
}
.selection-bar button.danger {
  color: #f0b0b0;
  border-color: rgb(239 133 133 / 38%);
  background: rgb(140 52 57 / 14%);
}
.show-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.show-card {
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface);
}
.show-head {
  display: flex;
  gap: 14px;
}
/* 仅今日更新的剧没有勾选框，用等宽占位保持标题列对齐 */
.pick.placeholder {
  display: block;
  /* 与 .pick 里的 checkbox 同宽（20px），保证两行标题左边界对齐 */
  width: 20px;
  flex: none;
}
.pick {
  display: flex;
  align-items: flex-start;
  flex: none;
  padding-top: 2px;
}
.pick input {
  width: 20px;
  height: 20px;
  accent-color: var(--accent);
  cursor: pointer;
}
.poster {
  width: 54px;
  height: 80px;
  flex: none;
  border-radius: 8px;
  background: var(--surface-hi);
  object-fit: cover;
}
.show-meta {
  min-width: 0;
}
.show-meta h2 {
  margin: 0 0 4px;
  color: var(--text);
  font-size: 17px;
}
.numbers {
  margin: 0;
  color: #84929c;
  font-size: 13px;
}
.numbers b {
  color: var(--warn);
}
.libraries {
  margin: 4px 0 0;
  color: #7f8e97;
  font-size: 12px;
}
.unmatched {
  margin: 5px 0 0;
  color: var(--warn);
  font-size: 12px;
}
.suspect {
  margin: 5px 0 0;
  color: #9db4d0;
  font-size: 12px;
}
/* 「今日更新」：不是缺集，用与看板同一支中性蓝，视觉上明显弱于上面那行"缺 N 集" */
.pending {
  margin: 5px 0 0;
  color: #9cc1f2;
  font-size: 12px;
}
/* 头部合计后面的「今日更新」补充：与相邻的 .total(13px)/.generated(12px) 同一量级，别比它们更抢眼 */
.pending-total {
  color: #9cc1f2;
  font-size: 12px;
}
/* 「仅今日更新待入库」：不是缺集，用中性蓝小标签，别让它看起来像待处理事项 */
.pending-only-tag {
  margin-left: 8px;
  padding: 2px 8px;
  border: 1px solid #3f6a9b;
  border-radius: var(--radius-pill);
  color: #9cc1f2;
  font-size: 11px;
  font-weight: 600;
  vertical-align: middle;
}
.no-missing {
  color: #7fd08a;
}
/* 页头补充说明：整宽一行，只解释一次宽限期口径 */
.page-note {
  margin: 0 0 16px;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.7;
}
.stale {
  margin: 5px 0 0;
  color: var(--danger);
  font-size: 12px;
}
.season-block {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid #1b2c35;
}
.season-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 0 0 9px;
  color: var(--text);
  font-size: 14px;
  font-weight: 700;
}
.season-side {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
.season-meta {
  color: #84929c;
  font-size: 12px;
  font-weight: 400;
}
.emby-link {
  color: var(--accent-strong);
  font-size: 12px;
  font-weight: 400;
  text-decoration: none;
  white-space: nowrap;
}
.emby-link:hover {
  text-decoration: underline;
}
.episode-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.episode {
  display: inline-flex;
}
.episode-inner {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid rgb(230 192 106 / 28%);
  border-radius: var(--radius-pill);
  background: rgb(230 192 106 / 8%);
  color: inherit;
  font-size: 13px;
  text-decoration: none;
}
a.episode-inner:hover {
  border-color: rgb(230 192 106 / 55%);
}
a.episode-inner:hover .name {
  text-decoration: underline;
}
.episode .code {
  color: var(--warn);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.episode .name {
  color: var(--text);
}
.episode time {
  color: #7f8e97;
  font-size: 11px;
}
.modal-backdrop {
  position: fixed;
  z-index: 80;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgb(0 4 7 / 62%);
}
.modal {
  width: min(460px, 100%);
  padding: 20px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-lg);
  background: var(--bg-raised);
  box-shadow: var(--shadow-lg);
}
.modal h2 {
  margin: 0 0 10px;
  color: var(--text);
  font-size: 17px;
}
.modal .warning {
  margin: 0 0 12px;
  color: #d8b7b7;
  font-size: 13px;
  line-height: 1.6;
}
.modal .delete-list {
  max-height: 180px;
  overflow-y: auto;
  margin: 0 0 16px;
  padding: 0 0 0 18px;
  color: var(--text-dim);
  font-size: 13px;
  line-height: 1.7;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.modal-actions button {
  min-height: 44px;
  padding: 0 16px;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--text-dim);
  background: var(--surface);
  cursor: pointer;
}
.modal-actions button.danger {
  color: #ffd9d9;
  border-color: rgb(239 133 133 / 45%);
  background: #5a2026;
}
.modal-actions button:disabled {
  opacity: 0.6;
  cursor: default;
}
@media (max-width: 700px) {
  .page-head {
    align-items: stretch;
    flex-direction: column;
  }
  /* 竖排后 flex-basis 会变成"高度基准"：不清掉的话标题块会白撑出 320px 空白（实测页头 402px 高）。 */
  .page-title {
    flex: 1 1 auto;
  }
  .head-actions {
    flex-wrap: wrap;
    justify-content: space-between;
  }
  .toolbar {
    flex-direction: column;
  }
  .search {
    max-width: none;
  }
  .season-head {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
  }
  .season-side {
    flex-wrap: wrap;
  }
}
</style>
