<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { MembershipDriveExpiry, SubmissionUser } from "../types";
import { fetchJsonWithTimeout } from "../composables/request-timeout";
import { formatMembershipDuration } from "../composables/membership-duration";

const props = defineProps<{
  member: SubmissionUser;
  requireAuth: () => void;
  driveExpiry?: MembershipDriveExpiry | null | undefined;
}>();
const emit = defineEmits<{ close: []; saved: [message: string] }>();
const days = ref(1);
const reason = ref("");
const busy = ref(false);
const error = ref("");
const stalePreview = ref(false);
const dialog = ref<HTMLElement>();
const previousFocus = document.activeElement as HTMLElement | null;
const controller = new AbortController();
let disposed = false;
const bytes = crypto.getRandomValues(new Uint8Array(16));
bytes[6] = (bytes[6]! & 15) | 64;
bytes[8] = (bytes[8]! & 63) | 128;
const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
const expectedExpiresAt = props.member.subscriptionExpiresAt;
const expectedDeferredMembershipMs = props.member.deferredMembershipMs ?? 0;
const expectedDriveExpiryDate = props.driveExpiry?.date ?? null;
const unavailable = props.driveExpiry === undefined;
const unsupported = !expectedExpiresAt || props.member.followsDriveExpiry;
const validDays = computed(() => Number.isInteger(days.value) && days.value >= 1 && days.value <= 36500);
const previewDeferred = computed(() => Math.max(0, expectedDeferredMembershipMs - days.value * 86_400_000));
const previewExpiry = computed(
  () => Date.parse(expectedExpiresAt ?? "") - Math.max(0, days.value * 86_400_000 - expectedDeferredMembershipMs),
);
const validPreview = computed(() => validDays.value && Number.isFinite(previewExpiry.value));
const willExpire = computed(() => validPreview.value && previewExpiry.value <= Date.now());
const format = (value: string | null) => (value ? new Date(value).toLocaleString() : "长期有效");
const duration = (value: number) => (value === 0 ? "0 天" : formatMembershipDuration(value));
const preview = computed(() =>
  validPreview.value ? format(new Date(previewExpiry.value).toISOString()) : "请输入 1–36500 天并核对原到期时间",
);
const errors: Record<string, string> = {
  reduction_expiry_changed: "会员有效期或待激活时长已变更，请关闭弹窗并刷新后重新核对。",
  reduction_drive_expiry_changed: "网盘到期日已变更，请关闭弹窗并刷新后重新核对。",
  reduction_cleanup_pending: "该会员的账号正在清理，请稍后刷新会员列表再操作。",
  reduction_unlimited_member: "长期有效或长期跟随网盘的会员不支持减少天数。",
  reduction_request_conflict: "该次提交内容已变更，请关闭弹窗并刷新核对结果。",
  reduction_invalid_expiry: "原到期时间无效，请先核对会员资料。",
  user_not_found: "该会员已不存在，请刷新会员列表。",
};
const mailMessages: Record<string, string> = {
  sent: "扣减通知邮件已发送。",
  pending: "通知邮件待发送，系统将自动补发；无需重复扣减。",
  unchanged: "本次重复请求未重复发送通知邮件。",
};
async function save() {
  if (busy.value || stalePreview.value || unsupported || unavailable || !validPreview.value) return;
  busy.value = true;
  error.value = "";
  try {
    const { response, body } = await fetchJsonWithTimeout<{
      error?: string;
      embyStatus?: string;
      emailStatus?: string;
    }>(
      fetch,
      `/api/submission-users/${props.member.id}/reduce-days`,
      {
        method: "POST",
        credentials: "include",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId,
          expectedExpiresAt,
          expectedDeferredMembershipMs,
          expectedDriveExpiryDate,
          days: days.value,
          reason: reason.value,
        }),
      },
      90000,
      true,
    );
    if (disposed) return;
    if (response.status === 401) {
      props.requireAuth();
      return;
    }
    if (!response.ok) {
      stalePreview.value = true;
      error.value = errors[body?.error ?? ""] ?? "扣减结果未确认，请关闭弹窗并刷新核对有效期。";
      return;
    }
    const sync = body?.embyStatus === "sync_failed" ? "Emby 账号状态同步未确认，系统将重试，请核查账号状态。" : "";
    emit("saved", `已减少 ${props.member.email} 的会员天数。${sync}${mailMessages[body?.emailStatus ?? ""] ?? ""}`);
  } catch {
    if (!disposed) {
      stalePreview.value = true;
      error.value = "扣减结果未确认，请关闭弹窗并刷新核对有效期；不要重复扣减。";
    }
  } finally {
    if (!disposed) busy.value = false;
  }
}
function trapTab(event: KeyboardEvent) {
  const controls = [
    ...(dialog.value?.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled)") ?? []),
  ];
  const last = controls[controls.length - 1];
  if (
    (event.shiftKey && document.activeElement === controls[0]) ||
    (!event.shiftKey && document.activeElement === last)
  ) {
    event.preventDefault();
    (event.shiftKey ? last : controls[0])?.focus();
  }
}
onMounted(() => dialog.value?.querySelector<HTMLElement>("input, button")?.focus());
onBeforeUnmount(() => {
  disposed = true;
  controller.abort();
  previousFocus?.focus();
});
</script>

<template>
  <div class="renewal-backdrop" @keydown.esc="!busy && emit('close')">
    <section
      ref="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reduction-title"
      class="renewal-dialog"
      @keydown.tab="trapTab"
    >
      <h3 id="reduction-title">减少会员天数</h3>
      <p class="email">{{ member.email }}</p>
      <p>原到期时间：{{ format(expectedExpiresAt) }}</p>
      <p>现有待激活时长：{{ duration(expectedDeferredMembershipMs) }}</p>
      <p v-if="unsupported" role="alert">长期有效或长期跟随网盘的会员不支持减少天数。</p>
      <p v-else-if="unavailable" role="alert">当前无法核对网盘到期设置，请关闭弹窗并重新读取设置。</p>
      <form v-else @submit.prevent="save">
        <fieldset :disabled="busy || stalePreview">
          <legend>扣减设置</legend>
          <label class="field"
            >减少天数<input v-model.number="days" type="number" min="1" max="36500" step="1" required
          /></label>
          <label class="field">扣减原因（可选）<input v-model="reason" maxlength="200" /></label>
        </fieldset>
        <p class="preview">扣减后到期时间：{{ preview }}</p>
        <p v-if="validPreview" class="hint">扣减后待激活时长：{{ duration(previewDeferred) }}</p>
        <p v-if="willExpire" role="alert">扣减后已过期，将按现有规则停用 Emby；已启用的过期自动清理规则也会适用。</p>
        <p class="hint">
          先扣待激活时长，不足部分从原到期时间扣除，每天按 24
          小时计算。允许扣减至过期，过期时间越早，可能越快达到自动清理条件。
        </p>
        <p class="hint">
          保存后清除旧到期名称，显示实际日期，并发送扣减通知邮件。管理员停用和并发冻结仍按现有规则处理。
        </p>
        <p v-if="error" role="alert">{{ error }}</p>
        <div class="actions">
          <button type="button" :disabled="busy" @click="emit('close')">取消</button>
          <button type="submit" :disabled="busy || stalePreview || !validPreview">
            {{ busy ? "正在扣减…" : "确认减少天数" }}
          </button>
        </div>
      </form>
      <button v-if="unsupported || unavailable" type="button" @click="emit('close')">关闭</button>
    </section>
  </div>
</template>

<style scoped src="./MemberRenewalDialog.css"></style>
