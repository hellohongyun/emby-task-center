import { fireEvent, render, screen, waitFor } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminMediaRequest } from "@emby-task-center/contracts/media-request";
import MediaRequestCard from "./MediaRequestCard.vue";

const row: AdminMediaRequest = {
  id: 71,
  kind: "supplement",
  mediaType: "tv",
  tmdbId: 100,
  seasonNumber: 2,
  title: "快捷处理剧集",
  originalTitle: "Quick Review",
  releaseYear: 2026,
  posterUrl: null,
  description: "缺少 E04",
  status: "pending",
  adminNote: "保留原有反馈",
  memberEmail: "fixture@example.test",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.unstubAllGlobals());

describe("administrator request quick actions", () => {
  it("starts processing in one PATCH, preserves feedback and updates the card from the canonical response", async () => {
    const changed = { ...row, status: "processing", updatedAt: "2026-11-02T00:00:00.000Z" };
    const mock = vi.fn<typeof fetch>(async () => json({ request: changed }));
    vi.stubGlobal("fetch", mock);
    const view = render(MediaRequestCard, { props: { item: row, admin: true } });
    await fireEvent.click(screen.getByRole("button", { name: "开始处理" }));
    await screen.findByRole("button", { name: "标为已入库" });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]![0]).toBe("/api/media-requests/71");
    expect(mock.mock.calls[0]![1]!.method).toBe("PATCH");
    expect(JSON.parse(mock.mock.calls[0]![1]!.body as string)).toEqual({
      status: "processing",
      adminNote: row.adminNote,
      updatedAt: row.updatedAt,
    });
    expect(screen.getByText("处理中", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("已更新为处理中");
    expect(view.emitted("saved")).toEqual([[changed]]);
    await view.rerender({ item: { ...row }, admin: true });
    expect(screen.getByText("处理中", { exact: true })).toBeInTheDocument();
    await view.rerender({ item: { ...row, status: "available", updatedAt: "2026-11-02T01:00:00.000Z" }, admin: true });
    expect(screen.getByText("已入库", { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("disables both actions during writes and ignores the second click of a double tap after a fast response", async () => {
    let finish!: (response: Response) => void;
    const mock = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", mock);
    render(MediaRequestCard, { props: { item: row, admin: true } });
    const quick = screen.getByRole("button", { name: "开始处理" });
    await fireEvent.click(quick, { detail: 1 });
    expect(screen.getByRole("button", { name: "保存中…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "处理申请" })).toBeDisabled();
    await fireEvent.click(quick, { detail: 1 });
    expect(mock).toHaveBeenCalledTimes(1);
    finish(json({ request: { ...row, status: "processing", updatedAt: "2026-11-02T00:00:00.000Z" } }));
    const next = await screen.findByRole("button", { name: "标为已入库" });
    await fireEvent.click(next, { detail: 2 });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("已入库", { exact: true })).not.toBeInTheDocument();
  });

  it("marks a processing request available without opening the editor or manufacturing feedback", async () => {
    const current: AdminMediaRequest = {
      ...row,
      status: "processing",
      adminNote: "",
      updatedAt: "2026-11-02T00:00:00.000Z",
    };
    const mock = vi.fn<typeof fetch>(async () =>
      json({ request: { ...current, status: "available", updatedAt: "2026-11-02T00:00:01.000Z" } }),
    );
    vi.stubGlobal("fetch", mock);
    render(MediaRequestCard, { props: { item: current, admin: true } });
    await fireEvent.click(screen.getByRole("button", { name: "标为已入库" }));
    await screen.findByText("已入库", { exact: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "标为已入库" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "处理申请" })).toBeEnabled();
    expect(JSON.parse(mock.mock.calls[0]![1]!.body as string)).toEqual({
      status: "available",
      adminNote: "",
      updatedAt: current.updatedAt,
    });
    expect(screen.queryByText("管理员反馈", { exact: true })).not.toBeInTheDocument();
  });

  it("keeps the current status on version conflict and offers explicit refresh instead of automatic retry", async () => {
    const mock = vi.fn<typeof fetch>(async () => json({ error: "request_changed" }, 409));
    vi.stubGlobal("fetch", mock);
    const view = render(MediaRequestCard, { props: { item: row, admin: true } });
    await fireEvent.click(screen.getByRole("button", { name: "开始处理" }));
    await screen.findByRole("alert");
    expect(view.emitted("saved")).toBeUndefined();
    expect(screen.getByText("待处理", { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "刷新申请" }));
    expect(view.emitted("refresh")).toHaveLength(1);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("cancels waiting on unmount and never emits a late successful mutation", async () => {
    let finish!: (response: Response) => void;
    const mock = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", mock);
    const view = render(MediaRequestCard, { props: { item: row, admin: true } });
    await fireEvent.click(screen.getByRole("button", { name: "开始处理" }));
    view.unmount();
    expect(mock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    finish(json({ request: { ...row, status: "processing" } }));
    await waitFor(() => expect(view.emitted("saved")).toBeUndefined());
  });

  it("does not expose administrator quick actions on member cards", () => {
    render(MediaRequestCard, { props: { item: row } });
    expect(screen.queryByRole("button", { name: "开始处理" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "处理申请" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "补充说明" })).toBeInTheDocument();
  });
});
