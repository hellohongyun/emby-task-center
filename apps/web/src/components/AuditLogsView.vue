<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

interface AuditRow {
  id: number;
  operator: string;
  action: string;
  targetType: string;
  targetId: number | null;
  before: string | null;
  after: string | null;
  note: string | null;
  createdAt: string;
}

const props = defineProps<{ requireAuth: () => void }>();
const logs = ref<AuditRow[]>([]);
const loading = ref(false);
const error = ref("");
const actionFilter = ref("all");

const actionGroups = [
  { value: "all", label: "全部动作" },
  { value: "member.", label: "会员操作" },
  { value: "provider.", label: "内容源" },
  { value: "settings.", label: "设置变更" },
];

onMounted(() => void load());

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const response = await fetch("/api/audit-logs?limit=300", { credentials: "include" });
    if (response.status === 401) {
      props.requireAuth();
      return;
    }
    if (!response.ok) {
      error.value = "无法读取审计日志。";
      return;
    }
    const body = (await response.json()) as { logs: AuditRow[] };
    logs.value = body.logs;
  } catch {
    error.value = "无法读取审计日志。";
  } finally {
    loading.value = false;
  }
}

function actionLabel(action: string): string {
  return (
    {
      "member.added": "添加会员",
      "member.updated": "更新会员",
      "member.deleted": "删除会员",
      "member.mail_pref": "代设邮件偏好",
      // 追更已整体下线，但历史日志里还留着这几类动作：保留可读标签，别让旧记录变成裸 action 字符串。
      "follow.created": "新建追更任务（历史）",
      "follow.map_tmdb": "追更绑定 TMDB（历史）",
      "follow.track_mode": "追更标记（历史）",
      "task.created": "新建任务",
      "task.tmdb_rebound": "改绑 TMDB 条目",
      "provider.updated": "更新内容源",
      "settings.notify_retention": "通知保留期变更",
      "settings.mail_defaults": "邮件默认变更",
      "article.updated": "更新平台说明",
    }[action] ?? action
  );
}

const filtered = computed(() =>
  actionFilter.value === "all" ? logs.value : logs.value.filter((row) => row.action.startsWith(actionFilter.value)),
);
</script>

<template>
  <section class="audits-view">
    <header class="head">
      <div>
        <h2>审计日志</h2>
        <p>管理操作全量留痕：会员 / 内容源 / 设置变更。</p>
      </div>
      <button type="button" class="refresh" :disabled="loading" @click="load">刷新</button>
    </header>
    <p v-if="error" class="msg" role="alert">{{ error }}</p>

    <div class="filters">
      <select v-model="actionFilter" aria-label="动作筛选">
        <option v-for="group in actionGroups" :key="group.value" :value="group.value">{{ group.label }}</option>
      </select>
      <span class="count">共 {{ filtered.length }} 条</span>
    </div>

    <div v-if="!filtered.length" class="empty">{{ loading ? "加载中…" : "暂无审计记录。" }}</div>
    <ul v-else class="audit-list">
      <li v-for="row in filtered" :key="row.id">
        <span class="a-time">{{ new Date(row.createdAt).toLocaleString() }}</span>
        <b class="a-action">{{ actionLabel(row.action) }}</b>
        <small class="a-target"
          >{{ row.targetType }}<template v-if="row.targetId"> #{{ row.targetId }}</template> · {{ row.operator }}</small
        >
        <small v-if="row.note" class="a-note">{{ row.note }}</small>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.audits-view {
  padding: 22px;
  max-width: 1080px;
  margin: 0 auto;
}
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}
.head h2 {
  margin: 0 0 6px;
  font-size: 24px;
}
.head p {
  margin: 0;
  color: #84929b;
  font-size: 13px;
}
.refresh {
  min-height: 40px;
  padding: 0 14px;
  border: 1px solid #2a3c46;
  border-radius: 8px;
  color: #d6dee3;
  background: #101e27;
  cursor: pointer;
}
.msg {
  color: #e6c06a;
  font-size: 13px;
}
.filters {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.filters select {
  min-height: 36px;
  padding: 0 10px;
  border: 1px solid #2a3c46;
  border-radius: 8px;
  color: #cdd5dc;
  background: #101e27;
}
.count {
  color: #63727d;
  font-size: 11px;
}
.audit-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}
.audit-list li {
  display: grid;
  grid-template-columns: 170px 140px 1fr;
  gap: 8px 12px;
  padding: 11px 13px;
  border: 1px solid #1e303b;
  border-radius: 10px;
  background: #0d1921;
}
.a-time {
  color: #63727d;
  font-size: 11px;
}
.a-action {
  color: #eef2f4;
  font-size: 13px;
}
.a-target {
  color: #7e8d96;
  font-size: 12px;
}
.a-note {
  grid-column: 1 / -1;
  color: #c8b06b;
  font-size: 12px;
}
.empty {
  padding: 30px;
  border: 1px dashed #22303b;
  border-radius: 12px;
  color: #63727d;
  text-align: center;
}
@media (max-width: 720px) {
  .audit-list li {
    grid-template-columns: 1fr;
  }
}
</style>
