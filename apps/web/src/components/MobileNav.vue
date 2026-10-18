<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import {
  mdiAccountGroup,
  mdiClose,
  mdiDatabaseSearchOutline,
  mdiDotsHorizontal,
  mdiFormatListNumbered,
  mdiHome,
  mdiLogout,
  mdiMonitorDashboard,
  mdiPlaylistRemove,
  mdiTicketConfirmationOutline,
  mdiTune,
  mdiViewDashboardOutline,
} from "@mdi/js";
import { ref } from "vue";
import type { AppView } from "../types";

withDefaults(defineProps<{ view?: AppView }>(), { view: "tasks" });
const emit = defineEmits<{ view: [view: AppView]; logout: [] }>();
const moreOpen = ref(false);
const moreItems: { key: AppView; label: string; icon: string }[] = [
  { key: "virtualLibraries", label: "虚拟媒体库", icon: mdiDatabaseSearchOutline },
  { key: "submissions", label: "会员与运营", icon: mdiAccountGroup },
  { key: "cardKeys", label: "卡密", icon: mdiTicketConfirmationOutline },
  { key: "system", label: "系统状态", icon: mdiMonitorDashboard },
  { key: "config", label: "系统设置", icon: mdiTune },
];
function go(view: AppView) {
  moreOpen.value = false;
  emit("view", view);
}
</script>

<template>
  <nav class="mobile-nav" aria-label="移动导航">
    <button type="button" :class="{ active: view === 'home' }" @click="go('home')">
      <SvgIcon type="mdi" :path="mdiViewDashboardOutline" :size="21" /><span>总览</span>
    </button>
    <button type="button" :class="{ active: view === 'tasks' }" @click="go('tasks')">
      <SvgIcon type="mdi" :path="mdiHome" :size="21" /><span>任务</span>
    </button>
    <button type="button" :class="{ active: view === 'missingEpisodes' }" @click="go('missingEpisodes')">
      <SvgIcon type="mdi" :path="mdiPlaylistRemove" :size="21" /><span>缺集</span>
    </button>
    <button type="button" :class="{ active: view === 'library' }" @click="go('library')">
      <SvgIcon type="mdi" :path="mdiDatabaseSearchOutline" :size="21" /><span>媒体库</span>
    </button>
    <button type="button" :class="{ active: view === 'logs' }" @click="go('logs')">
      <SvgIcon type="mdi" :path="mdiFormatListNumbered" :size="21" /><span>日志</span>
    </button>
    <button
      type="button"
      :class="{ active: moreOpen || moreItems.some((item) => item.key === view) }"
      aria-label="更多菜单"
      :aria-expanded="moreOpen"
      @click="moreOpen = !moreOpen"
    >
      <SvgIcon type="mdi" :path="mdiDotsHorizontal" :size="21" /><span>更多</span>
    </button>
  </nav>
  <div v-if="moreOpen" class="more-backdrop" @click="moreOpen = false"></div>
  <div v-if="moreOpen" class="more-sheet" role="dialog" aria-modal="true" aria-label="更多功能">
    <header class="more-header">
      <strong>更多功能</strong>
      <button type="button" class="more-close" aria-label="关闭更多菜单" @click="moreOpen = false">
        <SvgIcon type="mdi" :path="mdiClose" :size="20" />
      </button>
    </header>
    <div class="more-grid">
      <button
        v-for="item in moreItems"
        :key="item.key"
        type="button"
        :class="{ active: view === item.key }"
        @click="go(item.key)"
      >
        <span class="tile"><SvgIcon type="mdi" :path="item.icon" :size="22" /></span>
        <span class="label">{{ item.label }}</span>
      </button>
    </div>
    <footer class="more-footer">
      <button
        type="button"
        class="logout"
        @click="
          moreOpen = false;
          $emit('logout');
        "
      >
        <SvgIcon type="mdi" :path="mdiLogout" :size="18" />退出登录
      </button>
    </footer>
  </div>
</template>

<style scoped>
.mobile-nav {
  display: none;
}
@media (max-width: 1024px) {
  .mobile-nav {
    position: fixed;
    z-index: 38;
    right: 12px;
    bottom: max(10px, env(safe-area-inset-bottom));
    left: 12px;
    height: 64px;
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    padding: 4px;
    border: 1px solid #263841;
    border-radius: 14px;
    background: rgb(8 19 26 / 96%);
    box-shadow: 0 16px 45px rgb(0 0 0 / 44%);
  }
  button {
    min-width: 44px;
    min-height: 44px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    border: 0;
    border-radius: 10px;
    color: #84929c;
    background: transparent;
    font-size: 10px;
    cursor: pointer;
  }
  button.active {
    color: #76cb79;
    background: #13261b;
  }
}
@media (max-width: 560px) {
  .mobile-nav {
    right: 0;
    bottom: 0;
    left: 0;
    height: calc(70px + env(safe-area-inset-bottom));
    padding: 7px 10px max(7px, env(safe-area-inset-bottom));
    border-right: 0;
    border-bottom: 0;
    border-left: 0;
    border-radius: 28px 28px 0 0;
    background: #07121a;
  }
  button {
    gap: 3px;
    font-size: 11px;
  }
  button.active {
    background: transparent;
  }
}
.more-backdrop {
  position: fixed;
  z-index: 59;
  inset: 0;
  background: rgb(0 4 7 / 55%);
}
.more-sheet {
  position: fixed;
  z-index: 60;
  right: 12px;
  bottom: max(76px, calc(70px + env(safe-area-inset-bottom) + 6px));
  left: 12px;
  padding: 14px 12px 12px;
  border: 1px solid #2a3c46;
  border-radius: 18px;
  background: rgb(9 19 26 / 98%);
  box-shadow: 0 18px 48px rgb(0 0 0 / 55%);
  animation: more-in 0.18s ease-out;
}
@keyframes more-in {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.more-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2px 12px;
}
.more-header strong {
  color: #eef2f4;
  font-size: 16px;
  font-weight: 760;
}
.more-header .more-close {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 50%;
  color: #9aa6ae;
  background: rgb(255 255 255 / 6%);
  cursor: pointer;
}
.more-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.more-grid button {
  min-width: 0;
  min-height: 76px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px 4px;
  border: 1px solid transparent;
  border-radius: 14px;
  color: #aab6bd;
  background: transparent;
  cursor: pointer;
}
.more-grid button:active {
  background: rgb(255 255 255 / 5%);
}
.more-grid button.active {
  color: #7fd08a;
  border-color: rgb(93 175 93 / 28%);
  background: rgb(93 175 93 / 10%);
}
.more-grid .tile {
  width: 46px;
  height: 46px;
  display: grid;
  place-items: center;
  border-radius: 14px;
  color: #c6d0d6;
  background: rgb(255 255 255 / 7%);
  transition: background 0.15s ease;
}
.more-grid button.active .tile {
  color: #7fd08a;
  background: rgb(93 175 93 / 16%);
}
.more-grid .label {
  font-size: 12px;
  white-space: nowrap;
}
.more-footer {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid #1c2c35;
}
.more-footer .logout {
  width: 100%;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 0;
  border-radius: 10px;
  color: #e2a0a0;
  background: rgb(140 52 57 / 12%);
  cursor: pointer;
  font-size: 13px;
}
.more-sheet button:focus-visible,
.mobile-nav button:focus-visible {
  outline: 3px solid rgb(105 192 106 / 50%);
  outline-offset: -2px;
}
</style>
