import { fireEvent, render, screen } from "@testing-library/vue";
import { describe, expect, it } from "vitest";
import MobileNav from "./MobileNav.vue";

describe("MobileNav", () => {
  it("routes tasks and library without the removed filter or publish buttons", async () => {
    const view = render(MobileNav);
    await fireEvent.click(screen.getByRole("button", { name: "任务", hidden: true }));
    await fireEvent.click(screen.getByRole("button", { name: "媒体库", hidden: true }));
    expect(view.emitted().view).toEqual([["tasks"], ["library"]]);
    // 底栏的「追更」筛选与「发布任务」都已删除（筛选移到看板内部，发布链路整条不存在）
    expect(screen.queryByRole("button", { name: "追更", hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "发布任务", hidden: true })).not.toBeInTheDocument();
  });

  it("opens the more menu and routes every desktop view", async () => {
    const view = render(MobileNav);
    await fireEvent.click(screen.getByRole("button", { name: "更多菜单", hidden: true }));

    for (const [name, key] of [
      ["系统状态", "system"],
      ["系统设置", "config"],
    ] as const) {
      await fireEvent.click(screen.getByRole("button", { name, hidden: true }));
      expect(view.emitted().view?.slice(-1)[0]).toEqual([key]);
      await fireEvent.click(screen.getByRole("button", { name: "更多菜单", hidden: true }));
    }
  });

  it("closes the more menu after routing and emits logout", async () => {
    const view = render(MobileNav, { props: { view: "config" } });
    await fireEvent.click(screen.getByRole("button", { name: "更多菜单", hidden: true }));
    await fireEvent.click(screen.getByRole("button", { name: "系统状态", hidden: true }));

    expect(view.emitted().view?.slice(-1)[0]).toEqual(["system"]);
    expect(screen.queryByRole("button", { name: "LitePan 队列", hidden: true })).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "更多菜单", hidden: true }));
    await fireEvent.click(screen.getByRole("button", { name: "退出登录", hidden: true }));
    expect(view.emitted().logout).toHaveLength(1);
  });
});
