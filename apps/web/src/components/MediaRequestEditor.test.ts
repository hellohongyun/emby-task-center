import { fireEvent, render, screen, waitFor, within } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminMediaRequest } from "@emby-task-center/contracts/media-request";
import MediaRequestCard from "./MediaRequestCard.vue";
import MediaRequestEditor from "./MediaRequestEditor.vue";

const row: AdminMediaRequest = {
  id: 41,
  kind: "supplement",
  mediaType: "tv",
  tmdbId: 100,
  seasonNumber: 2,
  title: "测试剧集",
  originalTitle: "Review Series",
  releaseYear: 2026,
  posterUrl: "/poster.png",
  description: "缺少 E03、E04",
  status: "pending",
  adminNote: "",
  memberEmail: "fixture@example.test",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.style.overflow = "";
});

describe("compact media request cards and modal processing", () => {
  it("opens a focused modal, locks the page, restores focus and supports Escape/cancel", async () => {
    document.body.style.overflow = "auto";
    render(MediaRequestCard, { props: { item: row, admin: true } });
    expect(screen.getByRole("heading", { name: row.title })).toBeInTheDocument();
    expect(screen.getByText("S02")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "处理申请" });
    trigger.focus();
    await fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: row.title });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(document.body.style.overflow).toBe("hidden");
    const close = within(dialog).getByRole("button", { name: "关闭申请编辑" });
    await waitFor(() => expect(close).toHaveFocus());
    const save = within(dialog).getByRole("button", { name: "保存" });
    save.focus();
    await fireEvent.keyDown(save, { key: "Tab" });
    expect(close).toHaveFocus();
    await fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(save).toHaveFocus();
    await fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("auto");
    expect(trigger).toHaveFocus();
    await fireEvent.click(trigger);
    await fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps original request version and a conflicting draft until explicit cancel and refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "request_changed" }, 409)),
    );
    const view = render(MediaRequestCard, { props: { item: row, admin: true } });
    await fireEvent.click(screen.getByRole("button", { name: "处理申请" }));
    await fireEvent.update(screen.getByLabelText("给会员的反馈"), "正在补齐");
    await view.rerender({ item: { ...row, updatedAt: "2026-11-01T01:00:00.000Z" }, admin: true });
    await fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("给会员的反馈")).toHaveValue("正在补齐");
    const sent = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
    expect(sent.updatedAt).toBe(row.updatedAt);
    await fireEvent.click(screen.getByRole("button", { name: "取消编辑并刷新" }));
    expect(view.emitted("refresh")).toHaveLength(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("prevents dismissal while saving and closes only after confirmed success", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const view = render(MediaRequestCard, { props: { item: row, admin: true } });
    await fireEvent.click(screen.getByRole("button", { name: "处理申请" }));
    await fireEvent.click(screen.getByRole("radio", { name: "已入库" }));
    await fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "关闭申请编辑" })).toBeDisabled();
    await fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    finish(json({ request: { ...row, status: "available" } }));
    await waitFor(() => expect(view.emitted("saved")).toHaveLength(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
  });

  it("supports member-only description edits, full long descriptions and neutral poster fallback", async () => {
    const mock = vi.fn<typeof fetch>(async () => json({ request: row }));
    vi.stubGlobal("fetch", mock);
    render(MediaRequestCard, { props: { item: { ...row, description: "缺集说明".repeat(40) } } });
    await fireEvent.error(document.querySelector(".poster img")!);
    expect(document.querySelector(".poster-placeholder")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "展开说明" }));
    expect(screen.getByRole("button", { name: "收起说明" })).toHaveAttribute("aria-expanded", "true");
    await fireEvent.click(screen.getByRole("button", { name: "补充说明" }));
    expect(screen.queryByLabelText("处理状态")).not.toBeInTheDocument();
    await fireEvent.update(screen.getByLabelText("申请说明"), "缺少 E03 到 E06");
    await fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mock).toHaveBeenCalledTimes(1));
    expect(String(mock.mock.calls[0]![0])).toBe(`/api/public/media-requests/${row.id}`);
  });

  it("keeps current status and existing feedback until explicit save and emits the canonical response", async () => {
    const canonical = {
      ...row,
      status: "processing" as const,
      adminNote: "服务器确认的反馈",
      updatedAt: "2026-11-02T00:00:00.000Z",
    };
    const mock = vi.fn<typeof fetch>(async () => json({ request: canonical }));
    vi.stubGlobal("fetch", mock);
    const view = render(MediaRequestEditor, { props: { item: { ...row, adminNote: "原反馈" }, admin: true } });
    const group = screen.getByRole("group", { name: "处理状态" });
    expect(within(group).getAllByRole("radio")).toHaveLength(4);
    expect(within(group).getByRole("radio", { name: "待处理" })).toBeChecked();
    expect(screen.getByLabelText("给会员的反馈")).toHaveValue("原反馈");
    await fireEvent.click(within(group).getByRole("radio", { name: "处理中" }));
    expect(mock).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(view.emitted("saved")?.[0]).toEqual([canonical]));
    expect(JSON.parse(mock.mock.calls[0]![1]!.body as string)).toEqual({
      status: "processing",
      adminNote: "原反馈",
      updatedAt: row.updatedAt,
    });
    view.unmount();
  });

  it("limits a long request preview while leaving feedback editable and expands identity only on demand", async () => {
    const mock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", mock);
    const view = render(MediaRequestEditor, {
      props: { item: { ...row, description: "长篇缺集说明".repeat(100) }, admin: true },
    });
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector(".description-preview")).toBeInTheDocument();
    expect(screen.getByLabelText("给会员的反馈")).toBeVisible();
    await fireEvent.update(screen.getByLabelText("给会员的反馈"), "保留的草稿");
    const expand = screen.getByRole("button", { name: "展开说明" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    await fireEvent.click(expand);
    expect(screen.getByRole("button", { name: "收起说明" })).toHaveAttribute("aria-expanded", "true");
    expect(dialog.querySelector(".description-preview")).not.toBeInTheDocument();
    expect(dialog.querySelector("details")).not.toHaveAttribute("open");
    expect(screen.getByLabelText("给会员的反馈")).toHaveValue("保留的草稿");
    await fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(mock).not.toHaveBeenCalled();
    view.unmount();
  });
});
