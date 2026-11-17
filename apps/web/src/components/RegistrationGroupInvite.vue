<script setup lang="ts">
import CopyTextButton from "./CopyTextButton.vue";

defineProps<{ groupNumber: string; notice: string | null; disabled?: boolean }>();
const inviteCode = defineModel<string>({ required: true });
</script>

<template>
  <div class="registration-invite">
    <label for="registration-group-invite">群邀请码</label>
    <input
      id="registration-group-invite"
      v-model.trim="inviteCode"
      type="text"
      maxlength="120"
      autocomplete="off"
      :aria-describedby="notice ? 'registration-group-help' : undefined"
      :disabled="disabled"
    />
    <p v-if="notice" id="registration-group-help">{{ notice }}</p>
    <CopyTextButton :text="groupNumber" label="复制群号" />
  </div>
</template>

<style scoped>
.registration-invite {
  display: grid;
  gap: 0.45rem;
}
.registration-invite input {
  min-height: 40px;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--line, #d1d5db);
  border-radius: 10px;
  background: var(--surface, transparent);
  color: inherit;
  font: inherit;
}
.registration-invite p {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 0.82rem;
  line-height: 1.55;
}
.registration-invite button {
  justify-self: start;
  min-height: 36px;
  padding: 0.35rem 0.65rem;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  cursor: pointer;
}
</style>
