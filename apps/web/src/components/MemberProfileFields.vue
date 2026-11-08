<script setup lang="ts">
import { useId } from "vue";
import MemberAvatar from "./MemberAvatar.vue";

defineProps<{ avatarUrl?: string | null; readonlyQq?: boolean; disabled?: boolean }>();
const qqNumber = defineModel<string>("qqNumber", { required: true });
const joinSource = defineModel<string>("joinSource", { required: true });
const qqId = useId();
const sourceId = useId();
</script>

<template>
  <div class="member-profile-fields">
    <div class="profile-contact">
      <MemberAvatar :src="avatarUrl" />
      <div class="profile-field">
        <label :for="qqId">联系 QQ</label>
        <input
          :id="qqId"
          v-model.trim="qqNumber"
          type="text"
          inputmode="numeric"
          maxlength="64"
          pattern="[0-9]+"
          placeholder="QQ 号"
          :readonly="readonlyQq"
          :disabled="disabled"
        />
      </div>
    </div>
    <div class="profile-field">
      <label :for="sourceId">入会来源（选填）</label>
      <input
        :id="sourceId"
        v-model.trim="joinSource"
        type="text"
        maxlength="120"
        placeholder="例如朋友推荐、影视群"
        :disabled="disabled"
      />
    </div>
  </div>
</template>

<style scoped>
.member-profile-fields,
.profile-field {
  display: grid;
  gap: 0.45rem;
  min-width: 0;
}
.member-profile-fields {
  gap: 0.75rem;
}
.profile-contact {
  display: flex;
  align-items: end;
  gap: 0.6rem;
}
.profile-contact .profile-field {
  flex: 1;
}
.profile-field input {
  box-sizing: border-box;
  width: 100%;
  min-height: 38px;
  border: 1px solid var(--line, #d1d5db);
  border-radius: 8px;
  padding: 0.45rem 0.6rem;
  background: var(--surface, transparent);
  color: inherit;
  font: inherit;
}
</style>
