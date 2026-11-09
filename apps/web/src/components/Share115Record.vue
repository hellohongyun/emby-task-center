<script setup lang="ts">
import { computed, ref } from "vue";
import { share115StatusLabels, type Share115Item } from "../composables/share-115-api";

const props = defineProps<{ item: Share115Item; admin?: boolean; disabled?: boolean }>();
const emit = defineEmits<{ resolve: [status: "saved" | "failed"] }>();
const resolving = ref(false);
const mediaNames = computed(() =>
  (props.item.identifiedMedia ?? []).map((entry) => (typeof entry === "string" ? entry : entry.title)).filter(Boolean),
);
const title = computed(() => mediaNames.value[0] || props.item.shareTitle || props.item.note || props.item.shareCode);
const dateFormat = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" });
function formatDate(value: string) {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : dateFormat.format(time);
}
</script>

<template>
  <article class="share-record">
    <header>
      <h3>{{ title }}</h3>
      <span class="badge" :data-status="item.status">{{ share115StatusLabels[item.status] }}</span>
    </header>
    <p v-if="admin && item.adminUsername" class="meta">管理员 · {{ item.adminUsername }}</p>
    <p v-else-if="admin && item.memberEmail" class="meta">{{ item.memberEmail }}</p>
    <p class="meta">
      提交 #{{ item.id }} · <time :datetime="item.submittedAt">{{ formatDate(item.submittedAt) }}</time>
    </p>
    <p v-if="item.resultMessage" class="result">{{ item.resultMessage }}</p>
    <details>
      <summary>查看详情</summary>
      <dl>
        <div>
          <dt>分享链接</dt>
          <dd>
            <a :href="item.shareUrl" target="_blank" rel="noopener noreferrer">{{ item.shareUrl }}</a>
          </dd>
        </div>
        <div v-if="item.accessCode">
          <dt>访问码</dt>
          <dd>{{ item.accessCode }}</dd>
        </div>
        <div v-if="item.shareTitle && item.shareTitle !== title">
          <dt>分享标题</dt>
          <dd>{{ item.shareTitle }}</dd>
        </div>
        <div v-if="mediaNames.length > 1">
          <dt>识别到的影片</dt>
          <dd>{{ mediaNames.join("、") }}</dd>
        </div>
        <div v-if="item.note && item.note !== title">
          <dt>补充说明</dt>
          <dd>{{ item.note }}</dd>
        </div>
        <div v-if="item.startedAt">
          <dt>开始时间</dt>
          <dd>
            <time :datetime="item.startedAt">{{ formatDate(item.startedAt) }}</time>
          </dd>
        </div>
        <div v-if="item.finishedAt">
          <dt>完成时间</dt>
          <dd>
            <time :datetime="item.finishedAt">{{ formatDate(item.finishedAt) }}</time>
          </dd>
        </div>
        <div v-if="admin">
          <dt>转存任务</dt>
          <dd>#{{ item.jobId }}</dd>
        </div>
        <div v-if="admin && item.targetFolderId">
          <dt>目标目录 ID</dt>
          <dd>{{ item.targetFolderId }}</dd>
        </div>
      </dl>
    </details>
    <div v-if="admin && item.status === 'unconfirmed'" class="resolution">
      <button v-if="!resolving" type="button" :disabled="disabled" @click="resolving = true">核对结果</button>
      <template v-else>
        <p>请先到 TgtoDrive 核对转存结果，再标记这条任务。</p>
        <div class="resolution-actions">
          <button type="button" :disabled="disabled" @click="emit('resolve', 'saved')">标记已保存</button>
          <button type="button" :disabled="disabled" @click="emit('resolve', 'failed')">标记失败</button>
          <button type="button" :disabled="disabled" @click="resolving = false">取消</button>
        </div>
      </template>
    </div>
  </article>
</template>

<style scoped>
.share-record {
  display: grid;
  gap: 5px;
  padding: 13px 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--bg);
  overflow-wrap: anywhere;
}
header,
.resolution-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
h3,
p,
dl,
dd {
  margin: 0;
}
h3 {
  font-size: 15px;
}
.meta,
summary,
dt,
.resolution p {
  color: var(--text-dim);
  font-size: 13px;
}
.result,
dl {
  font-size: 13px;
}
.badge {
  flex: none;
  padding: 3px 8px;
  border-radius: 999px;
  color: var(--text-dim);
  background: var(--input);
  font-size: 12px;
}
.badge[data-status="saved"],
.badge[data-status="already_exists"] {
  color: var(--accent-strong);
  background: var(--accent-dim);
}
.badge[data-status="failed"] {
  color: var(--danger);
}
.badge[data-status="unconfirmed"] {
  color: var(--warn);
}
summary {
  width: fit-content;
  padding: 5px 0;
  cursor: pointer;
}
dl {
  display: grid;
  gap: 5px;
  margin-block: 3px;
}
dl > div {
  display: grid;
  grid-template-columns: 90px minmax(0, 1fr);
  gap: 8px;
}
a {
  color: var(--accent-strong);
}
.resolution p {
  margin-block: 4px 8px;
}
.resolution-actions {
  justify-content: flex-start;
}
.resolution button {
  min-height: 36px;
  padding: 0 9px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  color: var(--text);
  background: var(--input);
  cursor: pointer;
}
.resolution button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
