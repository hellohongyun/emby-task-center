import { fireEvent, render, screen, waitFor, within } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import MediaRequestList from "./MediaRequestList.vue";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
afterEach(() => vi.unstubAllGlobals());
describe("request status shortcuts", () => {
  it("filters exact states and keeps text search, without displaying invented global totals", async () => {
    const mock = vi.fn<typeof fetch>(async () => json({ items: [], total: 0 }));
    vi.stubGlobal("fetch", mock);
    render(MediaRequestList, { props: { admin: true } });
    await screen.findByText("暂无符合条件的申请");
    const group = screen.getByRole("group", { name: "处理状态筛选" });
    expect(within(group).getByRole("button", { name: "全部" })).toHaveAttribute("aria-pressed", "true");
    await fireEvent.click(within(group).getByRole("button", { name: "已入库" }));
    await waitFor(() => expect(mock).toHaveBeenCalledTimes(2));
    expect(String(mock.mock.calls[mock.mock.calls.length - 1]![0])).toContain("status=available");
    expect(within(group).getByRole("button", { name: "已入库" })).toHaveAttribute("aria-pressed", "true");
    await fireEvent.update(screen.getByLabelText("搜索作品或会员邮箱"), "测试剧");
    await fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await waitFor(() => expect(mock).toHaveBeenCalledTimes(3));
    const url = new URL(String(mock.mock.calls[mock.mock.calls.length - 1]![0]), "http://local");
    expect(url.searchParams.get("q")).toBe("测试剧");
    expect(url.searchParams.get("status")).toBe("available");
    await fireEvent.click(within(group).getByRole("button", { name: "全部" }));
    await waitFor(() => expect(mock).toHaveBeenCalledTimes(4));
    expect(String(mock.mock.calls[mock.mock.calls.length - 1]![0])).not.toContain("status=");
    expect(group).not.toHaveTextContent(/\d/);
    expect(await screen.findByText("当前筛选共 0 条")).toBeInTheDocument();
  });
});
