<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { MemberProfile, MemberProfileFields, SubmissionUser } from "../types";
import MemberProfileEditor from "./MemberProfileEditor.vue";

const props = defineProps<{
  member: SubmissionUser;
  save: (id: number, fields: MemberProfileFields) => Promise<MemberProfile>;
  syncAvatar: (id: number, replace: boolean) => Promise<MemberProfile>;
}>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();

onMounted(() => {
  if (typeof dialog.value?.showModal === "function") dialog.value.showModal();
  else dialog.value?.setAttribute("open", "");
});
onBeforeUnmount(() => dialog.value?.close?.());

const saveMember = (fields: MemberProfileFields) => props.save(props.member.id, fields);
const syncMemberAvatar = (replace: boolean) => props.syncAvatar(props.member.id, replace);
</script>

<template>
  <dialog ref="dialog" class="profile-dialog" aria-labelledby="member-profile-title" @cancel.prevent="emit('close')">
    <header>
      <div>
        <h3 id="member-profile-title">会员资料</h3>
        <p>{{ member.email }}</p>
      </div>
      <button type="button" @click="emit('close')">关闭</button>
    </header>
    <MemberProfileEditor :profile="member.profile" :save="saveMember" :sync-avatar="syncMemberAvatar" />
  </dialog>
</template>

<style scoped>
.profile-dialog {
  position: fixed;
  inset: 0;
  margin: auto;
  box-sizing: border-box;
  width: min(440px, calc(100% - 2rem));
  padding: 1.2rem;
  border: 1px solid var(--line, #d1d5db);
  border-radius: 14px;
  background: var(--surface, #fff);
  color: var(--text, #172319);
}
.profile-dialog::backdrop {
  background: rgb(0 0 0 / 55%);
}
.profile-dialog header {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 1rem;
}
.profile-dialog h3,
.profile-dialog p {
  margin: 0;
  overflow-wrap: anywhere;
}
.profile-dialog header button {
  flex: 0 0 auto;
  border: 1px solid var(--line, #d1d5db);
  border-radius: 8px;
  padding: 0.35rem 0.55rem;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
</style>
