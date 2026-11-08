<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { MembershipDriveExpiry } from "../types";
import { fetchJsonWithTimeout } from "../composables/request-timeout";

const props = defineProps<{ requireAuth: () => void }>();
const emit = defineEmits<{ loaded: [limit: MembershipDriveExpiry | null | undefined]; membersChanged: [] }>();
const url = "/api/membership-drive-expiry";
const suggestedDate = "2028-08-31";
type SettingsResponse = { limit: MembershipDriveExpiry | null; error?: string };
type SaveResponse = SettingsResponse & { changedMembers: number; releasedMembers: number; syncPending: number };
const limit = ref<MembershipDriveExpiry | null>();
const date = ref(suggestedDate);
const loading = ref(false);
const saving = ref(false);
const needsReload = ref(false);
const error = ref("");
const notice = ref("");
const controller = new AbortController();
const canSave = computed(
  () =>
    !loading.value &&
    !saving.value &&
    !needsReload.value &&
    limit.value !== undefined &&
    !!date.value &&
    date.value !== limit.value?.date,
);

async function load(refreshMembers = true) {
  if (loading.value || saving.value) return;
  loading.value = true;
  error.value = "";
  emit("loaded", undefined);
  try {
    const { response, body } = await fetchJsonWithTimeout<SettingsResponse>(fetch, url, {
      credentials: "include",
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    if (response.status === 401) return props.requireAuth();
    if (!response.ok || !body || body.limit === undefined) throw new Error("read_failed");
    const previous = limit.value;
    const draftChanged = date.value !== (previous?.date ?? suggestedDate);
    limit.value = body.limit;
    if (!draftChanged) date.value = body.limit?.date ?? suggestedDate;
    needsReload.value = false;
    emit("loaded", body.limit);
    if (refreshMembers && previous !== undefined && previous?.date !== body.limit?.date) emit("membersChanged");
  } catch {
    if (!controller.signal.aborted) {
      needsReload.value = true;
      error.value = "读取网盘到期设置失败，请重新读取后再保存。";
    }
  } finally {
    if (!controller.signal.aborted) loading.value = false;
  }
}

async function save() {
  if (!canSave.value) return;
  saving.value = true;
  error.value = "";
  notice.value = "";
  try {
    const { response, body } = await fetchJsonWithTimeout<SaveResponse>(
      fetch,
      url,
      {
        method: "PUT",
        credentials: "include",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: date.value, expectedDate: limit.value?.date ?? null }),
      },
      90_000,
      true,
    );
    if (controller.signal.aborted) return;
    if (response.status === 401) return props.requireAuth();
    if (response.status === 409 && body?.error === "member_cleanup_pending") {
      error.value = "有会员账号正在清理，网盘到期日未保存。请稍后重试。";
      return;
    }
    if (response.status === 409) {
      needsReload.value = true;
      emit("loaded", undefined);
      error.value = "网盘到期设置已被其他操作更新。请重新读取设置并核对日期后再保存。";
      return;
    }
    if (response.status === 400) {
      error.value = "请选择有效的网盘到期日。";
      return;
    }
    if (!response.ok || !body?.limit) throw new Error("save_failed");
    limit.value = body.limit;
    date.value = body.limit.date;
    notice.value = `设置已保存。已更新 ${body.changedMembers} 位会员，${body.releasedMembers} 位会员的待激活时长已释放。`;
    if (body.syncPending > 0) notice.value += ` ${body.syncPending} 个 Emby 账号待同步。`;
    emit("loaded", body.limit);
    emit("membersChanged");
  } catch {
    if (!controller.signal.aborted) {
      needsReload.value = true;
      emit("loaded", undefined);
      error.value = "保存结果未确认，请重新读取当前设置后核对。";
    }
  } finally {
    if (!controller.signal.aborted) saving.value = false;
  }
}

defineExpose({ reload: () => load(false) });
onMounted(() => void load());
onBeforeUnmount(() => controller.abort());
</script>

<template>
  <section class="drive-settings" aria-label="网盘到期设置">
    <div class="drive-state">
      <h3>网盘到期设置</h3>
      <p v-if="loading" class="current" role="status">正在读取设置…</p>
      <p v-else-if="needsReload" class="current">等待重新读取</p>
      <p v-else-if="limit" class="current" title="服务器时区，当天有效">当前上限 {{ limit.date }}</p>
      <p v-else-if="limit === null" class="current unset">当前未设置上限</p>
    </div>
    <form @submit.prevent="save">
      <label>网盘到期日<input v-model="date" type="date" :disabled="loading || saving" required /></label>
      <button type="submit" :disabled="!canSave">{{ saving ? "正在保存…" : "保存网盘到期日" }}</button>
      <button v-if="needsReload" type="button" class="secondary" :disabled="loading || saving" @click="load()">
        重新读取设置
      </button>
    </form>
    <p class="help">延长上限后自动补回待激活时长。</p>
    <p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
  </section>
</template>

<style scoped>
.drive-settings {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px 20px;
  align-items: end;
  margin-top: 10px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius-lg);
  background: var(--surface);
}
h3 {
  margin: 0 0 4px;
  color: var(--text-dim);
  font-size: 12px;
}
p {
  line-height: 1.65;
  font-size: 13px;
  margin: 0;
  overflow-wrap: anywhere;
}
.current {
  color: var(--accent-strong);
  font-size: 17px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.current.unset {
  font-size: 13px;
  font-weight: 550;
}
.help,
label {
  color: var(--text-dim);
}
.help,
.notice,
.error {
  grid-column: 1 / -1;
  font-size: 12px;
}
form {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: end;
}
label {
  display: grid;
  gap: 6px;
  font-size: 12px;
}
input,
button {
  box-sizing: border-box;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  min-height: 44px;
  padding: 8px 12px;
}
input {
  min-width: 0;
  width: 100%;
  color: var(--text);
  background: var(--input);
  color-scheme: dark;
  font-size: 16px;
}
button {
  background: var(--accent);
  color: var(--accent-ink);
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
  white-space: nowrap;
}
.secondary {
  background: var(--surface-hi);
  color: var(--text);
}
button:disabled {
  opacity: 0.55;
  cursor: default;
}
.notice {
  color: var(--accent-strong);
}
.error {
  color: var(--danger);
}
@media (max-width: 720px) {
  .drive-settings {
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
    padding: 10px 12px;
  }
  .drive-state {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 3px 10px;
  }
  .drive-state h3 {
    margin: 0;
  }
  form {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
  }
  label {
    min-width: 0;
  }
  .secondary {
    grid-column: 1 / -1;
  }
}
</style>
