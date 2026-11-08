import { fireEvent, render, screen, waitFor, within } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import MediaRequestList from "./MediaRequestList.vue";
import type { AdminMediaRequest } from "@emby-task-center/contracts/media-request";

const row: AdminMediaRequest = {
  id: 9,
  kind: "supplement",
  mediaType: "tv",
  tmdbId: 100,
  seasonNumber: 2,
  title: "流程测试剧",
  originalTitle: "Flow Series",
  releaseYear: 2026,
  posterUrl: null,
  description: "缺少 E03",
  status: "pending",
  adminNote: "原反馈",
  memberEmail: "fixture@example.test",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};
const json = (item = row) => new Response(JSON.stringify({ items: [item], total: 1 }));
const mount = () =>
  render(MediaRequestList, {
    props: { admin: true },
    global: {
      stubs: {
        MediaRequestCard: {
          props: ["item"],
          emits: ["saved"],
          template: `<article><span>{{ item.status }}</span><button @click="$emit('saved', { ...item, status: 'processing', updatedAt: '2026-11-02T00:00:00.000Z' })">模拟处理</button></article>`,
        },
      },
    },
  });
afterEach(() => vi.unstubAllGlobals());

describe("request list updates after processing", () => {
  it("updates a confirmed row locally without reloading the list", async () => {
    const mock = vi.fn<typeof fetch>(async () => json());
    vi.stubGlobal("fetch", mock);
    mount();
    await fireEvent.click(await screen.findByRole("button", { name: "模拟处理" }));
    expect(screen.getByText("processing")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("已更新《流程测试剧》：处理中");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("removes a processed row from the pending filter while retaining search and explaining success", async () => {
    const mock = vi.fn<typeof fetch>(async () => json());
    vi.stubGlobal("fetch", mock);
    mount();
    await screen.findByRole("button", { name: "模拟处理" });
    const filters = screen.getByRole("group", { name: "处理状态筛选" });
    await fireEvent.click(within(filters).getByRole("button", { name: "待处理" }));
    await screen.findByRole("button", { name: "模拟处理" });
    await fireEvent.update(screen.getByLabelText("搜索作品或会员邮箱"), "fixture@example.test");
    await fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await waitFor(() => expect(mock).toHaveBeenCalledTimes(3));
    await fireEvent.click(await screen.findByRole("button", { name: "模拟处理" }));
    expect(screen.queryByRole("button", { name: "模拟处理" })).not.toBeInTheDocument();
    expect(screen.getByText("当前筛选共 0 条")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("处理中");
    expect(screen.getByLabelText("搜索作品或会员邮箱")).toHaveValue("fixture@example.test");
    expect(within(filters).getByRole("button", { name: "待处理" })).toHaveAttribute("aria-pressed", "true");
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it("cancels an older refresh so its response cannot restore the previous status", async () => {
    let finish!: (response: Response) => void;
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    vi.stubGlobal("fetch", mock);
    mount();
    await screen.findByRole("button", { name: "模拟处理" });
    await fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await fireEvent.click(screen.getByRole("button", { name: "模拟处理" }));
    expect(mock.mock.calls[1]![1]!.signal!.aborted).toBe(true);
    finish(json());
    await waitFor(() => expect(screen.getByText("processing")).toBeInTheDocument());
    expect(screen.queryByText("pending")).not.toBeInTheDocument();
    expect(mock).toHaveBeenCalledTimes(2);
  });
});
