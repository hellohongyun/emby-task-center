<script setup lang="ts">
import { ref } from "vue";

defineProps<{ src?: string | null }>();
const failedSrc = ref<string>();
</script>

<template>
  <span class="member-avatar">
    <img v-if="src && src !== failedSrc" :src="src" alt="" referrerpolicy="no-referrer" @error="failedSrc = src" />
    <span v-else aria-hidden="true">QQ</span>
  </span>
</template>

<style scoped>
.member-avatar {
  display: inline-grid;
  width: var(--avatar-size, 38px);
  height: var(--avatar-size, 38px);
  flex: 0 0 auto;
  place-items: center;
  overflow: hidden;
  border: 1px solid var(--line, #d1d5db);
  border-radius: 50%;
  background: var(--surface, #f3f4f6);
  color: var(--text-dim, #4b5563);
  font-size: 0.7rem;
  font-weight: 600;
}
.member-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
