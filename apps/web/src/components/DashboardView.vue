<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import { mdiAlertOctagon, mdiHomeImportOutline, mdiBookOpenPageVariant, mdiTrayArrowDown, mdiRefresh } from "@mdi/js";
import { computed, onMounted } from "vue";

import { useDashboard } from "../composables/useDashboard";
import type { AppView } from "../types";

const props = defineProps<{ requireAuth: () => void }>();
const emit = defineEmits<{ navigate: [view: AppView] }>();

const dash = useDashboard(props.requireAuth);

const attention = computed(() => {
  const s = dash.summary.value;
  if (!s) return [];
  const items: Array<{ label: string; count: number; level: "danger" | "warn"; view: AppView }> = [];
  if (s.tasks.failed > 0) items.push({ label: "失败任务", count: s.tasks.failed, level: "danger", view: "tasks" });
  if (s.library.unmatched > 0)
    items.push({ label: "未匹配片源", count: s.library.unmatched, level: "warn", view: "library" });
  if (s.members.expired > 0)
    items.push({ label: "已过期会员", count: s.members.expired, level: "danger", view: "submissions" });
  if (s.members.concurrencyActive > 0)
    items.push({ label: "并发超限/冻结", count: s.members.concurrencyActive, level: "danger", view: "submissions" });
  return items;
});

function go(view: AppView) {
  emit("navigate", view);
}
function taskStatusLabel(status: string): string {
  return (
    {
      pending: "待处理",
      claimed: "已领取",
      running: "进行中",
      completed: "已完成",
      failed: "失败",
      cancelled: "已取消",
    }[status] ?? status
  );
}
function taskStatusClass(status: string): string {
  if (status === "completed") return "ok";
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "running" || status === "claimed") return "warn";
  return "idle";
}

onMounted(() => void dash.load());
</script>

<template>
  <section class="home" aria-label="数据总览">
    <header class="head">
      <div class="head-main">
        <div class="head-title">
          <span class="head-icon" aria-hidden="true"
            ><SvgIcon type="mdi" :path="mdiHomeImportOutline" :size="22"
          /></span>
          <h2>数据总览</h2>
        </div>
        <p class="head-sub">一屏看完运营核心指标与待办事项，点击卡片直达对应面板。</p>
      </div>
      <button type="button" class="refresh" :disabled="dash.loading.value" @click="dash.load">
        <SvgIcon type="mdi" :path="mdiRefresh" :size="18" />刷新
      </button>
    </header>

    <p v-if="dash.error.value" class="error" role="alert">{{ dash.error.value }}</p>
    <div v-if="dash.loading.value && !dash.summary.value" class="empty">正在读取…</div>

    <template v-else-if="dash.summary.value">
      <section class="group">
        <h3 class="group-title">媒体任务</h3>
        <div class="metric-grid">
          <button class="metric" type="button" @click="go('tasks')">
            <b class="num">{{ dash.summary.value.tasks.total }}</b>
            <span class="label">全部任务 <i class="arrow">→</i></span>
          </button>
          <div class="metric">
            <b class="num idle">{{ dash.summary.value.tasks.pending }}</b
            ><span class="label">待处理</span>
          </div>
          <div class="metric">
            <b class="num warn">{{ dash.summary.value.tasks.processing }}</b
            ><span class="label">进行中</span>
          </div>
          <div class="metric">
            <b class="num ok">{{ dash.summary.value.tasks.completed }}</b
            ><span class="label">已完成</span>
          </div>
          <div class="metric">
            <b class="num danger">{{ dash.summary.value.tasks.failed }}</b
            ><span class="label">失败</span>
          </div>
        </div>
      </section>

      <section class="group">
        <h3 class="group-title">媒体库</h3>
        <div class="metric-grid">
          <button class="metric" type="button" @click="go('library')">
            <b class="num">{{ dash.summary.value.library.items }}</b>
            <span class="label">片源条目 <i class="arrow">→</i></span>
          </button>
          <div class="metric">
            <b class="num ok">{{ dash.summary.value.library.matched }}</b
            ><span class="label">已匹配</span>
          </div>
          <div class="metric">
            <b class="num danger">{{ dash.summary.value.library.unmatched }}</b
            ><span class="label">未匹配</span>
          </div>
          <div class="metric">
            <b class="num">{{ dash.summary.value.library.roots }}</b
            ><span class="label">片源根目录</span>
          </div>
        </div>
      </section>

      <section class="group">
        <h3 class="group-title">会员 / Emby</h3>
        <div class="metric-grid">
          <button class="metric" type="button" @click="go('submissions')">
            <b class="num">{{ dash.summary.value.members.total }}</b>
            <span class="label">会员总数 <i class="arrow">→</i></span>
          </button>
          <div class="metric">
            <b class="num ok">{{ dash.summary.value.members.active }}</b
            ><span class="label">有效</span>
          </div>
          <div class="metric">
            <b class="num warn">{{ dash.summary.value.members.expiring }}</b
            ><span class="label">临期</span>
          </div>
          <div class="metric">
            <b class="num danger">{{ dash.summary.value.members.expired }}</b
            ><span class="label">已过期</span>
          </div>
          <div class="metric">
            <b class="num danger">{{ dash.summary.value.members.concurrencyActive }}</b
            ><span class="label">超限/冻结</span>
          </div>
        </div>
      </section>

      <section class="group">
        <h3 class="group-title">待办提醒</h3>
        <ul v-if="attention.length" class="attention-list">
          <li v-for="item in attention" :key="item.label + item.view">
            <span :class="['attention-badge', item.level]"
              ><SvgIcon type="mdi" :path="mdiAlertOctagon" :size="14" />{{ item.label }}</span
            >
            <b>{{ item.count }}</b>
            <button type="button" @click="go(item.view)">去处理 <i class="arrow">→</i></button>
          </li>
        </ul>
        <p v-else class="all-clear">一切正常，暂无待办。🎉</p>
      </section>

      <section class="group">
        <div class="recent-head">
          <h3 class="group-title">近期任务</h3>
          <button type="button" class="ghost" @click="go('tasks')">查看全部 <i class="arrow">→</i></button>
        </div>
        <ul v-if="dash.summary.value.recentTasks.length" class="recent-list">
          <li v-for="task in dash.summary.value.recentTasks" :key="task.id">
            <span class="task-icon"
              ><SvgIcon
                type="mdi"
                :path="task.mediaType === 'movie' ? mdiTrayArrowDown : mdiBookOpenPageVariant"
                :size="16"
            /></span>
            <span class="task-title">{{ task.title }}</span>
            <span :class="['task-badge', taskStatusClass(task.status)]">{{ taskStatusLabel(task.status) }}</span>
            <span class="task-meta">{{ task.mediaType === "movie" ? "电影" : "完结入库" }} · #{{ task.id }}</span>
            <span class="task-time">{{
              new Date(task.updatedAt).toLocaleString("zh-CN", {
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })
            }}</span>
          </li>
        </ul>
        <p v-else class="empty">暂无任务。</p>
      </section>
    </template>
  </section>
</template>

<style scoped>
.home {
  padding: 22px;
  max-width: 1180px;
  margin: 0 auto;
  color: var(--text);
}
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}
.head-title {
  display: flex;
  align-items: center;
  gap: 11px;
  margin-bottom: 6px;
}
.head-icon {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border-radius: 11px;
  color: var(--accent-strong);
  background: var(--accent-dim);
  border: 1px solid rgb(104 189 104 / 24%);
}
.head h2 {
  margin: 0;
  font-size: 23px;
  font-weight: 760;
  color: var(--text);
  letter-spacing: 0.01em;
}
.head-sub {
  margin: 0;
  color: var(--text-dim);
  font-size: 13px;
  line-height: 1.6;
}
.refresh {
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 15px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  color: var(--text);
  background: var(--surface-hi);
  cursor: pointer;
  font-size: 13px;
}
.refresh:disabled {
  opacity: 0.55;
  cursor: default;
}
.refresh:not(:disabled):hover {
  background: #172834;
  border-color: #35506a;
}

.error {
  margin: 12px 0 0;
  padding: 10px 14px;
  border: 1px solid #4a2e30;
  border-radius: 8px;
  color: #f0b7b7;
  background: #241416;
}
.empty {
  padding: 26px 20px;
  color: var(--text-faint);
  font-size: 13px;
  text-align: center;
}

.group {
  margin-top: 16px;
  padding: 18px 20px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
}
.group-title {
  margin: 0 0 14px;
  font-size: 15px;
  font-weight: 760;
  color: var(--text);
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}
.metric {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-raised);
  text-align: left;
}
button.metric {
  cursor: pointer;
  color: inherit;
}
button.metric:hover {
  border-color: var(--line-strong);
  background: #16242f;
}
.metric .num {
  font-size: 26px;
  font-weight: 780;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.metric .num.ok {
  color: var(--accent-strong);
}
.metric .num.warn {
  color: var(--warn);
}
.metric .num.danger {
  color: var(--danger);
}
.metric .num.idle {
  color: var(--text-dim);
}
.metric .label {
  color: var(--text-dim);
  font-size: 12px;
  font-weight: 600;
}
.metric .arrow {
  color: var(--accent-strong);
  font-style: normal;
}

.attention-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}
.attention-list li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-raised);
}
.attention-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: var(--radius-pill);
  font-size: 11px;
  font-weight: 700;
}
.attention-badge.danger {
  color: #ef8585;
  background: #2a1515;
}
.attention-badge.warn {
  color: #e6c06a;
  background: #2a2210;
}
.attention-list b {
  font-size: 18px;
  font-weight: 780;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  margin-left: auto;
}
.attention-list button {
  min-height: 30px;
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  color: var(--text);
  background: var(--surface-hi);
  cursor: pointer;
  font-size: 12px;
}
.attention-list button:hover {
  background: #172834;
}
.attention-list .arrow {
  color: var(--accent-strong);
  font-style: normal;
}
.all-clear {
  margin: 0;
  color: var(--accent-strong);
  font-size: 14px;
}

.recent-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.recent-head .group-title {
  margin: 0;
}
.recent-head .ghost {
  min-height: 30px;
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  color: var(--text-dim);
  background: transparent;
  cursor: pointer;
  font-size: 12px;
}
.recent-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}
.recent-list li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-raised);
  font-size: 12px;
}
.task-icon {
  width: 30px;
  height: 30px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 8px;
  color: #8fb7e8;
  background: #12233a;
}
.task-title {
  flex: 1;
  color: var(--text);
  font-weight: 650;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-badge {
  padding: 3px 9px;
  border-radius: var(--radius-pill);
  font-size: 11px;
  font-weight: 700;
  flex: none;
}
.task-badge.ok {
  color: #7fd08a;
  background: #14301c;
}
.task-badge.warn {
  color: #e6c06a;
  background: #2a2210;
}
.task-badge.danger {
  color: #ef8585;
  background: #2a1515;
}
.task-badge.idle {
  color: #8fb7e8;
  background: #152438;
}
.task-meta {
  color: var(--text-dim);
  white-space: nowrap;
}
.task-time {
  color: var(--text-faint);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 900px) {
  .home {
    padding: 16px;
  }
}
@media (max-width: 720px) {
  .head {
    flex-direction: column;
  }
  .recent-list li {
    flex-wrap: wrap;
  }
  .task-meta {
    order: 5;
    width: 100%;
  }
}
</style>
