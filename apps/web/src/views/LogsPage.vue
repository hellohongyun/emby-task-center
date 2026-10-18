<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";

import AuditLogsView from "../components/AuditLogsView.vue";
import LogsView from "../components/LogsView.vue";
import { useAppServices } from "../state/app-services";

/**
 * 日志页（原「日志」+「审计日志」合并）。
 *
 * 两个都是"出问题来查痕迹"的只读列表，分开放没有意义：一个查系统日志、一个查管理操作留痕。
 * Tab 存在 URL 上（`?tab=audit`），旧的 `/login/audits` 会重定向到这里，书签不会失效。
 */
type LogTab = "system" | "audit";
const TABS: Array<{ key: LogTab; label: string; hint: string }> = [
  { key: "system", label: "系统日志", hint: "前端请求与后端接口调用" },
  { key: "audit", label: "操作审计", hint: "管理操作全量留痕" },
];

const services = useAppServices();
const route = useRoute();
const router = useRouter();

const tab = computed<LogTab>(() => (route.query.tab === "audit" ? "audit" : "system"));

function select(next: LogTab) {
  void router.replace({ path: route.path, query: next === "audit" ? { tab: "audit" } : {} });
}
</script>

<template>
  <div class="logs-page">
    <nav class="log-tabs" aria-label="日志类型">
      <button
        v-for="item in TABS"
        :key="item.key"
        type="button"
        :class="{ active: tab === item.key }"
        :aria-current="tab === item.key ? 'page' : undefined"
        @click="select(item.key)"
      >
        <b>{{ item.label }}</b
        ><small>{{ item.hint }}</small>
      </button>
    </nav>
    <LogsView v-if="tab === 'system'" :require-auth="services.requireAuth" />
    <AuditLogsView v-else :require-auth="services.requireAuth" />
  </div>
</template>

<style scoped>
.logs-page {
  display: grid;
  gap: 0;
}
.log-tabs {
  display: flex;
  gap: 8px;
  padding: 16px 22px 0;
  max-width: 1180px;
  margin: 0 auto;
  width: 100%;
}
.log-tabs button {
  display: grid;
  gap: 3px;
  min-height: 44px;
  padding: 9px 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  color: var(--text-dim);
  background: var(--surface);
  cursor: pointer;
  text-align: left;
}
.log-tabs button b {
  font-size: 13px;
}
.log-tabs button small {
  color: var(--text-faint);
  font-size: 11px;
}
.log-tabs button.active {
  border-color: var(--line-strong);
  color: var(--text);
  background: var(--surface-hi);
}
.log-tabs button.active b {
  color: var(--text);
}
</style>
