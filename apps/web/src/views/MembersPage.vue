<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import { useAppServices } from "../state/app-services";
import MembersView from "../components/MembersView.vue";
import MemberUsageView from "../components/MemberUsageView.vue";

/**
 * 会员与运营（原「用户/会员」+「会员与运营」两个菜单）。
 *
 * 两段：
 *   - 会员：会员 + Emby 账号的统一表（含在线播放会话详情）；
 *   - 使用记录：谁在什么时候登录、看了什么、一天里的哪些时段在用。
 * Tab 走 URL query（?tab=usage），刷新/分享链接都能落回同一段。
 *
 * 原先还有第三段「运营设置」：追更标记已整体下线，邮件偏好与公告/平台说明都搬进了
 * 「系统设置」（见 ContentMailSettings.vue），所以这一段连同页面一起删掉。
 */
const services = useAppServices();
const route = useRoute();
const router = useRouter();

const TABS = [
  { key: "members", label: "会员" },
  { key: "usage", label: "使用记录" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const tab = ref<TabKey>(normalize(route.query.tab));
const activeTab = computed(() => tab.value);

function normalize(value: unknown): TabKey {
  const raw = Array.isArray(value) ? value[0] : value;
  return (TABS.find((item) => item.key === raw)?.key ?? "members") as TabKey;
}

function select(next: TabKey) {
  tab.value = next;
  // 用 replace：切换 Tab 不该在浏览器历史里堆一串记录（返回键仍回到上一个页面）。
  void router.replace({ query: next === "members" ? {} : { tab: next } });
}
</script>

<template>
  <div class="members-page">
    <header class="page-head">
      <div class="page-title">
        <h1>会员与运营</h1>
        <p>管理会员有效期、Emby 账号与观看记录。</p>
      </div>
      <nav class="tabs" aria-label="会员与运营分区">
        <button
          v-for="item in TABS"
          :key="item.key"
          type="button"
          :aria-pressed="activeTab === item.key"
          :class="{ active: activeTab === item.key }"
          @click="select(item.key)"
        >
          {{ item.label }}
        </button>
      </nav>
    </header>
    <MembersView
      v-if="activeTab === 'members'"
      :require-auth="services.requireAuth"
      :go-to-library-order="() => router.push('/login/library-order')"
    />
    <MemberUsageView v-else :require-auth="services.requireAuth" />
  </div>
</template>

<style scoped>
.members-page {
  padding: 0 0 32px;
}
.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  box-sizing: border-box;
  padding: 18px 22px 0;
  max-width: 1180px;
  margin: 0 auto;
}
.page-head h1 {
  margin: 0 0 6px;
  color: var(--text);
  font-size: 23px;
  font-weight: 760;
}
.page-head p {
  margin: 0;
  color: var(--text-dim);
  font-size: 13px;
}
.tabs {
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  background: var(--surface);
}
.tabs button {
  min-height: 38px;
  padding: 0 15px;
  border: 0;
  border-radius: var(--radius-pill);
  color: var(--text-dim);
  background: transparent;
  font-size: 12.5px;
  white-space: nowrap;
  cursor: pointer;
}
.tabs button.active {
  color: var(--accent-ink);
  background: var(--accent);
  font-weight: 700;
}
.tabs button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
@media (max-width: 600px) {
  .page-head {
    padding: 6px 16px 0;
  }
  .page-title {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .tabs {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    width: 100%;
  }
  .tabs button {
    min-height: 44px;
  }
}
</style>
