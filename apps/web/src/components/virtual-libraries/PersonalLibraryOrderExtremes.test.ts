import { cleanup, fireEvent, render, screen, within } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import PersonalLibraryOrder from "./PersonalLibraryOrder.vue";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const items = [
  { id: "native", name: "实体库", kind: "native" },
  { id: "owned", name: "自建库", kind: "owned" },
  { id: "subscribed", name: "订阅库", kind: "subscribed" },
];
const order = items.map((item) => item.id);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const view = (ids = order) => ({ items, order: ids, hasPersonalOrder: true });
const names = () =>
  within(screen.getByRole("list", { name: "媒体库显示顺序" }))
    .getAllByRole("listitem")
    .map((row) => row.querySelector("strong")?.textContent);

describe("library order extremes", () => {
  it.each(items)(
    "moves $name to either end while preserving other libraries and keeps changes local until saved",
    async (item) => {
      const fetch = vi.fn().mockResolvedValue(json(view()));
      vi.stubGlobal("fetch", fetch);
      render(PersonalLibraryOrder, { props: { personal: true, requireAuth: vi.fn() } });
      await screen.findByRole("button", { name: `置顶 ${item.name}` });
      await fireEvent.click(screen.getByRole("button", { name: `置顶 ${item.name}` }));
      expect(names()).toEqual([item.name, ...items.filter((other) => other.id !== item.id).map((other) => other.name)]);
      await fireEvent.click(screen.getByRole("button", { name: `置底 ${item.name}` }));
      expect(names()).toEqual([...items.filter((other) => other.id !== item.id).map((other) => other.name), item.name]);
      expect(fetch).toHaveBeenCalledTimes(1);
      let expected = [...order.filter((id) => id !== item.id), item.id];
      if (JSON.stringify(expected) === JSON.stringify(order)) {
        await fireEvent.click(screen.getByRole("button", { name: `置顶 ${item.name}` }));
        expected = [item.id, ...order.filter((id) => id !== item.id)];
      }
      fetch.mockResolvedValueOnce(json(view(expected)));
      await fireEvent.click(screen.getByRole("button", { name: "保存顺序" }));
      await screen.findByText("个人顺序已保存，播放器刷新后生效。");
      expect(fetch.mock.calls[1]![0]).toBe("/api/public/virtual-library-order");
      expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ order: expected });
    },
  );

  it("keeps a failed save as a draft and allows undoing it", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(view()))
      .mockResolvedValueOnce(json({ message: "保存失败测试" }, 503));
    vi.stubGlobal("fetch", fetch);
    render(PersonalLibraryOrder, { props: { personal: true, requireAuth: vi.fn() } });
    await fireEvent.click(await screen.findByRole("button", { name: "置顶 订阅库" }));
    await fireEvent.click(screen.getByRole("button", { name: "保存顺序" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("保存失败测试");
    expect(names()).toEqual(["订阅库", "实体库", "自建库"]);
    expect(screen.getByRole("button", { name: "保存顺序" })).not.toBeDisabled();
    await fireEvent.click(screen.getByRole("button", { name: "撤销修改" }));
    expect(names()).toEqual(items.map((item) => item.name));
    expect(screen.getByRole("button", { name: "保存顺序" })).toBeDisabled();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("disables extremes at boundaries and every movement control during saving and refreshing", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(view()))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      );
    vi.stubGlobal("fetch", fetch);
    render(PersonalLibraryOrder, { props: { requireAuth: vi.fn() } });
    expect(await screen.findByRole("button", { name: "置顶 实体库" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "置底 订阅库" })).toBeDisabled();
    await fireEvent.click(screen.getByRole("button", { name: "置顶 订阅库" }));
    await fireEvent.click(screen.getByRole("button", { name: "保存顺序" }));
    for (const button of screen.getAllByRole("button", { name: /^(置顶|置底|上移|下移) / }))
      expect(button).toBeDisabled();
    finish(json(view(["subscribed", "native", "owned"])));
    await screen.findByText("个人顺序已保存，播放器刷新后生效。");
    await fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    for (const button of screen.getAllByRole("button", { name: /^(置顶|置底|上移|下移) / }))
      expect(button).toBeDisabled();
    finish(json(view()));
    await screen.findByRole("button", { name: "置顶 实体库" });
  });

  it("uses the same draft and save behavior for the default template", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(view()))
      .mockResolvedValueOnce(json(view(["owned", "subscribed", "native"])));
    vi.stubGlobal("fetch", fetch);
    render(PersonalLibraryOrder, { props: { defaults: true, requireAuth: vi.fn() } });
    await fireEvent.click(await screen.findByRole("button", { name: "置底 实体库" }));
    expect(fetch).toHaveBeenCalledTimes(1);
    await fireEvent.click(screen.getByRole("button", { name: "保存顺序" }));
    await screen.findByText("默认模板已保存，不覆盖用户个人顺序。");
    expect(fetch.mock.calls[1]![0]).toBe("/api/virtual-library-market/order");
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ order: ["owned", "subscribed", "native"] });
  });
});
