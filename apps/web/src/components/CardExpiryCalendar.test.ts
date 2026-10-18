import { fireEvent, render, screen } from "@testing-library/vue";
import { describe, expect, it } from "vitest";

import CardExpiryCalendar from "./CardExpiryCalendar.vue";

/**
 * 到期日选择器。
 *
 * 管理员真正要判断的是"离今天还有多少天"，所以除了"选出来的值对不对"，
 * 这里还要守住两件事：① 快捷预设按**今天**起算（不是按上次选中的值）；
 * ② 选中后立刻把剩余天数摆出来，不让人自己掰手指算。
 */
function keyOf(offsetDays: number): string {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function openPicker() {
  await fireEvent.click(screen.getByRole("button", { name: /选择到期日期|^\d{4}-\d{2}-\d{2}/ }));
}

describe("CardExpiryCalendar 到期日选择器", () => {
  it("快捷预设按今天起算，点一下就选好整段时长", async () => {
    const wrapper = render(CardExpiryCalendar, { props: { modelValue: "" } });
    await openPicker();
    await fireEvent.click(screen.getByRole("button", { name: "1 年" }));
    const emitted = wrapper.emitted("update:modelValue") ?? [];
    expect(emitted[emitted.length - 1]).toEqual([keyOf(365)]);
  });

  it("选中日期后立刻显示剩余天数，选到今天就写「今天到期」", async () => {
    const { rerender } = render(CardExpiryCalendar, { props: { modelValue: keyOf(0) } });
    expect(screen.getByText("今天到期")).toBeTruthy();

    await rerender({ modelValue: keyOf(30) });
    expect(screen.getByText("距今 30 天")).toBeTruthy();
  });

  it("已经过去的日期会被标红提醒（过期卡不能被兑换）", async () => {
    render(CardExpiryCalendar, { props: { modelValue: keyOf(-3) } });
    expect(screen.getByText("已经过期 3 天")).toBeTruthy();
  });

  it("弹层里选中的那天被高亮，并且有「当天 23:59 到期」的口径说明", async () => {
    render(CardExpiryCalendar, { props: { modelValue: keyOf(10) } });
    await openPicker();

    const picked = document.querySelector(".day.picked");
    expect(picked?.textContent?.trim()).toBe(String(new Date(keyOf(10)).getDate()));
    expect(screen.getByText(/当天 23:59 计/)).toBeTruthy();
  });

  it("弹层可以关掉，不会一直盖在表单上", async () => {
    render(CardExpiryCalendar, { props: { modelValue: keyOf(5) } });
    await openPicker();
    expect(screen.getByRole("dialog")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("禁用时点不开（生成中不该还能改日期）", async () => {
    render(CardExpiryCalendar, { props: { modelValue: "", disabled: true } });
    await openPicker();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
