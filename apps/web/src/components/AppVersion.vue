<script setup lang="ts">
const version = __APP_VERSION__;
</script>

<template>
  <span class="app-version" :aria-label="`应用版本 ${version}`" :title="`Emby Task Center ${version}`">
    {{ version }}
  </span>
</template>

<style scoped>
.app-version {
  display: inline-flex;
  flex: none;
  align-items: center;
  color: #93a4b1;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.5;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
</style>
