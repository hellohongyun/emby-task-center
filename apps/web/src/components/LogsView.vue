<script setup lang="ts">
import { nextTick, ref, watch } from "vue";

import { useLogs } from "../composables/useLogs";
import type { LogEntry, LogLevel } from "../types";

const props = withDefaults(defineProps<{ requireAuth: () => void; autoRefreshMs?: number }>(), { autoRefreshMs: 1000 });
const {
  logs,
  loading,
  error,
  paused,
  following,
  hasMore,
  maxVisibleLogs,
  level,
  source,
  module,
  runId,
  query,
  reset,
  refresh,
  loadMore,
  downloadUrl,
  togglePause,
  setFollowing,
} = useLogs(props.requireAuth, { autoRefreshMs: props.autoRefreshMs });

const viewport = ref<HTMLElement>();
const expanded = ref<number>();
const levelLabels: Record<LogLevel, string> = { info: "信息", warn: "警告", error: "错误" };
const moduleLabels: Record<string, string> = {
  "qq-avatar": "QQ 头像同步",
  "member-registration": "会员注册",
  "library-scan": "媒体库扫描",
  http: "HTTP 接口",
  server: "服务端",
  web: "前端",
};
const clockFormat = new Intl.DateTimeFormat("zh-CN", { timeStyle: "medium", hourCycle: "h23" });
const dateFormat = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" });

function entryModule(entry: LogEntry) {
  const key = entry.module ?? (entry.source === "server" && entry.method ? "http" : entry.source);
  return moduleLabels[key] ?? key;
}

function atBottom(panel: HTMLElement) {
  return panel.scrollHeight - panel.scrollTop - panel.clientHeight <= 20;
}

function syncScrollPosition() {
  const panel = viewport.value;
  if (panel) setFollowing(atBottom(panel));
}

function jumpToLatest() {
  const panel = viewport.value;
  if (panel) panel.scrollTop = panel.scrollHeight;
  setFollowing(true);
}

watch(logs, async (next, previous) => {
  const panel = viewport.value;
  if (!panel) return;
  const keepFollowing = following.value;
  const prepended = previous[0] && next[0] && next[0].id < previous[0].id;
  const previousHeight = panel.scrollHeight;
  const previousTop = panel.scrollTop;
  await nextTick();
  if (viewport.value !== panel) return;
  if (prepended) panel.scrollTop = previousTop + panel.scrollHeight - previousHeight;
  else if (keepFollowing && following.value) jumpToLatest();
});
watch([level, source, module, query, runId], () => {
  expanded.value = undefined;
  reset();
});
</script>

<template>
  <section class="logs-view" aria-labelledby="logs-title">
    <header class="logs-heading">
      <div>
        <h1 id="logs-title">系统日志</h1>
        <p>查看后端任务步骤、接口调用及前端错误。</p>
      </div>
      <span class="live-state" :class="{ paused }" role="status">
        {{ paused ? "已暂停" : !following ? "浏览历史" : props.autoRefreshMs > 0 ? "实时更新" : "手动刷新" }}
      </span>
    </header>

    <div class="logs-controls">
      <div class="logs-actions">
        <button v-if="props.autoRefreshMs > 0" type="button" class="live-toggle" @click="togglePause">
          {{ paused ? "恢复自动刷新" : "暂停自动刷新" }}
        </button>
        <a :href="downloadUrl()" class="download-log">下载日志</a>
        <button type="button" :disabled="loading" @click="refresh">刷新</button>
        <button v-if="!following" type="button" @click="jumpToLatest">跳到最新</button>
      </div>
      <div class="logs-filters">
        <label
          >模块
          <select v-model="module" aria-label="模块">
            <option value="">全部</option>
            <option v-for="(label, key) in moduleLabels" :key="key" :value="key">{{ label }}</option>
          </select>
        </label>
        <label
          >级别
          <select v-model="level" aria-label="级别">
            <option value="">全部</option>
            <option v-for="(label, key) in levelLabels" :key="key" :value="key">{{ label }}</option>
          </select>
        </label>
        <label
          >来源
          <select v-model="source" aria-label="来源">
            <option value="">全部</option>
            <option value="server">服务端</option>
            <option value="web">前端</option>
          </select>
        </label>
        <label class="log-search"
          >关键字
          <input v-model="query" type="search" aria-label="关键字" placeholder="搜索消息、路径或详情" />
        </label>
        <label v-if="runId" class="run-filter"
          >执行编号
          <input v-model="runId" type="search" aria-label="执行编号" />
        </label>
      </div>
    </div>

    <p v-if="error" class="logs-error" role="alert">{{ error }} <button type="button" @click="refresh">重试</button></p>
    <div
      ref="viewport"
      class="log-viewport"
      role="region"
      aria-label="日志记录"
      tabindex="0"
      @scroll.passive="syncScrollPosition"
    >
      <div v-if="hasMore" class="older-logs">
        <button type="button" :disabled="loading || logs.length >= maxVisibleLogs" @click="loadMore">加载更多</button>
      </div>
      <p v-if="!logs.length" class="logs-empty">{{ loading ? "正在读取日志…" : "暂无日志" }}</p>
      <ul v-else class="log-list" aria-label="日志列表">
        <li v-for="entry in logs" :key="entry.id" class="log-entry" :class="entry.level">
          <time :datetime="entry.createdAt" :title="dateFormat.format(new Date(entry.createdAt))">
            {{ clockFormat.format(new Date(entry.createdAt)) }}
          </time>
          <span class="log-module">{{ entryModule(entry) }}</span>
          <span class="log-level">{{ levelLabels[entry.level] }}</span>
          <div class="log-content">
            <span class="log-message">{{ entry.message }}</span>
            <span v-if="entry.path || entry.status != null || entry.durationMs != null" class="log-meta">
              <code v-if="entry.path">{{ entry.method ? entry.method + " " : "" }}{{ entry.path }}</code>
              <span v-if="entry.status != null">{{ entry.status }}</span>
              <span v-if="entry.durationMs != null">{{ entry.durationMs }}ms</span>
            </span>
          </div>
          <button
            v-if="entry.detail || entry.runId"
            type="button"
            class="log-details-button"
            :aria-expanded="expanded === entry.id"
            @click="expanded = expanded === entry.id ? undefined : entry.id"
          >
            {{ expanded === entry.id ? "收起详情" : "查看详情" }}
          </button>
          <div v-if="expanded === entry.id" class="log-details">
            <button v-if="entry.runId" type="button" @click="runId = entry.runId">查看本次执行</button>
            <code v-if="entry.runId">{{ entry.runId }}</code>
            <pre v-if="entry.detail">{{ entry.detail }}</pre>
          </div>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped src="./LogsView.css"></style>
