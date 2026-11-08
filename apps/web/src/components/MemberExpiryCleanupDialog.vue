<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { fetchJsonWithTimeout } from "../composables/request-timeout";
import {
  cleanupBlockLabels,
  cleanupCandidateDetail,
  memberCleanupSettings,
  type CleanupPreview,
  type MemberCleanupMode,
} from "./member-cleanup-settings";

type Policy = { days: number | null };
type Operation = "load" | "preview" | "save";

const props = withDefaults(defineProps<{ requireAuth: () => void; mode?: MemberCleanupMode }>(), { mode: "expiry" });
const emit = defineEmits<{ close: [] }>();
const settings = memberCleanupSettings[props.mode];
const dialog = ref<HTMLDialogElement>();
const previewHeading = ref<HTMLElement>();
const days = ref<number | null>();
const draft = ref<number | string>(settings.defaultDays);
const preview = ref<CleanupPreview>();
const confirmed = ref(false);
const operation = ref<Operation>();
const needsReload = ref(false);
const error = ref("");
const notice = ref("");
const controller = new AbortController();
const validDays = computed(() => typeof draft.value === "number" && isValidDays(draft.value));
const ready = computed(() => !operation.value && !needsReload.value && days.value !== undefined);

function isValidDays(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 3650;
}

function clearPreview() {
  preview.value = undefined;
  confirmed.value = false;
}

function editDays() {
  clearPreview();
  error.value = "";
  notice.value = "";
}

async function request<T>(step: Operation, payload?: object) {
  operation.value = step;
  error.value = "";
  notice.value = "";
  try {
    const { response, body } = await fetchJsonWithTimeout<T & { error?: string }>(
      fetch,
      step === "preview" ? `${settings.endpoint}/preview` : settings.endpoint,
      {
        credentials: "include",
        signal: controller.signal,
        ...(step === "load"
          ? {}
          : {
              method: step === "preview" ? "POST" : "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            }),
      },
      step === "load" ? 15_000 : 60_000,
      true,
    );
    if (controller.signal.aborted) return;
    if (response.status === 401) {
      props.requireAuth();
      return;
    }
    if (response.ok && body) return body;
    switch (body?.error) {
      case "member_cleanup_policy_changed":
        needsReload.value = true;
        error.value = "清理设置已被其他操作修改，请重新读取。";
        break;
      case "member_cleanup_preview_expired":
        error.value = "预览已失效，请重新预览。";
        break;
      case "member_cleanup_preview_changed":
        error.value = "预览范围或 Emby 连接已变化，请重新预览。";
        break;
      case "member_cleanup_activity_unavailable":
        error.value = "无法核对 Emby 播放记录，请检查连接后重新预览。";
        break;
      case "invalid_request":
        error.value = "请填写 1 至 3650 的整数天数后重新预览。";
        break;
      default:
        throw new Error("member_cleanup_request_failed");
    }
  } catch {
    if (controller.signal.aborted) return;
    needsReload.value = step !== "preview";
    error.value = {
      load: "读取清理设置失败，请重新读取。",
      preview: "读取清理预览失败，请重试。",
      save: "保存结果未确认，请重新读取设置后核对。",
    }[step];
  } finally {
    operation.value = undefined;
  }
}

async function load() {
  if (operation.value) return;
  clearPreview();
  const previousDays = days.value;
  const result = await request<Policy>("load");
  if (!result) return;
  if (result.days !== null && !isValidDays(result.days)) {
    needsReload.value = true;
    error.value = "清理设置无法核对，请重新读取。";
    return;
  }
  days.value = result.days;
  if (draft.value === (previousDays ?? settings.defaultDays)) draft.value = result.days ?? settings.defaultDays;
  needsReload.value = false;
}

async function loadPreview() {
  if (!ready.value || !isValidDays(draft.value)) return;
  const requestedDays = draft.value;
  clearPreview();
  const result = await request<CleanupPreview>("preview", { days: requestedDays });
  if (!result) return;
  if (
    result.days !== requestedDays ||
    !result.previewToken ||
    !Array.isArray(result.candidates) ||
    !Array.isArray(result.blocked)
  ) {
    error.value = "预览结果无法核对，请重新预览。";
    return;
  }
  preview.value = result;
  await nextTick();
  previewHeading.value?.focus();
}

async function save(value: number | null) {
  if (!ready.value) return;
  const approved = preview.value;
  if (value === null ? days.value === null : !confirmed.value || approved?.days !== value || draft.value !== value)
    return;
  const result = await request<Policy>("save", {
    days: value,
    expectedDays: days.value,
    ...(value === null ? {} : { previewToken: approved?.previewToken }),
  });
  clearPreview();
  if (!result) return;
  if (result.days !== value) {
    needsReload.value = true;
    error.value = "保存结果未确认，请重新读取设置后核对。";
    return;
  }
  days.value = result.days;
  draft.value = result.days ?? settings.defaultDays;
  notice.value =
    result.days === null ? "自动删除已关闭。" : `设置已保存。会员${settings.rule} ${result.days} 天后纳入自动清理。`;
}

function close() {
  if (operation.value !== "save") emit("close");
}

onMounted(() => {
  dialog.value?.showModal();
  void load();
});
onBeforeUnmount(() => {
  controller.abort();
  if (dialog.value?.open) dialog.value.close();
});
</script>

<template>
  <dialog
    ref="dialog"
    class="cleanup-dialog"
    aria-labelledby="member-cleanup-title"
    aria-describedby="member-cleanup-scope"
    @cancel.prevent="close"
  >
    <header class="cleanup-header">
      <h3 id="member-cleanup-title">{{ settings.title }}</h3>
      <button type="button" class="close" aria-label="关闭" :disabled="operation === 'save'" @click="close">×</button>
    </header>
    <div class="cleanup-content" :aria-busy="Boolean(operation)">
      <p id="member-cleanup-scope" class="muted">{{ settings.scope }}</p>
      <p class="muted">{{ settings.protection }}</p>
      <p v-if="operation === 'load'" role="status">正在读取设置…</p>
      <p v-else-if="days === null" class="policy">当前已关闭</p>
      <p v-else-if="days !== undefined" class="policy">当前规则 · {{ settings.rule }} {{ days }} 天</p>

      <form class="days-form" @submit.prevent="loadPreview">
        <label>
          {{ settings.field }}
          <input
            v-model.number="draft"
            type="number"
            inputmode="numeric"
            min="1"
            max="3650"
            step="1"
            placeholder="1–3650 天"
            :disabled="!ready"
            required
            @input="editDays"
          />
        </label>
        <button type="submit" :disabled="!ready || !validDays">
          {{ operation === "preview" ? "正在预览…" : preview ? "重新预览" : "预览清理范围" }}
        </button>
      </form>

      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <p v-if="notice" role="status" class="notice">{{ notice }}</p>
      <button v-if="needsReload" type="button" :disabled="Boolean(operation)" @click="load">重新读取设置</button>

      <section v-if="preview" aria-labelledby="member-cleanup-preview">
        <h4 id="member-cleanup-preview" ref="previewHeading" tabindex="-1">当前清理预览</h4>
        <p v-if="!preview.candidates.length" class="muted">
          当前没有符合删除条件的会员，未来达到规则的会员仍会纳入清理。
        </p>
        <details v-else open>
          <summary>符合删除条件（{{ preview.candidates.length }} 位）</summary>
          <ul>
            <li v-for="account in preview.candidates" :key="account.id">
              <strong>{{ account.email }}</strong>
              <span class="muted">{{ cleanupCandidateDetail(account) }}</span>
            </li>
          </ul>
        </details>
        <details v-if="preview.blocked.length">
          <summary>当前跳过（{{ preview.blocked.length }} 位）</summary>
          <ul>
            <li v-for="account in preview.blocked" :key="account.id">
              <strong>{{ account.email }}</strong>
              <span class="muted">{{ cleanupBlockLabels[account.reason] }}</span>
            </li>
          </ul>
        </details>
        <label class="confirm">
          <input v-model="confirmed" type="checkbox" :disabled="!ready" />
          <span>{{ settings.confirmation }}</span>
        </label>
      </section>
    </div>
    <footer v-if="preview || (days !== undefined && days !== null) || operation === 'save'" class="cleanup-footer">
      <button v-if="days !== undefined && days !== null" type="button" :disabled="!ready" @click="save(null)">
        关闭自动删除
      </button>
      <p v-if="operation === 'save'" role="status" class="muted">正在保存…</p>
      <button v-if="preview" type="button" class="danger" :disabled="!ready || !confirmed" @click="save(preview.days)">
        {{ days === null ? "确认启用自动删除" : "确认更新自动删除" }}
      </button>
    </footer>
  </dialog>
</template>

<style scoped src="./MemberExpiryCleanupDialog.css"></style>
