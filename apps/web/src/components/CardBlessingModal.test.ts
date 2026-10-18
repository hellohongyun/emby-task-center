import { fireEvent, render, screen } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import CardBlessingModal from "./CardBlessingModal.vue";

/**
 * 彩蛋弹窗（1.3 / 1.5）。
 *
 * 这组用例守两件事：
 *  ① **口径**：到期主行必须是管理员写的「名称」，真实日期只能是小字；没配文案就不弹；
 *  ② **装饰不能污染可读性**：彩带是纯装饰，必须对读屏隐藏、且不能往弹窗里塞文本，
 *     否则读屏用户会听到一堆无意义内容，而正常人看到的是一个干净的祝福。
 */

const card = {
  name: "国庆卡密",
  expiryText: "2027国庆到期",
  expiryDetail: "2027-10-07",
  expiryDays: 387,
  blessing: "山河同庆的日子，把忙碌先放一放，愿光影陪你虚度几段温柔时光。国庆快乐。",
};

describe("CardBlessingModal", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("没有卡密时不渲染任何东西（没配彩蛋文案的卡不该弹）", () => {
    render(CardBlessingModal, { props: { card: null } });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("弹窗用卡密名称做标题，到期主行是名称、真实日期是小字", () => {
    render(CardBlessingModal, { props: { card } });

    const dialog = screen.getByRole("dialog");
    // 可访问名 = 卡密名称（管理员 DIY 的那个），不是"自定义"这种类型标签
    expect(dialog.getAttribute("aria-labelledby")).toBe("blessing-title");
    expect(screen.getByRole("heading", { name: "国庆卡密" })).toBeTruthy();

    const ticket = dialog.querySelector(".ticket")!;
    expect(ticket.textContent).toContain("到期时间");
    expect(ticket.textContent).toContain("2027国庆到期");
    expect(ticket.textContent).toContain("2027-10-07");
    expect(ticket.textContent).toContain("还剩 387 天");
    // 名称必须在真实日期前面（名称优先的排版口径）
    expect(ticket.textContent!.indexOf("2027国庆到期")).toBeLessThan(ticket.textContent!.indexOf("2027-10-07"));

    expect(dialog.textContent).toContain(card.blessing);
  });

  it("彩带只是装饰：整层对读屏隐藏，且不往弹窗正文里加字", () => {
    render(CardBlessingModal, { props: { card } });
    const dialog = screen.getByRole("dialog");

    const layer = dialog.querySelector(".confetti-layer")!;
    expect(layer).toBeTruthy();
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    // 装饰层里不能有可见文本
    expect(layer.textContent?.trim()).toBe("");
    expect(layer.querySelectorAll(".confetti").length).toBeGreaterThan(0);
  });

  it("相对天数卡没有确定到期日：只显示名称口径，不显示真实日期与剩余天数", () => {
    render(CardBlessingModal, {
      props: { card: { ...card, name: "月卡", expiryText: "兑换后 30 天", expiryDetail: null, expiryDays: null } },
    });
    const ticket = screen.getByRole("dialog").querySelector(".ticket")!;
    expect(ticket.textContent).toContain("兑换后 30 天");
    expect(ticket.textContent).not.toContain("还剩");
    expect(ticket.querySelector("small")).toBeNull();
  });

  it("Esc 关闭，点「开心收下」也关闭", async () => {
    const close = vi.fn();
    const { unmount } = render(CardBlessingModal, {
      props: { card, onClose: close },
    });

    await fireEvent.keyDown(document, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByRole("button", { name: "开心收下" }));
    expect(close).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("卸载后不再监听 Esc（避免在别的页面上误触）", async () => {
    const close = vi.fn();
    const { unmount } = render(CardBlessingModal, { props: { card, onClose: close } });
    unmount();
    await fireEvent.keyDown(document, { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
  });
});
