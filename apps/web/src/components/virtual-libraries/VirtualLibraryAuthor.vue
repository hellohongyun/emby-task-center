<script setup lang="ts">
import { computed } from "vue";
import MemberAvatar from "../MemberAvatar.vue";
const props = defineProps<{
  library: { authorName: string; authorAvatarUrl?: string | null; source?: string; ownerAdminId?: string | null };
}>();
const name = computed(() => props.library.authorName?.trim() || "用户");
const fallback = computed(() =>
  props.library.source === "tgtodrive"
    ? "系"
    : props.library.ownerAdminId || name.value === "管理员"
      ? "管"
      : name.value.slice(0, 1),
);
</script>
<template>
  <span class="vl-author">
    <MemberAvatar :src="library.authorAvatarUrl" :fallback="fallback" />
    <span class="vl-author-name">{{ name }}</span>
  </span>
</template>
<style scoped>
.vl-author {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
  vertical-align: middle;
  --avatar-size: 28px;
}
.vl-author-name {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 12px;
  color: var(--text-dim);
}
</style>
