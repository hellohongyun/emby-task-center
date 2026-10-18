<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import {
  mdiAccountGroup,
  mdiDatabaseSearchOutline,
  mdiFormatListNumbered,
  mdiHome,
  mdiLogout,
  mdiMonitorDashboard,
  mdiPlaylistRemove,
  mdiTicketConfirmationOutline,
  mdiTune,
  mdiViewDashboardOutline,
} from "@mdi/js";

import type { AppView } from "../types";

withDefaults(defineProps<{ view?: AppView }>(), { view: "tasks" });
const emit = defineEmits<{ view: [view: AppView]; logout: [] }>();
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <img class="brand-logo" src="/logo.svg" alt="" aria-hidden="true" /><span>媒体任务中心</span>
    </div>
    <nav aria-label="主导航">
      <button :class="['primary', { active: view === 'home' }]" type="button" @click="emit('view', 'home')">
        <SvgIcon type="mdi" :path="mdiViewDashboardOutline" :size="20" />数据总览
      </button>
      <button :class="['primary', { active: view === 'tasks' }]" type="button" @click="emit('view', 'tasks')">
        <SvgIcon type="mdi" :path="mdiHome" :size="20" />任务中心
      </button>
      <button
        :class="['primary', { active: view === 'missingEpisodes' }]"
        type="button"
        @click="emit('view', 'missingEpisodes')"
      >
        <SvgIcon type="mdi" :path="mdiPlaylistRemove" :size="20" />缺集总览
      </button>
      <button :class="['primary', { active: view === 'library' }]" type="button" @click="emit('view', 'library')">
        <SvgIcon type="mdi" :path="mdiDatabaseSearchOutline" :size="20" />媒体库
      </button>
      <button
        :class="['primary', { active: view === 'virtualLibraries' }]"
        type="button"
        @click="emit('view', 'virtualLibraries')"
      >
        <SvgIcon type="mdi" :path="mdiDatabaseSearchOutline" :size="20" />虚拟媒体库
      </button>
      <button :class="['primary', { active: view === 'system' }]" type="button" @click="emit('view', 'system')">
        <SvgIcon type="mdi" :path="mdiMonitorDashboard" :size="20" />系统状态
      </button>
      <button :class="['primary', { active: view === 'logs' }]" type="button" @click="emit('view', 'logs')">
        <SvgIcon type="mdi" :path="mdiFormatListNumbered" :size="20" />日志
      </button>
      <button :class="['primary', { active: view === 'config' }]" type="button" @click="emit('view', 'config')">
        <SvgIcon type="mdi" :path="mdiTune" :size="20" />系统设置
      </button>
      <button
        :class="['primary', { active: view === 'submissions' }]"
        type="button"
        @click="emit('view', 'submissions')"
      >
        <SvgIcon type="mdi" :path="mdiAccountGroup" :size="20" />会员与运营
      </button>
      <button :class="['primary', { active: view === 'cardKeys' }]" type="button" @click="emit('view', 'cardKeys')">
        <SvgIcon type="mdi" :path="mdiTicketConfirmationOutline" :size="20" />卡密
      </button>

      <p class="section">访问会话</p>
      <div class="session-note">当前为家庭共享密码会话，不区分独立用户。</div>
      <button class="row logout" type="button" @click="emit('logout')">
        <SvgIcon type="mdi" :path="mdiLogout" :size="19" /><span>退出登录</span>
      </button>
    </nav>
  </aside>
</template>

<style scoped>
.sidebar {
  position: fixed;
  z-index: 40;
  inset: 0 auto 0 0;
  width: var(--sidebar-width);
  padding: 0 12px 18px;
  overflow-y: auto;
  border-right: 1px solid #1a2932;
  color: #b5c0c8;
  background: linear-gradient(180deg, #08121b, #060e16 70%);
}
.brand {
  height: var(--header-height);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  border-bottom: 1px solid #1a2932;
  color: #eef2f4;
  font-size: 19px;
  font-weight: 760;
}
.brand-logo {
  width: 28px;
  height: 28px;
  flex: none;
  object-fit: contain;
}
nav {
  padding-top: 14px;
}
.primary,
.row {
  position: relative;
  width: 100%;
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 0 14px;
  border: 0;
  border-radius: 8px;
  color: inherit;
  background: transparent;
  font: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition:
    background-color 0.16s var(--ease),
    color 0.16s var(--ease),
    transform 0.12s var(--ease);
}
.primary:hover,
.row:hover,
.row.selected {
  color: #edf2f4;
  background: #111e27;
}
.primary:active,
.row:active {
  transform: translateY(1px);
}
.primary.active {
  color: #71ca74;
  border-left: 4px solid #69c36e;
  background: #142029;
}
.primary.active::before {
  content: "";
  position: absolute;
  left: 0;
  top: 20%;
  bottom: 20%;
  width: 4px;
  border-radius: 4px;
  background: #69c36e;
  box-shadow: 0 0 12px rgb(105 195 110 / 55%);
}
.primary.active {
  border-left: 0;
  padding-left: 16px;
}
.section {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 20px 8px 7px;
  color: #63727d;
  font-size: 11px;
}
.section::after {
  content: "";
  height: 1px;
  flex: 1;
  background: #1b2a33;
}
.row span {
  flex: 1;
}
.row b {
  min-width: 30px;
  padding: 2px 7px;
  border-radius: 12px;
  color: #d5dce0;
  background: #1a2731;
  font-size: 11px;
  text-align: center;
  transition:
    background-color 0.16s var(--ease),
    color 0.16s var(--ease);
}
.row:hover b,
.row.selected b {
  color: #dff1e0;
  background: #223a2b;
}
.session-note {
  padding: 7px 14px 10px;
  color: #75838d;
  font-size: 11px;
  line-height: 1.55;
}
.logout {
  color: #d3a1a1;
}
button:focus-visible {
  outline: 2px solid var(--accent-ring);
  outline-offset: -2px;
}
@media (max-width: 1024px) {
  .sidebar {
    display: none;
  }
}
</style>
