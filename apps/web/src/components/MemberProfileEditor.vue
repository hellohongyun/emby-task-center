<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { friendlyError } from "../composables/portal-member";
import type { MemberProfile, MemberProfileFields as ProfileFields } from "../types";
import MemberProfileFields from "./MemberProfileFields.vue";

const props = defineProps<{
  profile?: MemberProfile;
  save: (fields: ProfileFields) => Promise<MemberProfile>;
  syncAvatar?: (replace: boolean) => Promise<MemberProfile>;
}>();

const currentProfile = ref<MemberProfile>();
const qqNumber = ref("");
const joinSource = ref("");
const busy = ref(false);
const message = ref("");
const error = ref("");
const hasUnsavedChanges = computed(
  () =>
    qqNumber.value !== (currentProfile.value?.qqNumber ?? "") ||
    joinSource.value !== (currentProfile.value?.joinSource ?? ""),
);
const syncStatus = computed(() => {
  switch (currentProfile.value?.avatarSyncStatus) {
    case "synced":
      return "头像已同步到 Emby。";
    case "pending":
      return "头像待同步到 Emby。";
    case "failed":
      return "头像同步到 Emby 失败。";
    case "preserved":
      return "已保留现有的 Emby 自定义头像。";
    case "unavailable":
      return "暂无可同步的 QQ 头像。";
    default:
      return "";
  }
});

function applyProfile(value?: MemberProfile) {
  currentProfile.value = value;
  qqNumber.value = value?.qqNumber ?? "";
  joinSource.value = value?.joinSource ?? "";
}
watch(() => props.profile, applyProfile, { immediate: true });

async function update(action: () => Promise<MemberProfile>, success: string, fallback: string) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    applyProfile(await action());
    message.value = success;
  } catch (caught) {
    const code = caught instanceof Error ? caught.message : undefined;
    const friendly = code && friendlyError(code);
    error.value = friendly && friendly !== code ? friendly : fallback;
  } finally {
    busy.value = false;
  }
}

function submitProfile() {
  const fields = { qqNumber: qqNumber.value || null, joinSource: joinSource.value || null };
  return update(() => props.save(fields), "会员资料已保存。", "保存失败，请稍后重试。");
}

async function requestAvatarSync(replace: boolean) {
  const sync = props.syncAvatar;
  if (!sync || hasUnsavedChanges.value) return;
  await update(() => sync(replace), "", "头像同步请求失败，请稍后重试。");
}
</script>

<template>
  <form class="profile-editor" @submit.prevent="submitProfile">
    <MemberProfileFields
      v-model:qq-number="qqNumber"
      v-model:join-source="joinSource"
      :avatar-url="qqNumber === currentProfile?.qqNumber ? currentProfile?.avatarUrl : null"
      :disabled="busy"
    />
    <p v-if="syncStatus" class="sync-status" role="status">{{ syncStatus }}</p>
    <p v-if="props.syncAvatar && currentProfile?.qqNumber && hasUnsavedChanges" class="sync-status">
      请先保存资料，再同步头像。
    </p>
    <p v-if="error" class="editor-message error" role="alert">{{ error }}</p>
    <p v-if="message" class="editor-message" role="status">{{ message }}</p>
    <div class="editor-actions">
      <button type="submit" class="save" :disabled="busy">{{ busy ? "处理中…" : "保存资料" }}</button>
      <template v-if="props.syncAvatar && currentProfile?.qqNumber">
        <button
          v-if="currentProfile.avatarSyncStatus === 'preserved'"
          type="button"
          :disabled="busy || hasUnsavedChanges"
          @click="requestAvatarSync(true)"
        >
          用 QQ 头像替换
        </button>
        <button v-else type="button" :disabled="busy || hasUnsavedChanges" @click="requestAvatarSync(false)">
          {{ currentProfile.avatarSyncStatus === "synced" ? "立即刷新 QQ 头像" : "重新同步头像" }}
        </button>
      </template>
    </div>
  </form>
</template>

<style scoped>
.profile-editor {
  display: grid;
  gap: 0.8rem;
}
.sync-status,
.editor-message {
  margin: 0;
  font-size: 0.82rem;
}
.sync-status {
  color: var(--text-dim);
}
.editor-message.error {
  color: var(--danger);
}
.editor-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.55rem;
}
.editor-actions button {
  border: 1px solid var(--line, #d1d5db);
  border-radius: 8px;
  padding: 0.45rem 0.75rem;
  background: var(--surface, transparent);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.editor-actions .save {
  background: var(--accent);
  color: var(--accent-ink);
}
.editor-actions button:disabled {
  cursor: wait;
  opacity: 0.6;
}
</style>
