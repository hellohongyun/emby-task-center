import { fireEvent, render, screen } from "@testing-library/vue";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import AppHeader from "./AppHeader.vue";
import MobileNav from "./MobileNav.vue";
import SidebarNav from "./SidebarNav.vue";
import { VIEW_SEGMENTS } from "../router";
describe("application chrome", () => {
  it("only exposes functional header actions", async () => {
    const view = render(AppHeader, { props: { query: "", view: "tasks" } });
    expect(screen.queryByRole("button", { name: "通知" })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "系统" }));
    expect(view.emitted().system).toHaveLength(1);
  });
  it("routes task, library and system destinations", async () => {
    const view = render(SidebarNav, { props: { view: "tasks" } });
    await fireEvent.click(screen.getByRole("button", { name: "媒体库" }));
    await fireEvent.click(screen.getByRole("button", { name: "系统状态" }));
    expect(view.emitted().view).toEqual([["library"], ["system"]]);
  });
  it("opens card keys from mobile more and keeps its destination active", async () => {
    const view = render(MobileNav, { props: { view: "tasks" } });
    const more = screen.getByRole("button", { name: "更多菜单", hidden: true });
    await fireEvent.click(more);
    await fireEvent.click(screen.getByRole("button", { name: "卡密", hidden: true }));
    expect(view.emitted().view).toEqual([["cardKeys"]]);
    expect(screen.queryByRole("dialog", { name: "更多功能", hidden: true })).not.toBeInTheDocument();
    expect(more).toHaveAttribute("aria-expanded", "false");

    await view.rerender({ view: "cardKeys" });
    expect(more).toHaveClass("active");
    await fireEvent.click(more);
    expect(screen.getByRole("button", { name: "卡密", hidden: true })).toHaveClass("active");
  });
  it("shows the card keys title in the mobile header", () => {
    render(AppHeader, { props: { query: "", view: "cardKeys" } });
    expect(screen.getByText("卡密")).toBeInTheDocument();
    expect(screen.queryByText("任务中心")).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { hidden: true })).not.toBeInTheDocument();
  });
  it("no longer offers the retired check-in destination", async () => {
    // 自动签到子系统整体删除（2026-09）：侧边栏、移动端「更多」菜单与路由段都不该再留入口。
    const sidebar = render(SidebarNav, { props: { view: "tasks" } });
    // 正反两面都断言：不是"什么都没渲染"才通过的。
    expect(screen.getByRole("button", { name: "任务中心" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "自动签到" })).not.toBeInTheDocument();
    sidebar.unmount();

    render(MobileNav, { props: { view: "tasks" } });
    await fireEvent.click(screen.getByRole("button", { name: "更多菜单", hidden: true }));
    expect(screen.getByRole("button", { name: "系统状态", hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "自动签到", hidden: true })).not.toBeInTheDocument();

    // 路由表里也不该再有这个段（类型上 AppView 已经没有 "checkin"，这里按 URL 段再兜一层）。
    expect(VIEW_SEGMENTS.map((item) => item.segment)).not.toContain("checkin");
  });

  it("keeps narrow mobile chrome within the viewport", () => {
    const header = readFileSync(resolve(process.cwd(), "src/components/AppHeader.vue"), "utf8");
    const board = readFileSync(resolve(process.cwd(), "src/components/TaskTrackingBoard.vue"), "utf8");
    expect(header).toContain("@media (max-width: 360px)");
    expect(header).toContain("white-space: nowrap");
    // 触控目标：看板里的行/按钮都不小于 44px（CSS 断言只看规则本身，不看排版）。
    expect(compact(board)).toContain(compact("min-height: 44px"));
  });
});

/** 去掉全部空白，用于比较 CSS 规则内容（与格式化无关）。 */
function compact(css: string): string {
  return css.replace(/\s+/g, "");
}
