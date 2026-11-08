<script setup lang="ts">
import MediaRequestList from "../components/MediaRequestList.vue";
import { useAppServices } from "../state/app-services";
const services = useAppServices();
</script>

<template>
  <div class="requests-workspace">
    <header class="page-heading">
      <h1>求片与补集</h1>
      <p>查看会员需求，更新处理进度与反馈。</p>
    </header>
    <MediaRequestList admin :require-auth="services.requireAuth" />
  </div>
</template>

<style scoped>
.requests-workspace {
  max-width: 1120px;
  min-width: 0;
  margin: 0 auto;
  padding: 8px 0 24px;
  color: var(--text);
}
.page-heading {
  margin-bottom: 14px;
}
h1 {
  margin: 0 0 4px;
  font-size: 24px;
}
.page-heading p {
  margin: 0;
  color: var(--text-dim);
  font-size: 13px;
}
@media (max-width: 1024px) {
  .requests-workspace {
    padding: 0 0 20px;
  }
  .page-heading {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}
</style>
