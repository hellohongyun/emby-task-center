import { createRouter, createWebHistory, type RouteLocationNormalizedLoaded, type Router } from "vue-router";

import AdminShell from "./components/AdminShell.vue";
import type { AppView } from "./types";

/**
 * 视图 = URL（P4）。
 *
 * 历史：视图只存在内存 + localStorage 里，没有 URL —— 刷新丢视图、不能分享链接、前进/后退无效。
 * 现在每个视图都是真正的路由页面：管理后台仍是 `/login` 进入（README 与既有书签不变），
 * 具体视图挂在 `/login/<view>`；公开门户（`/`）不参与视图切换。
 *
 * AdminShell 是 `/login` 这棵树的布局组件（登录门 + 侧边栏 + 顶栏 + `<RouterView>`），
 * 页面组件通过 `state/app-services.ts` 注入共享数据，不再靠 props 逐层传递。
 *
 * 兼容：旧 localStorage 里的 view 会在进入 `/login`（未带子路径）时跳转过去，用户不会"丢失上次的位置"。
 */
export const ADMIN_PREFIX = "/login";
const DEFAULT_VIEW: AppView = "home";

/** 视图的 URL 段（`/login` 之后的路径，空串代表后台首页）。 */
export const VIEW_SEGMENTS: ReadonlyArray<{ view: AppView; segment: string; label: string }> = [
  { view: "home", segment: "", label: "总览" },
  { view: "tasks", segment: "tasks", label: "任务" },
  { view: "missingEpisodes", segment: "missing-episodes", label: "缺集总览" },
  { view: "library", segment: "library", label: "媒体库" },
  { view: "virtualLibraries", segment: "virtual-libraries", label: "虚拟媒体库" },
  { view: "system", segment: "system", label: "系统状态" },
  { view: "logs", segment: "logs", label: "日志" }, // 含「操作审计」Tab
  { view: "config", segment: "config", label: "系统设置" },
  { view: "submissions", segment: "submissions", label: "会员与运营" },
  { view: "cardKeys", segment: "cardKeys", label: "卡密" },
];

/**
 * 已合并/下线视图的旧地址：书签与历史记录仍然可用，重定向到新位置。
 * 合并说明见各组提交信息（会员/日志/设置/日报/回收站）。
 */
export const VIEW_REDIRECTS: ReadonlyArray<{ segment: string; target: string; query?: Record<string, string> }> = [
  // 回收站整条链路（页面 + 接口 + 播放记录同步）已删除，旧书签回总览。
  { segment: "recycle", target: ADMIN_PREFIX },
  // 审计日志已并入日志页的 Tab；旧书签带着 Tab 一起跳过去。
  { segment: "audits", target: `${ADMIN_PREFIX}/logs`, query: { tab: "audit" } },
  // 日报看板已并入总览页的「运营数据」折叠块。
  { segment: "metrics", target: ADMIN_PREFIX },
  // 外部集成已并入系统设置页的「连接与自检」段。
  { segment: "settings", target: `${ADMIN_PREFIX}/config` },
  // 会员与运营已合成一页。
  { segment: "submissionAdmin", target: `${ADMIN_PREFIX}/submissions` },
  // 使用说明页已删除（内容长期落后于实现，改由 README 维护）。
  { segment: "help", target: ADMIN_PREFIX },
  // 自动签到子系统已整体删除，旧书签回总览。
  { segment: "checkin", target: ADMIN_PREFIX },
];

export interface ViewPaths {
  view: AppView;
  path: string;
  label: string;
}

/** 视图 → 完整路径（未知视图回落到默认视图）。 */
export const VIEW_PATHS: ReadonlyArray<ViewPaths> = VIEW_SEGMENTS.map((item) => ({
  view: item.view,
  path: item.segment ? `${ADMIN_PREFIX}/${item.segment}` : ADMIN_PREFIX,
  label: item.label,
}));

const VIEW_BY_PATH = new Map(VIEW_PATHS.map((item) => [item.path, item.view] as const));
const PATH_BY_VIEW = new Map(VIEW_PATHS.map((item) => [item.view, item.path] as const));

export function isAdminPath(pathname: string): boolean {
  return pathname === ADMIN_PREFIX || pathname.startsWith(`${ADMIN_PREFIX}/`);
}

export function pathForView(view: AppView): string {
  return PATH_BY_VIEW.get(view) ?? PATH_BY_VIEW.get(DEFAULT_VIEW)!;
}

/** 路径 → 视图（`/login` 本体即默认视图；未知子路径回落默认视图）。 */
export function viewForPath(pathname: string): AppView {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  if (normalized === ADMIN_PREFIX) return DEFAULT_VIEW;
  return VIEW_BY_PATH.get(normalized) ?? DEFAULT_VIEW;
}

export function viewFromRoute(route: RouteLocationNormalizedLoaded): AppView {
  return viewForPath(route.path);
}

export function createAppRouter(): Router {
  return createRouter({
    history: createWebHistory(),
    routes: [
      {
        path: ADMIN_PREFIX,
        component: AdminShell,
        children: [
          { path: "", component: () => import("./views/DashboardPage.vue") },
          { path: "tasks", component: () => import("./views/TasksPage.vue") },
          { path: "missing-episodes", component: () => import("./views/MissingEpisodesPage.vue") },
          { path: "library", component: () => import("./views/LibraryPage.vue") },
          { path: "virtual-libraries", component: () => import("./views/VirtualLibrariesPage.vue") },
          { path: "system", component: () => import("./views/SystemPage.vue") },
          { path: "logs", component: () => import("./views/LogsPage.vue") },
          { path: "config", component: () => import("./views/SystemSettingsPage.vue") },
          { path: "submissions", component: () => import("./views/MembersPage.vue") },
          { path: "cardKeys", component: () => import("./components/CardKeysView.vue") },
          ...VIEW_REDIRECTS.map((item) => ({
            path: item.segment,
            redirect: item.query ? { path: item.target, query: item.query } : item.target,
          })),
        ],
      },
      // 公开门户与其它路径：App.vue 按路径渲染 PublicPortal，这里登记路由避免 "No match"。
      { path: "/:pathMatch(.*)*", component: { render: () => null }, name: "shell" },
    ],
    scrollBehavior: () => ({ top: 0 }),
  });
}
