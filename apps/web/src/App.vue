<script setup lang="ts">
import { MotionConfig } from "motion-v";
import { computed } from "vue";
import { RouterView, useRoute } from "vue-router";

import PublicPortal from "./components/PublicPortal.vue";
import { isAdminPath } from "./router";

/**
 * 路由出口（P4）。
 *
 * 管理后台与公开门户是两个独立外壳：
 *   - 管理后台在 /login（含 /login/<view> 子路径），由 AdminShell 渲染；
 *   - 其余路径（/ 等）渲染公开门户。
 * 视图切换、前进/后退、刷新保持位置都由 URL 负责，App.vue 不再持有视图状态。
 */
const route = useRoute();
const isAdmin = computed(() => isAdminPath(route.path));
</script>

<template>
  <MotionConfig reduced-motion="user">
    <PublicPortal v-if="!isAdmin" />
    <!-- 管理后台：AdminShell 是 /login 这棵路由树的布局组件 -->
    <RouterView v-else />
  </MotionConfig>
</template>
