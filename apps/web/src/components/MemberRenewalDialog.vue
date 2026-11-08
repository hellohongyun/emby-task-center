<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { MembershipDriveExpiry, SubmissionUser } from "../types";
import { fetchJsonWithTimeout } from "../composables/request-timeout";
import { formatMembershipDuration } from "../composables/membership-duration";

const props = defineProps<{
  member: SubmissionUser;
  requireAuth: () => void;
  driveExpiry?: MembershipDriveExpiry | null | undefined;
  requireDriveExpiry?: boolean;
}>();
const emit = defineEmits<{ close: []; saved: [message: string] }>();
const mode = ref("days");
const days = ref(30);
const date = ref("");
const reason = ref("");
const expiryLabel = ref("");
const busy = ref(false);
const error = ref("");
const dialog = ref<HTMLElement>();
const previousFocus = document.activeElement as HTMLElement | null;
function trapTab(event: KeyboardEvent) {
  const controls = [
    ...(dialog.value?.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled)") ?? []),
  ];
  const last = controls[controls.length - 1];
  const target = event.shiftKey ? last : controls[0];
  if (!controls.length) {
    event.preventDefault();
    return;
  }
  if (
    (event.shiftKey && document.activeElement === controls[0]) ||
    (!event.shiftKey && document.activeElement === last)
  ) {
    event.preventDefault();
    target?.focus();
  }
}
onMounted(() => dialog.value?.querySelector<HTMLElement>("input, button")?.focus());
const controller = new AbortController();
let disposed = false;
// getRandomValues also works when the admin uses an HTTP LAN address.
const bytes = crypto.getRandomValues(new Uint8Array(16));
bytes[6] = (bytes[6]! & 15) | 64;
bytes[8] = (bytes[8]! & 63) | 128;
const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
const expectedExpiresAt = props.member.subscriptionExpiresAt;
const driveExpiry = props.driveExpiry;
const expectedDriveExpiryDate = driveExpiry === undefined ? undefined : (driveExpiry?.date ?? null);
const driveExpiryUnavailable = props.requireDriveExpiry && driveExpiry === undefined;
const stalePreview = ref(false);
const expectedDeferredMembershipMs = props.member.deferredMembershipMs;
const deferredMs = expectedDeferredMembershipMs ?? 0;
const format = (value: string | null) => (value ? new Date(value).toLocaleString() : "长期有效");
const baseExpiry = computed(() => Math.max(Date.now(), Date.parse(expectedExpiresAt ?? "")));
const addedDaysExpiry = computed(() =>
  Number.isInteger(days.value) && days.value >= 1 && days.value <= 36500
    ? baseExpiry.value + days.value * 86_400_000
    : NaN,
);
const exceedsDriveExpiry = computed(() => {
  const limit = driveExpiry;
  if (!limit) return false;
  return mode.value === "date" ? date.value > limit.date : addedDaysExpiry.value > Date.parse(limit.expiresAt);
});
const showExpiryLabel = computed(() => !!expiryLabel.value.trim() && !exceedsDriveExpiry.value && deferredMs === 0);
const previewDeferred = computed(() => {
  const limit = driveExpiry;
  if (!limit || mode.value !== "days" || !exceedsDriveExpiry.value) return 0;
  const extra = addedDaysExpiry.value - Math.max(baseExpiry.value, Date.parse(limit.expiresAt));
  return deferredMs + Math.max(0, extra);
});
const preview = computed(() => {
  if (exceedsDriveExpiry.value && driveExpiry) return `${driveExpiry.date} 当天结束（服务器时区）`;
  if (mode.value === "date") return date.value ? `${date.value} 当天结束（服务器时区）` : "请选择日期";
  if (!Number.isInteger(days.value) || days.value < 1 || days.value > 36500) return "请输入 1–36500 天";
  if (!Number.isFinite(Date.parse(expectedExpiresAt ?? ""))) return "原到期时间无效，请先核对会员资料";
  return format(new Date(addedDaysExpiry.value).toISOString());
});
const errors: Record<string, string> = {
  renewal_expiry_changed: "有效期已被其他操作修改，请关闭后刷新会员列表，再重新续期。",
  renewal_drive_expiry_changed: "网盘到期日已变更。请关闭弹窗，刷新会员页后重新核对续期预览。",
  renewal_cleanup_pending: "该会员的账号正在清理，请稍后刷新会员列表再操作。",
  renewal_unlimited_member: "该会员长期有效，无需续期。",
  renewal_date_not_later:
    deferredMs > 0
      ? "指定日期需要覆盖当前有效期和待激活时长。请选择更晚日期。"
      : "所选日期必须晚于原到期时间，续期不能缩短有效期。",
  renewal_invalid_date: "请选择有效且尚未过去的日期。",
  renewal_request_conflict: "该次提交内容已变更，请关闭后刷新会员列表，核对结果。",
  user_not_found: "该会员已不存在，请刷新会员列表。",
};
const mailMessages: Record<string, string> = {
  sent: "续期通知邮件已发送。",
  pending: "续期已保存，通知邮件待发送，系统将自动补发；无需重复续期。",
  failed: "续期已保存，通知邮件发送失败，请核查邮件配置；无需重复续期。",
  not_configured: "续期已保存，邮件服务尚未配置，通知邮件待发送，配置后系统将自动补发；无需重复续期。",
  unchanged: "本次重复请求未重复发送通知邮件。",
};
async function save() {
  if (
    busy.value ||
    !expectedExpiresAt ||
    props.member.followsDriveExpiry ||
    driveExpiryUnavailable ||
    stalePreview.value
  )
    return;
  busy.value = true;
  error.value = "";
  try {
    const { response, body } = await fetchJsonWithTimeout<{
      error?: string;
      embyStatus?: string;
      emailStatus?: string;
      user?: Pick<SubmissionUser, "subscriptionExpiresAt" | "deferredMembershipMs">;
    }>(
      fetch,
      `/api/submission-users/${props.member.id}/renew`,
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
          reason: reason.value,
          expiryLabel: expiryLabel.value.trim() || null,
          ...(mode.value === "days" ? { mode: "days", days: days.value } : { mode: "date", date: date.value }),
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
      if (body?.error === "renewal_drive_expiry_changed" || body?.error === "renewal_cleanup_pending")
        stalePreview.value = true;
      error.value = errors[body?.error ?? ""] ?? "续期失败，请刷新核对有效期后再操作。";
      return;
    }
    const suffix =
      body?.embyStatus === "restore_failed"
        ? "；Emby 账号恢复未确认，请核查账号状态，有效期已保存。"
        : body?.embyStatus === "restricted"
          ? "。账号仍受当前有效期、停用或冻结规则限制。"
          : "。";
    const remaining = body?.user?.deferredMembershipMs ?? 0;
    const entitlement =
      remaining > 0 && body?.user
        ? `实际到期 ${format(body.user.subscriptionExpiresAt)}，待激活 ${formatMembershipDuration(remaining)}。`
        : "";
    emit("saved", `已续期 ${props.member.email}${suffix}${entitlement}${mailMessages[body?.emailStatus ?? ""] ?? ""}`);
  } catch {
    if (!disposed) error.value = "续期结果未确认，请关闭弹窗并刷新核对有效期；不要重复增加天数。";
  } finally {
    if (!disposed) busy.value = false;
  }
}
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
      aria-labelledby="renewal-title"
      class="renewal-dialog"
      @keydown.tab="trapTab"
    >
      <h3 id="renewal-title">管理员续期</h3>
      <p class="email">{{ member.email }}</p>
      <p>原到期时间：{{ format(expectedExpiresAt) }}</p>
      <p v-if="member.followsDriveExpiry">该会员长期跟随网盘到期日，无需续期。</p>
      <p v-else-if="!expectedExpiresAt">该会员长期有效，无需续期。</p>
      <p v-else-if="driveExpiryUnavailable" role="alert">
        当前无法核对网盘到期设置。请关闭弹窗，重新读取设置后再续期。
      </p>
      <form v-else @submit.prevent="save">
        <fieldset :disabled="busy">
          <legend>续期方式</legend>
          <label><input v-model="mode" type="radio" value="days" name="renewal-mode" />增加天数</label>
          <label><input v-model="mode" type="radio" value="date" name="renewal-mode" />续到指定日期</label>
          <label v-if="mode === 'days'" class="field"
            >增加天数
            <input v-model.number="days" type="number" min="1" max="36500" step="1" required />
          </label>
          <label v-else class="field">到期日期<input v-model="date" type="date" required /></label>
          <label class="field"
            >到期时间名称（可选）<input v-model="expiryLabel" maxlength="60" placeholder="例如：劳动节假期结束到期"
          /></label>
          <label class="field">续期原因（可选）<input v-model="reason" maxlength="200" /></label>
        </fieldset>
        <p class="preview">
          续期后：<strong v-if="showExpiryLabel">{{ expiryLabel.trim() }}</strong
          ><span :class="{ 'actual-expiry': showExpiryLabel }">{{ preview }}</span>
        </p>
        <p v-if="deferredMs > 0" class="hint">现有待激活时长：{{ formatMembershipDuration(deferredMs) }}</p>
        <p v-if="driveExpiry" class="hint">
          网盘到期日 {{ driveExpiry.date }}。超过上限的时长转为待激活，网盘续期后按新的可用时长释放。
          <span v-if="previewDeferred > 0">预计待激活 {{ formatMembershipDuration(previewDeferred) }}。</span>
          <span v-if="exceedsDriveExpiry || deferredMs > 0">有待激活时长时，会员侧显示实际到期日期。</span>
        </p>
        <p class="hint">
          未过期从原到期时间累加，已过期从当前时间累加。到期名称仅影响展示，留空则清除旧名称并显示真实日期。续期不会解除管理员停用或并发冻结。
        </p>
        <p v-if="error" role="alert">{{ error }}</p>
        <div class="actions">
          <button type="button" :disabled="busy" @click="emit('close')">取消</button>
          <button type="submit" :disabled="busy || stalePreview">{{ busy ? "正在续期…" : "确认续期" }}</button>
        </div>
      </form>
      <button
        v-if="!expectedExpiresAt || member.followsDriveExpiry || driveExpiryUnavailable"
        type="button"
        @click="emit('close')"
      >
        关闭
      </button>
    </section>
  </div>
</template>

<style scoped src="./MemberRenewalDialog.css"></style>
