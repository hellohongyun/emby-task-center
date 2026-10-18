<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";

import AppHeader from "./AppHeader.vue";
import AuthSplash from "./AuthSplash.vue";
import LoginGate from "./LoginGate.vue";
import LoginLocked from "./LoginLocked.vue";
import MobileNav from "./MobileNav.vue";
import SidebarNav from "./SidebarNav.vue";
import { useIntegrations } from "../composables/useIntegrations";
import { useLibrary } from "../composables/useLibrary";
import { resetPortalSession } from "../composables/usePortalSession";
import { useSystem } from "../composables/useSystem";
import { useTasks } from "../composables/useTasks";
import { ADMIN_PREFIX, pathForView, VIEW_PATHS, viewFromRoute } from "../router";
import { provideAppServices, type AppServices } from "../state/app-services";
import type { AppView } from "../types";

/**
 * 管理后台布局（P4）。
 *
 * 这里只负责"壳"：登录门、侧边栏、顶栏、任务抽屉、发布弹窗，以及创建并 provide 共享服务；
 * 当前视图由路由决定，内容区渲染 `<RouterView />`。
 */
const query = ref("");

/** UI 偏好存在本地；视图以 URL 为准（P4）。任务状态筛选已随侧边栏那组按钮一起删除。 */
const UI_STORAGE_KEY = "emby-task-center.ui";
/** 旧版本把视图也存在这里；现在只用来把「上次的视图」迁移到 URL 上。 */
function readStoredView(): AppView | null {
  try {
    const raw = localStorage.getItem(UI_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { view?: string };
    return parsed.view && VIEW_PATHS.some((item) => item.view === parsed.view) ? (parsed.view as AppView) : null;
  } catch {
    return null;
  }
}

const route = useRoute();
const router = useRouter();
const view = computed<AppView>(() => viewFromRoute(route));
function goToView(next: AppView): void {
  if (next === view.value) return;
  void router.push(pathForView(next));
}
// 兼容：直接打开 /login（未带子路径）时跳回上次使用的视图；URL 已带视图则尊重 URL。
onMounted(() => {
  if (route.path !== ADMIN_PREFIX) return;
  const stored = readStoredView();
  if (stored && stored !== view.value) void router.replace(pathForView(stored));
});
watch(view, (nextView) => {
  try {
    localStorage.setItem(UI_STORAGE_KEY, JSON.stringify({ view: nextView }));
  } catch {
    /* ignore */
  }
});

const taskApi = useTasks();
const {
  authRequired,
  authChecking,
  lockRemaining,
  lockChecking,
  error,
  startAutoRefresh,
  stopAutoRefresh,
  login,
  refreshLockStatus,
  logout,
  requireAuth,
} = taskApi;

/** 管理端退出：同时清理公开门户的会话状态，避免回到公开页仍显示上一账号。 */
async function handleLogout() {
  resetPortalSession();
  await logout();
}
onMounted(() => startAutoRefresh());
onBeforeUnmount(() => stopAutoRefresh());
// 手动建任务已移除：TMDB 搜索与季进度只服务于那个对话框，这里不再需要
const library = useLibrary({ requireAuth });
const system = useSystem(requireAuth);
const integrations = useIntegrations(requireAuth);

watch(
  [authRequired, authChecking],
  ([required, checking]) => {
    if (!required && !checking) {
      void integrations.load();
    }
  },
  { immediate: true },
);
watch(authRequired, (required) => {
  if (required) {
    system.cancel();
    integrations.cancel();
    void refreshLockStatus();
  }
});
function handleLockExpired() {
  lockRemaining.value = 0;
  void refreshLockStatus();
}

const services: AppServices = {
  tasks: taskApi,
  library,
  system,
  integrations,
  requireAuth,
  ui: {
    query,
    authChecking,
    authRequired,
    lockChecking,
    lockRemaining,
    goToView,
    handleLogout,
    handleLockExpired,
  },
};
provideAppServices(services);
</script>

<template>
  <AuthSplash v-if="authChecking || (authRequired && lockChecking)" />
  <LoginLocked
    v-else-if="authRequired && lockRemaining > 0"
    :retry-after-seconds="lockRemaining"
    @unlock="handleLockExpired"
  />
  <LoginGate v-else-if="authRequired" :login="login" :error="error" />
  <div v-else class="app-shell">
    <SidebarNav :view="view" @view="goToView" @logout="handleLogout" />
    <div class="workspace">
      <AppHeader :query="query" :view="view" @update:query="query = $event" @system="goToView('system')" />
      <main class="main-content">
        <RouterView />
      </main>
    </div>

    <MobileNav :view="view" @view="goToView" @logout="handleLogout" />
  </div>
</template>
