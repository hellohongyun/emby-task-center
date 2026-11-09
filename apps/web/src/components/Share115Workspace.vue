<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  share115ErrorMessage,
  share115StatusLabels,
  useShare115Api,
  type Share115Item,
  type Share115RejectedLink,
  type Share115Status,
} from "../composables/share-115-api";
import Share115Record from "./Share115Record.vue";

const props = defineProps<{ admin?: boolean; requireAuth?: () => void }>();
const api = useShare115Api(props.admin, props.requireAuth);
const shareText = ref("");
const accessCode = ref("");
const note = ref("");
const items = ref<Share115Item[]>([]);
const accepting = ref(false);
const loaded = ref(false);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const lastPage = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));
const status = ref<Share115Status | "">("");
const query = ref("");
const activeQuery = ref("");
const readError = api.reader.error;
const writeError = api.writer.error;
const isReading = computed(() => Boolean(api.reader.busy.value.list));
const isWriting = computed(() => Boolean(api.writer.busy.value.write));
const notice = ref("");
const rejected = ref<Share115RejectedLink[]>([]);
let pollTimer: ReturnType<typeof setInterval> | undefined;

async function load() {
  const params = new URLSearchParams({ page: String(page.value), pageSize: String(pageSize) });
  if (status.value) params.set("status", status.value);
  if (activeQuery.value) params.set("q", activeQuery.value);
  const result = await api.list(params);
  if (!result) return;
  items.value = result.items;
  total.value = result.total;
  accepting.value = result.accepting;
  loaded.value = true;
  if (page.value > lastPage.value) {
    page.value = lastPage.value;
    await load();
  }
}

function filter() {
  activeQuery.value = query.value.trim();
  page.value = 1;
  items.value = [];
  void load();
}

function turn(offset: number) {
  page.value += offset;
  items.value = [];
  void load();
}

async function submit() {
  if (!accepting.value || isWriting.value || !shareText.value.trim()) return;
  api.reader.cancel("list");
  notice.value = "";
  rejected.value = [];
  const result = await api.submit({
    shareText: shareText.value.trim(),
    ...(accessCode.value.trim() ? { accessCode: accessCode.value.trim() } : {}),
    ...(note.value.trim() ? { note: note.value.trim() } : {}),
  });
  if (!result) return;
  const submitted = result.items ?? (result.item ? [result.item] : []);
  rejected.value = result.rejected ?? [];
  shareText.value = rejected.value.map(({ retryText }) => retryText).join("\n\n");
  accessCode.value = "";
  if (rejected.value.length) {
    notice.value = `已提交 ${submitted.length} 条，${rejected.value.length} 条未提交。输入框已保留未提交的链接。`;
  } else {
    note.value = "";
    const first = submitted[0];
    notice.value =
      submitted.length === 1 && first
        ? `已提交 #${first.id}，当前状态为${share115StatusLabels[first.status]}。`
        : `已提交 ${submitted.length} 条链接，可在下方查看进度。`;
  }
  if (!submitted.length) return;
  status.value = "";
  query.value = "";
  activeQuery.value = "";
  page.value = 1;
  items.value = submitted;
  total.value = Math.max(submitted.length, total.value);
  await load();
}

async function resolve(jobId: number, nextStatus: "saved" | "failed") {
  if (!props.admin || isWriting.value) return;
  api.reader.cancel("list");
  notice.value = "";
  const result = await api.resolve(jobId, nextStatus);
  if (!result) return;
  items.value = items.value
    .map((item) => (item.jobId === jobId ? { ...item, status: nextStatus, resultMessage: null } : item))
    .filter((item) => !status.value || item.status === status.value);
  notice.value = `任务 #${jobId} 已标记为${share115StatusLabels[nextStatus]}。`;
  await load();
}

onMounted(() => {
  void load();
  pollTimer = setInterval(() => {
    if (document.hidden || isReading.value || isWriting.value) return;
    if (items.value.some((item) => item.status === "queued" || item.status === "running")) void load();
  }, 8000);
});
onBeforeUnmount(() => clearInterval(pollTimer));
</script>

<template>
  <div class="share-workspace" :class="{ 'admin-workspace': admin }">
    <header class="share-heading">
      <h1>115 转存</h1>
      <p v-if="admin">提交分享链接、查看全部转存记录，并核对结果待确认的任务。</p>
      <p v-else>提交 115 分享链接后，后台自动转存。你可以在下方查看进度。</p>
    </header>

    <form class="share-panel share-form" @submit.prevent="submit">
      <h2>提交分享</h2>
      <p v-if="loaded && !accepting" class="hint" role="status">
        {{
          admin
            ? "当前暂不可提交转存。请在系统设置中配置 TgtoDrive OpenAPI 令牌并开启「115 自动转存」。"
            : "当前暂不可提交转存，仍可查看历史记录。"
        }}
      </p>
      <label>
        <span>115 分享链接或文案</span>
        <textarea
          v-model="shareText"
          rows="3"
          maxlength="4000"
          placeholder="粘贴 115 分享链接或整段分享文案"
          aria-describedby="share-115-batch-help"
          required
          :disabled="!accepting || isWriting"
        ></textarea>
      </label>
      <p id="share-115-batch-help" class="hint">
        一次最多提交 10 条。各自的访问码可写在链接中，也可紧跟对应链接写「访问码：1234」。
      </p>
      <label>
        <span>访问码 <small>仅在单条链接缺少访问码时填写</small></span>
        <input
          v-model="accessCode"
          type="text"
          maxlength="4"
          pattern="[A-Za-z0-9]{4}"
          autocomplete="off"
          :disabled="!accepting || isWriting"
        />
      </label>
      <label>
        <span>片名或补充说明 <small>选填，应用于本批链接</small></span>
        <textarea
          v-model="note"
          rows="2"
          maxlength="500"
          placeholder="如片名、第 2 季或缺少的集号"
          :disabled="!accepting || isWriting"
        ></textarea>
      </label>
      <button type="submit" class="primary" :disabled="!accepting || isWriting || !shareText.trim()">
        {{ isWriting ? "正在提交…" : "提交转存" }}
      </button>
    </form>

    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <ul v-if="rejected.length" class="error batch-errors" role="alert">
      <li v-for="entry in rejected" :key="entry.index">
        第 {{ entry.index }} 条链接：{{ share115ErrorMessage(entry.error) }}
      </li>
    </ul>
    <p v-if="writeError" class="error" role="alert">{{ writeError }}</p>
    <section class="share-panel" aria-labelledby="share-115-records" :aria-busy="isReading">
      <header class="records-head">
        <div>
          <h2 id="share-115-records">{{ admin ? "全部提交记录" : "我的提交记录" }}</h2>
          <p v-if="loaded">共 {{ total }} 条</p>
        </div>
        <button type="button" :disabled="isReading || isWriting" @click="load">刷新</button>
      </header>
      <div class="filters">
        <label>
          <span>转存状态</span>
          <select v-model="status" :disabled="isWriting" @change="filter">
            <option value="">全部状态</option>
            <option v-for="(label, value) in share115StatusLabels" :key="value" :value="value">{{ label }}</option>
          </select>
        </label>
        <form v-if="admin" role="search" @submit.prevent="filter">
          <label>
            <span>搜索提交记录</span>
            <input v-model="query" type="search" maxlength="200" placeholder="提交人、分享码或标题" />
          </label>
          <button type="submit" :disabled="isWriting">搜索</button>
        </form>
      </div>
      <p v-if="readError" class="error" role="alert">{{ readError }}</p>
      <p v-if="!items.length && isReading" class="empty" role="status">正在加载记录…</p>
      <p v-else-if="!items.length && !readError" class="empty">暂无符合条件的提交记录。</p>
      <ul v-if="items.length" class="share-records">
        <li v-for="item in items" :key="item.id">
          <Share115Record :item="item" :admin="admin" :disabled="isWriting" @resolve="resolve(item.jobId, $event)" />
        </li>
      </ul>
      <nav v-if="lastPage > 1" class="pages" aria-label="提交记录分页">
        <button type="button" :disabled="page <= 1 || isReading || isWriting" @click="turn(-1)">上一页</button>
        <span>{{ page }} / {{ lastPage }}</span>
        <button type="button" :disabled="page >= lastPage || isReading || isWriting" @click="turn(1)">下一页</button>
      </nav>
    </section>
  </div>
</template>

<style scoped src="./Share115Workspace.css"></style>
