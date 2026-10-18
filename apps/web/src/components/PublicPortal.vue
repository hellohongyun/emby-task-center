<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import { mdiHome, mdiAccountCircle, mdiLogout, mdiLibraryOutline, mdiMagnify } from "@mdi/js";
import { computed, onMounted, onBeforeUnmount } from "vue";

import PublicHomeView from "./PublicHomeView.vue";
import PublicLoginView from "./PublicLoginView.vue";
import PublicProfileView from "./PublicProfileView.vue";
import PublicLibraryView from "./PublicLibraryView.vue";
import AnnouncementModal from "./AnnouncementModal.vue";
import AppVersion from "./AppVersion.vue";
import { memberStatusText, usePublicNavigation } from "../composables/usePublicNavigation";
import { usePortalSession } from "../composables/usePortalSession";

const s = usePortalSession();

const navItems = [
  { value: "home", label: "首页", icon: mdiHome },
  { value: "library", label: "影视库", icon: mdiLibraryOutline },
  { value: "profile", label: "我的", icon: mdiAccountCircle },
] as const;

// 页面切换与跨页搜索交接已抽到 composable（P4）。
const { view, searchQuery, libraryQuery, sessionSummary, navigateTo, submitSearch, handleHomeSearch } =
  usePublicNavigation({ session: s, navItems });

const visibleNavItems = computed(() => navItems.filter((item) => s.contentAllowed.value || item.value === "profile"));
let refreshTimer: ReturnType<typeof setInterval> | undefined;
onMounted(async () => {
  await s.loadMember();
  refreshTimer = setInterval(() => {
    if (s.loggedInEmail.value) void s.loadMember();
  }, 60_000);
});
onBeforeUnmount(() => clearInterval(refreshTimer));
</script>

<template>
  <div class="portal">
    <template v-if="s.loggedInEmail.value">
      <header class="portal-header">
        <div class="brand">
          <img src="/logo.svg" alt="" aria-hidden="true" />
          <button type="button" class="brand-name" @click="navigateTo('home')">影视中心</button>
          <AppVersion />
        </div>

        <nav class="portal-nav" aria-label="主导航">
          <button
            v-for="item in visibleNavItems"
            :key="item.value"
            type="button"
            :class="{ active: view === item.value }"
            @click="navigateTo(item.value)"
          >
            <SvgIcon type="mdi" :path="item.icon" :size="17" />
            {{ item.label }}
          </button>
        </nav>

        <div v-if="s.contentAllowed.value" class="portal-search">
          <SvgIcon type="mdi" :path="mdiMagnify" :size="16" aria-hidden="true" />
          <input
            v-model="searchQuery"
            type="search"
            enterkeyhint="search"
            placeholder="搜影视库 / 影片…"
            @keyup.enter="submitSearch"
          />
        </div>

        <div class="session">
          <span class="session-chip" :class="s.memberStatus.value" :title="sessionSummary">
            <b>{{ s.loggedInEmail.value }}</b>
            <small>{{ memberStatusText(s.memberStatus.value) }}</small>
          </span>
          <button type="button" class="logout" title="退出登录" @click="s.logout()">
            <SvgIcon type="mdi" :path="mdiLogout" :size="15" />
          </button>
        </div>
      </header>

      <main class="portal-main">
        <PublicHomeView
          v-if="s.contentAllowed.value && view === 'home'"
          @navigate="navigateTo"
          @search="handleHomeSearch"
        />
        <PublicLibraryView v-else-if="s.contentAllowed.value && view === 'library'" :query="libraryQuery" />
        <PublicProfileView v-else @navigate="navigateTo" />
      </main>

      <AnnouncementModal />

      <nav class="portal-mobile-nav" aria-label="移动端导航">
        <button
          v-for="item in visibleNavItems"
          :key="item.value"
          type="button"
          :class="{ active: view === item.value }"
          @click="navigateTo(item.value)"
        >
          <SvgIcon type="mdi" :path="item.icon" :size="20" />
          <span>{{ item.label }}</span>
        </button>
      </nav>
    </template>

    <!-- 未登录：只显示用户登录页（内含底部管理端口），保护隐私不暴露任何内容 -->
    <template v-else>
      <PublicLoginView />
    </template>
  </div>
</template>

<style scoped src="./PublicPortal.css"></style>
