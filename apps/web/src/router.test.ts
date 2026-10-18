import { describe, expect, it } from "vitest";

import {
  ADMIN_PREFIX,
  createAppRouter,
  isAdminPath,
  pathForView,
  VIEW_PATHS,
  viewForPath,
  viewFromRoute,
} from "./router";

describe("view <-> URL mapping", () => {
  it("round-trips every view through its path", () => {
    for (const item of VIEW_PATHS) {
      expect(pathForView(item.view)).toBe(item.path);
      expect(viewForPath(item.path)).toBe(item.view);
    }
  });

  it("treats the admin entry itself as the default view", () => {
    expect(viewForPath(ADMIN_PREFIX)).toBe("home");
    expect(viewForPath("/login/")).toBe("home");
  });

  it("falls back to the default view for unknown admin sub-paths", () => {
    expect(viewForPath("/login/does-not-exist")).toBe("home");
    expect(viewForPath("/login/tasks/")).toBe("tasks");
  });

  it("recognises admin paths without swallowing lookalikes", () => {
    expect(isAdminPath("/login")).toBe(true);
    expect(isAdminPath("/login/tasks")).toBe(true);
    expect(isAdminPath("/loginish")).toBe(false);
    expect(isAdminPath("/")).toBe(false);
    expect(isAdminPath("/submit")).toBe(false);
  });
});

describe("router", () => {
  it("registers a route component for every view", async () => {
    const router = createAppRouter();
    await router.push("/login");
    await router.isReady();

    for (const item of VIEW_PATHS) {
      const resolved = router.resolve(item.path);
      const leaf = resolved.matched[resolved.matched.length - 1];
      expect(leaf?.components?.default, `${item.view} (${item.path}) 缺少路由组件`).toBeTruthy();
      // 除首页外都应是 /login 的子路由（即由 AdminShell 布局渲染）
      expect(resolved.matched[0]?.path).toBe("/login");
    }
  });

  it("resolves deep links and reports the matching view", async () => {
    const router = createAppRouter();
    await router.push("/login/cardKeys");
    await router.isReady();

    expect(router.currentRoute.value.path).toBe("/login/cardKeys");
    expect(viewFromRoute(router.currentRoute.value)).toBe("cardKeys");
  });

  it("redirects the addresses of views that were merged away", async () => {
    const router = createAppRouter();
    // 审计日志 → 日志页的「操作审计」Tab（旧书签不失效）
    await router.push("/login/audits");
    await router.isReady();
    expect(router.currentRoute.value.path).toBe("/login/logs");
    expect(router.currentRoute.value.query.tab).toBe("audit");
    // 回收站已下线 → 总览
    await router.push("/login/recycle");
    await router.isReady();
    expect(router.currentRoute.value.path).toBe("/login");
  });

  it("matches any path so the SPA shell can render (server does the rest)", async () => {
    const router = createAppRouter();
    await router.push("/submit");
    await router.isReady();

    expect(router.currentRoute.value.matched.length).toBeGreaterThan(0);
    expect(viewFromRoute(router.currentRoute.value)).toBe("home");
  });
});
