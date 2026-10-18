import { computed, ref, watch, type Ref } from "vue";

import type { usePortalSession } from "./usePortalSession";

/**
 * 公开门户的页面切换与跨页搜索交接（P4：从 PublicPortal.vue 抽出）。
 *
 * 门户内部有 3 个页面（首页 / 影视库 / 我的），切换与"首页或搜索框发起搜索 →
 * 跳到影视库并带上关键词"这套交互原本混在组件里，这里独立出来，组件只管渲染。
 *
 * 历史：原本文档说 5 个页面（含「投稿」「追更」），并有一条「热榜点选 → 预填投稿草稿」的
 * 交接路径；投稿功能删除后，热榜点选改为直接进影视库搜索同名作品。
 */
export type PublicView = "home" | "library" | "profile";

export interface UsePublicNavigationOptions {
  /** 门户会话（用于"我的"里的邮箱与会员状态摘要）。 */
  session: ReturnType<typeof usePortalSession>;
  navItems: ReadonlyArray<{ value: PublicView; label: string; icon: string }>;
}

export function usePublicNavigation(options: UsePublicNavigationOptions) {
  const view = ref<PublicView>("home");
  const searchQuery = ref("");
  const libraryQuery = ref("");

  watch(
    options.session.contentAllowed,
    (allowed, previous) => {
      if (allowed && previous === false) view.value = "home";
      if (!allowed) {
        view.value = "profile";
        searchQuery.value = "";
        libraryQuery.value = "";
      }
    },
    { immediate: true, flush: "sync" },
  );

  // 切换门户页面时回到顶部，避免从首页底部点「影视库」后停留在页面底部。
  // jsdom 里 window.scrollTo 存在但未实现（会抛 Not implemented），所以要吞掉异常：
  // 滚动失败不该影响导航本身，在真实浏览器里也同理。
  watch(view, () => {
    try {
      if (typeof window !== "undefined" && typeof window.scrollTo === "function") window.scrollTo(0, 0);
    } catch {
      /* 环境不支持滚动时忽略 */
    }
  });

  function navigateTo(target: PublicView): void {
    view.value = options.session.contentAllowed.value ? target : "profile";
  }

  /** 顶栏搜索：把关键词交给影视库页面（并清空输入框）。 */
  function submitSearch(): void {
    if (!options.session.contentAllowed.value) return;
    const query = searchQuery.value.trim();
    if (!query) return;
    libraryQuery.value = query;
    searchQuery.value = "";
    view.value = "library";
  }

  /** 首页搜索框：同样把关键词交给影视库页面。 */
  function handleHomeSearch(query: string): void {
    if (!options.session.contentAllowed.value || !query.trim()) return;
    libraryQuery.value = query.trim();
    view.value = "library";
  }

  /** "我的"页顶部的账号摘要（未登录时为空串）。 */
  const sessionSummary = computed(() => {
    const email = options.session.loggedInEmail.value;
    if (!email) return "";
    return `${email} · ${memberStatusText(options.session.memberStatus.value)}`;
  });

  return {
    view: view as Ref<PublicView>,
    searchQuery,
    libraryQuery,
    navItems: options.navItems,
    sessionSummary,
    navigateTo,
    submitSearch,
    handleHomeSearch,
  };
}

/** 会员状态文案（"我的"页与摘要共用）。 */
export function memberStatusText(status: string): string {
  return { active: "有效", expiring: "即将到期", expired: "已过期", none: "未开通" }[status] ?? status;
}
