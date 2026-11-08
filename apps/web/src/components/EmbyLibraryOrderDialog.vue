<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { fetchJsonWithTimeout } from "../composables/request-timeout";

interface Account {
  id: string;
  name: string;
}

interface PreviewRow extends Account {
  status: "change" | "unchanged" | "skipped" | "failed";
  before: string[];
  after: string[];
  reason?: string;
}

interface Preview {
  previewToken: string;
  source: Account;
  libraries: string[];
  users: PreviewRow[];
}

interface ResultRow extends Account {
  status: "updated" | "unchanged" | "skipped" | "failed";
  reason?: string;
}

const props = defineProps<{ requireAuth: () => void }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const resultHeading = ref<HTMLElement>();
const admins = ref<Account[]>();
const sourceUserId = ref("");
const preview = ref<Preview>();
const results = ref<ResultRow[]>();
const operation = ref<"load" | "preview" | "apply">();
const error = ref("");
const controller = new AbortController();
const base = "/api/emby/library-order";
const changeCount = computed(() => preview.value?.users.filter((user) => user.status === "change").length ?? 0);
const messages: Record<string, string> = {
  library_order_not_configured: "请先在系统设置连接 Emby。",
  library_order_invalid_source: "该账号已无法作为样板，请关闭弹窗后重新打开。",
  library_order_preview_expired: "预览已失效，请重新预览。",
  library_order_source_changed: "样板账号的媒体库已变更，请重新预览。",
  library_order_connection_changed: "Emby 连接已变更，请关闭弹窗后重新打开。",
  library_order_busy: "另一次同步正在执行，请稍后重新预览。",
  library_order_role_unknown: "无法确认该账号为普通用户。",
  library_order_user_changed: "账号或媒体库顺序已变更，请重新预览。",
  library_order_read_failed: "读取 Emby 媒体库失败。",
  library_order_write_failed: "同步结果未确认，请重新预览核对。",
  library_order_verify_failed: "Emby 返回的顺序未通过核对，请重新预览。",
};
const statusLabels = {
  change: "待同步",
  unchanged: "顺序一致",
  skipped: "已跳过",
  failed: "失败",
  updated: "已同步",
} as const;
const previewStatuses = ["change", "unchanged", "skipped", "failed"] as const;
const resultStatuses = ["updated", "unchanged", "skipped", "failed"] as const;

function rowMessage(reason?: string) {
  return reason ? (messages[reason] ?? "请重新预览核对该账号。") : "";
}

async function request<T>(step: NonNullable<typeof operation.value>, payload?: object): Promise<T | undefined> {
  if (operation.value || controller.signal.aborted) return;
  operation.value = step;
  error.value = "";
  const url = step === "load" ? base : `${base}/${step}`;
  const fallback = step === "apply" ? "同步结果未确认，请重新预览核对后再操作。" : "读取媒体库顺序失败，请重试。";
  try {
    const { response, body } = await fetchJsonWithTimeout<T & { error?: string }>(
      fetch,
      url,
      {
        credentials: "include",
        signal: controller.signal,
        ...(payload
          ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }
          : {}),
      },
      step === "load" ? 15_000 : 120_000,
      true,
    );
    if (controller.signal.aborted) return;
    if (response.status === 401) {
      props.requireAuth();
      return;
    }
    if (!response.ok || !body) {
      error.value = messages[body?.error ?? ""] ?? fallback;
      return;
    }
    return body;
  } catch {
    if (!controller.signal.aborted) error.value = fallback;
  } finally {
    operation.value = undefined;
  }
}

function clearPreview() {
  preview.value = undefined;
  results.value = undefined;
  error.value = "";
}

async function loadAdmins() {
  if (operation.value) return;
  clearPreview();
  const body = await request<{ admins: Account[] }>("load");
  if (!body) return;
  admins.value = body.admins;
  if (!body.admins.some((account) => account.id === sourceUserId.value)) {
    sourceUserId.value = body.admins.length === 1 ? (body.admins[0]?.id ?? "") : "";
  }
}

async function loadPreview() {
  if (!sourceUserId.value || operation.value) return;
  clearPreview();
  preview.value = await request<Preview>("preview", { sourceUserId: sourceUserId.value });
}

async function apply() {
  if (!preview.value || !changeCount.value || operation.value || results.value) return;
  const result = await request<{ users: ResultRow[] }>("apply", { previewToken: preview.value.previewToken });
  if (!result) {
    preview.value = undefined;
    return;
  }
  results.value = result.users;
  await nextTick();
  resultHeading.value?.focus();
}

function close() {
  if (operation.value !== "apply") emit("close");
}

onMounted(() => {
  dialog.value?.showModal();
  void loadAdmins();
});
onBeforeUnmount(() => {
  controller.abort();
  if (dialog.value?.open) dialog.value.close();
});
</script>

<template>
  <dialog
    ref="dialog"
    class="order-dialog"
    aria-labelledby="emby-order-title"
    aria-describedby="emby-order-scope"
    @cancel.prevent="close"
  >
    <header class="order-header">
      <h3 id="emby-order-title">统一媒体库顺序</h3>
      <button type="button" class="close" :disabled="operation === 'apply'" aria-label="关闭" @click="close">×</button>
    </header>
    <div class="order-content" :aria-busy="Boolean(operation)">
      <p id="emby-order-scope" class="muted">
        按 Emby 管理员账号的媒体库顺序，调整现有普通用户可见的媒体库。每个账号独有的库按原顺序排在末尾。
      </p>
      <div v-if="admins?.length" class="source">
        <label>
          排序样板
          <select v-model="sourceUserId" :disabled="Boolean(operation)" @change="clearPreview">
            <option value="" disabled>选择 Emby 管理员账号</option>
            <option v-for="account in admins" :key="account.id" :value="account.id">{{ account.name }}</option>
          </select>
        </label>
        <button type="button" :disabled="!sourceUserId || Boolean(operation)" @click="loadPreview">
          {{ operation === "preview" ? "正在预览…" : preview ? "重新预览" : "预览顺序" }}
        </button>
      </div>
      <p v-else-if="operation === 'load'" role="status">正在读取管理员账号…</p>
      <p v-else-if="admins" class="muted">没有可作为样板的 Emby 管理员账号。</p>
      <button v-if="!admins?.length && !operation" type="button" @click="loadAdmins">重新读取</button>

      <p v-if="error" role="alert">{{ error }}</p>
      <section v-if="results" aria-labelledby="emby-order-result">
        <h4 id="emby-order-result" ref="resultHeading" tabindex="-1">同步结果</h4>
        <ul class="counts" aria-label="结果汇总">
          <li v-for="status in resultStatuses" :key="status" :data-status="status">
            {{ statusLabels[status] }} {{ results.filter((user) => user.status === status).length }}
          </li>
        </ul>
        <ul class="users" aria-label="各账号的同步结果">
          <li v-for="user in results" :key="user.id">
            <div class="user-line">
              <strong>{{ user.name }}</strong>
              <span class="badge" :data-status="user.status">{{ statusLabels[user.status] }}</span>
            </div>
            <p v-if="user.reason" class="muted">{{ rowMessage(user.reason) }}</p>
          </li>
        </ul>
      </section>
      <section v-else-if="preview" aria-labelledby="emby-order-preview">
        <h4 id="emby-order-preview">同步预览</h4>
        <details class="template-order">
          <summary>查看样板顺序 · {{ preview.source.name }}（{{ preview.libraries.length }} 个媒体库）</summary>
          <ol v-if="preview.libraries.length">
            <li v-for="(library, index) in preview.libraries" :key="index">{{ library }}</li>
          </ol>
        </details>
        <ul class="counts" aria-label="预览汇总">
          <li v-for="status in previewStatuses" :key="status" :data-status="status">
            {{ statusLabels[status] }} {{ preview.users.filter((user) => user.status === status).length }}
          </li>
        </ul>
        <p v-if="!preview.users.length" class="muted">没有普通用户可同步。</p>
        <ul v-else class="users" aria-label="各账号的顺序预览">
          <li v-for="user in preview.users" :key="user.id">
            <div class="user-line">
              <strong>{{ user.name }}</strong>
              <span class="badge" :data-status="user.status">{{ statusLabels[user.status] }}</span>
            </div>
            <p v-if="user.reason" class="muted">{{ rowMessage(user.reason) }}</p>
            <details v-if="user.status === 'change'">
              <summary>查看顺序变化</summary>
              <dl class="comparison">
                <div>
                  <dt>同步前</dt>
                  <dd>
                    <ol>
                      <li v-for="(library, index) in user.before" :key="index">{{ library }}</li>
                    </ol>
                  </dd>
                </div>
                <div>
                  <dt>同步后</dt>
                  <dd>
                    <ol>
                      <li v-for="(library, index) in user.after" :key="index">{{ library }}</li>
                    </ol>
                  </dd>
                </div>
              </dl>
            </details>
          </li>
        </ul>
      </section>
    </div>
    <footer v-if="preview" class="order-footer">
      <p v-if="operation === 'apply'" role="status">正在同步，请等待结果。</p>
      <button v-if="results" type="button" @click="close">完成</button>
      <button v-else type="button" class="primary" :disabled="!changeCount || Boolean(operation)" @click="apply">
        {{ operation === "apply" ? "正在同步…" : changeCount ? `确认同步 ${changeCount} 个账号` : "无需同步" }}
      </button>
    </footer>
  </dialog>
</template>

<style scoped src="./EmbyLibraryOrderDialog.css"></style>
