<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import { mdiMagnify, mdiMonitorDashboard } from "@mdi/js";
import AppVersion from "./AppVersion.vue";
import type { AppView } from "../types";

defineProps<{ query: string; view?: AppView }>();
const emit = defineEmits<{ "update:query": [query: string]; publish: []; system: [] }>();
</script>

<template>
  <header class="app-header">
    <div class="mobile-brand">
      <img class="brand-logo" src="/logo.svg" alt="" aria-hidden="true" /><span>{{
        view === "virtualLibraries"
          ? "虚拟媒体库"
          : view === "cardKeys"
            ? "卡密"
            : view === "library"
              ? "媒体库"
              : view === "missingEpisodes"
                ? "缺集总览"
                : view === "system"
                  ? "系统状态"
                  : view === "config"
                    ? "系统设置"
                    : view === "logs"
                      ? "日志"
                      : "任务中心"
      }}</span>
    </div>
    <label v-if="view === 'tasks'" class="global-search">
      <span class="sr-only">搜索已有任务</span><SvgIcon type="mdi" :path="mdiMagnify" :size="22" />
      <input
        :value="query"
        type="search"
        placeholder="搜索已有电影或剧集任务"
        @input="emit('update:query', ($event.target as HTMLInputElement).value)"
      />
    </label>
    <div class="actions">
      <AppVersion />
      <button class="logout" type="button" title="系统状态与共享会话" @click="emit('system')">
        <SvgIcon type="mdi" :path="mdiMonitorDashboard" :size="20" /><span>系统</span>
      </button>
    </div>
  </header>
</template>

<style scoped>
.app-header {
  height: var(--header-height);
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 0 32px;
  border-bottom: 1px solid #172731;
  background: #001832;
}
.mobile-brand {
  display: none;
  align-items: center;
  gap: 8px;
  font-size: 18px;
  font-weight: 760;
}
.mobile-brand .brand-logo {
  width: 26px;
  height: 26px;
  object-fit: contain;
}
.global-search {
  width: 405px;
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 0 14px;
  border: 1px solid #162c43;
  border-radius: 8px;
  color: #8292a3;
  background: #12243a;
}
.global-search:focus-within {
  border-color: #5cb361;
  box-shadow: 0 0 0 3px rgb(92 179 97 / 16%);
}
.global-search input {
  width: 100%;
  border: 0;
  outline: 0;
  color: #eef2f4;
  background: transparent;
  font-size: 14px;
}
.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}
button {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 0;
  border-radius: 7px;
  cursor: pointer;
}
.publish {
  padding: 0 18px;
  color: white;
  background: #5daf5d;
  font-weight: 720;
}
.logout {
  padding: 0 13px;
  color: #b7c1c8;
  background: rgb(255 255 255 / 6%);
}
button:focus-visible {
  outline: 3px solid rgb(105 192 106 / 55%);
  outline-offset: 2px;
}
@media (max-width: 1024px) {
  .app-header {
    min-height: 72px;
    height: auto;
    flex-wrap: wrap;
    gap: 10px;
    padding: 11px 16px 13px;
  }
  .mobile-brand {
    display: flex;
    min-width: 0;
  }
  .global-search {
    order: 3;
    width: 100%;
  }
  .publish {
    padding: 0 12px;
  }
  .logout span {
    display: none;
  }
}
@media (max-width: 560px) {
  .app-header {
    min-height: 78px;
    flex-wrap: nowrap;
    padding: 14px 12px;
    border-bottom: 0;
    background: #030b11;
  }
  .mobile-brand {
    flex: 1;
    font-size: 23px;
  }
  .global-search {
    order: initial;
    width: 44px;
    min-width: 44px;
    padding: 0;
    justify-content: center;
    border-color: transparent;
    background: transparent;
  }
  .global-search input {
    position: absolute;
    width: 1px;
    opacity: 0;
    pointer-events: none;
  }
  .global-search:focus-within {
    position: absolute;
    z-index: 45;
    top: 70px;
    right: 12px;
    left: 12px;
    width: auto;
    padding: 0 14px;
    justify-content: flex-start;
    background: #102238;
  }
  .global-search:focus-within input {
    position: static;
    width: 100%;
    opacity: 1;
    pointer-events: auto;
  }
  .actions {
    margin-left: 0;
  }
  .publish {
    min-width: 72px;
    min-height: 46px;
    font-size: 12px;
  }
  .logout {
    width: 44px;
    padding: 0;
  }
}
@media (max-width: 360px) {
  .app-header {
    gap: 6px;
  }
  .mobile-brand {
    flex: none;
    white-space: nowrap;
    font-size: 20px;
  }
  .actions {
    gap: 6px;
  }
  .publish {
    min-width: 68px;
    padding: 0 8px;
  }
  .publish svg {
    display: none;
  }
}
</style>
