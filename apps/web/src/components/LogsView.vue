<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import { mdiRefresh } from "@mdi/js";
import { onMounted, ref } from "vue";

import { useLogs } from "../composables/useLogs";
import type { LogLevel, LogSource } from "../types";

const props = withDefaults(defineProps<{ requireAuth: () => void; autoRefreshMs?: number }>(), { autoRefreshMs: 5000 });
const { logs, loading, error, level, source, query, hasMore, setLevel, setSource, setQuery, load, loadMore } = useLogs(
  props.requireAuth,
  { autoRefreshMs: props.autoRefreshMs },
);
const expanded = ref<Set<number>>(new Set());
const refreshSeconds = Math.max(1, Math.round(props.autoRefreshMs / 1000));

onMounted(() => {
  void load();
});

const levelLabels: Record<LogLevel, string> = { info: "信息", warn: "警告", error: "错误" };
const sourceLabels: Record<LogSource, string> = { server: "服务端", web: "前端" };

function toggleDetail(id: number) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}
</script>

<template>
  <section class="logs-view" aria-labelledby="logs-title">
    <header>
      <div>
        <span>LOGS</span>
        <h1 id="logs-title">日志</h1>
        <p>记录前端请求与后端接口调用，用于调试排查。</p>
      </div>
      <div class="header-actions">
        <span class="auto-note">自动刷新：{{ refreshSeconds }} 秒</span>
        <button type="button" :disabled="loading" @click="load">
          <SvgIcon type="mdi" :path="mdiRefresh" :size="20" />刷新
        </button>
      </div>
    </header>

    <div class="filters">
      <label
        >级别<select :value="level" aria-label="级别" @change="setLevel(($event.target as HTMLSelectElement).value)">
          <option value="">全部</option>
          <option value="info">信息</option>
          <option value="warn">警告</option>
          <option value="error">错误</option>
        </select></label
      >
      <label
        >来源<select :value="source" aria-label="来源" @change="setSource(($event.target as HTMLSelectElement).value)">
          <option value="">全部</option>
          <option value="server">服务端</option>
          <option value="web">前端</option>
        </select></label
      >
      <label class="search"
        >关键字<input
          :value="query"
          type="search"
          placeholder="搜索消息、路径或详情"
          aria-label="关键字"
          @input="setQuery(($event.target as HTMLInputElement).value)"
      /></label>
    </div>

    <p v-if="error" class="error" role="alert">{{ error }}<button type="button" @click="load">重试</button></p>

    <div v-if="loading && !logs.length" class="empty">正在读取日志…</div>
    <div v-else-if="!logs.length" class="empty">暂无日志</div>
    <ul v-else class="log-list">
      <li v-for="entry in logs" :key="entry.id" class="log-entry">
        <div class="log-row">
          <time :datetime="entry.createdAt">{{
            new Date(entry.createdAt).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "medium" })
          }}</time>
          <b class="badge level" :class="entry.level">{{ levelLabels[entry.level] }}</b>
          <span class="badge source">{{ sourceLabels[entry.source] }}</span>
          <code class="request">{{ entry.method ? `${entry.method} ` : "" }}{{ entry.path ?? "" }}</code>
          <span v-if="entry.status != null" class="status" :class="{ failed: entry.status >= 400 }">{{
            entry.status
          }}</span>
          <span v-if="entry.durationMs != null" class="duration">{{ entry.durationMs }}ms</span>
          <button
            v-if="entry.detail"
            type="button"
            class="detail-toggle"
            :aria-expanded="expanded.has(entry.id)"
            @click="toggleDetail(entry.id)"
          >
            {{ expanded.has(entry.id) ? "收起详情" : "查看详情" }}
          </button>
        </div>
        <p class="message">{{ entry.message }}</p>
        <pre v-if="expanded.has(entry.id)" class="detail">{{ entry.detail }}</pre>
      </li>
    </ul>

    <footer class="load-more">
      <button v-if="hasMore" type="button" :disabled="loading" @click="loadMore">加载更多</button>
    </footer>
  </section>
</template>

<style scoped>
.logs-view {
  max-width: 1050px;
  margin: 0 auto;
}
.logs-view > header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin: 10px 0 18px;
}
.logs-view > header > div > span {
  color: #68bf6a;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.14em;
}
h1 {
  margin: 5px 0;
  font-size: 30px;
}
.logs-view > header p {
  margin: 0;
  color: #84929c;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 14px;
}
.auto-note {
  color: #7e8c96;
  font-size: 12px;
}
.logs-view button {
  min-height: 40px;
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
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
  padding: 14px 16px;
  border: 1px solid #20323c;
  border-radius: 10px;
  background: #0a151c;
}
.filters label {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #82909a;
  font-size: 12px;
}
.filters select,
.filters input {
  min-height: 38px;
  padding: 0 10px;
  border: 1px solid #263943;
  border-radius: 7px;
  color: #e8edef;
  background: #071119;
}
.filters label.search {
  flex: 1;
  min-width: 180px;
}
.filters input {
  width: 100%;
}
.error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
  padding: 12px;
  color: #ef8585;
  background: #241315;
}
.error button {
  border-color: #57343a;
  color: #ebb1b1;
  background: #251518;
}
.empty {
  padding: 30px;
  color: #7e8c96;
  text-align: center;
}
.log-list {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 0;
  margin: 0;
  list-style: none;
}
.log-entry {
  padding: 13px 16px;
  border: 1px solid #20323c;
  border-radius: 10px;
  background: #0a151c;
}
.log-entry + .log-entry {
  margin-top: 10px;
}
.log-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 9px;
}
.log-row time {
  color: #81909a;
  font-size: 12px;
}
.badge {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 800;
}
.badge.level.info {
  color: #74cd77;
  background: #10241b;
}
.badge.level.warn {
  color: #f0c75e;
  background: #241d0d;
}
.badge.level.error {
  color: #ef8585;
  background: #261314;
}
.badge.source {
  color: #8fb4d8;
  background: #12212e;
}
.request {
  color: #cfe0ec;
  font-size: 12px;
  font-weight: 650;
}
.status {
  color: #74cd77;
  font-size: 12px;
  font-weight: 800;
}
.status.failed {
  color: #ef8585;
}
.duration {
  color: #8b99a2;
  font-size: 12px;
}
.detail-toggle {
  border: 0;
  background: transparent;
  color: #6fb2f0;
  font-size: 12px;
  cursor: pointer;
  padding: 0 4px;
  min-height: 0;
}
.message {
  margin: 8px 0 0;
  color: #e8edef;
  font-size: 13px;
}
.detail {
  margin: 10px 0 0;
  padding: 10px 12px;
  overflow-x: auto;
  border: 1px solid #263943;
  border-radius: 7px;
  color: #a9b3b9;
  background: #071119;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}
.load-more {
  display: flex;
  justify-content: center;
  margin-top: 16px;
}
@media (max-width: 640px) {
  .logs-view > header {
    align-items: flex-start;
    flex-direction: column;
    gap: 10px;
  }
  .header-actions {
    width: 100%;
    justify-content: space-between;
  }
  .filters label {
    width: 100%;
  }
  .log-row {
    row-gap: 6px;
  }
}
</style>
