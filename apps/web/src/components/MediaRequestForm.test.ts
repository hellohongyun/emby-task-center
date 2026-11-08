import { fireEvent, render, screen, waitFor } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import MediaRequestForm from "./MediaRequestForm.vue";
import MediaRequestCard from "./MediaRequestCard.vue";
import type { MediaRequest } from "@emby-task-center/contracts/media-request";

const tv = {
  tmdbId: 100,
  mediaType: "tv",
  title: "测试剧",
  originalTitle: "Test Series",
  releaseYear: 2026,
  posterUrl: null,
  seasons: [
    { seasonNumber: 1, name: "第一季", episodeCount: 12, airDate: "2026-01-01" },
    { seasonNumber: 2, name: "第二季", episodeCount: 10, airDate: null },
  ],
};
const row: MediaRequest = {
  id: 1,
  kind: "supplement",
  mediaType: "tv",
  tmdbId: 100,
  seasonNumber: 1,
  title: "测试剧",
  originalTitle: "Test Series",
  releaseYear: 2026,
  posterUrl: null,
  description: "E13",
  status: "pending",
  adminNote: "",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.unstubAllGlobals());

async function selectSeries() {
  await fireEvent.update(screen.getByLabelText("搜索作品"), "测试剧");
  await fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  await fireEvent.click(await screen.findByRole("button", { name: /测试剧.*选择/ }));
  await screen.findByLabelText("申请分季");
}

describe("media request submission and handling", () => {
  it("requires a precise TV season and confirmation, submits supplement details, and preserves the existing request on duplicate", async () => {
    const mock = vi.fn<typeof fetch>(async (url) => {
      const path = String(url);
      if (path.includes("tmdb/search")) return json({ results: [tv] });
      if (path.includes("tmdb/details")) return json({ result: tv });
      return json({ request: row, duplicate: true });
    });
    vi.stubGlobal("fetch", mock);
    const view = render(MediaRequestForm);
    await selectSeries();
    expect(screen.getByRole("button", { name: "下一步，核对申请" })).toBeDisabled();
    await fireEvent.update(screen.getByLabelText("申请分季"), "2");
    await fireEvent.update(screen.getByLabelText("申请类型"), "supplement");
    expect(screen.getByRole("button", { name: "下一步，核对申请" })).toBeDisabled();
    await fireEvent.update(screen.getByLabelText("缺少的集号或补集说明（必填）"), "E03–E05，缺少中文字幕");
    await fireEvent.click(screen.getByRole("button", { name: "下一步，核对申请" }));
    expect(screen.getByRole("button", { name: "确认提交" })).toBeDisabled();
    await fireEvent.click(screen.getByRole("checkbox"));
    await fireEvent.click(screen.getByRole("button", { name: "确认提交" }));
    await screen.findByText(/已有未结束申请 #1/);
    const post = mock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(post[1]!.body as string)).toEqual({
      kind: "supplement",
      mediaType: "tv",
      tmdbId: 100,
      seasonNumber: 2,
      description: "E03–E05，缺少中文字幕",
    });
    expect(view.emitted("submitted")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "确认提交" })).not.toBeInTheDocument();
  });

  it("does not permit a TV request without authoritative season metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) =>
        String(url).includes("search") ? json({ results: [tv] }) : json({ result: { ...tv, seasons: [] } }),
      ),
    );
    render(MediaRequestForm);
    await selectSeries();
    expect(screen.getByRole("alert")).toHaveTextContent("暂缺可确认的分季资料");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下一步，核对申请" })).toBeDisabled();
  });

  it("clears the first work's explanation when the member chooses a different work", async () => {
    const other = { ...tv, tmdbId: 200, title: "另一部剧" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (String(url).includes("search")) return json({ results: [tv, other] });
        return json({ result: String(url).includes("id=200") ? other : tv });
      }),
    );
    render(MediaRequestForm);
    await selectSeries();
    await fireEvent.update(screen.getByLabelText("申请说明（可选）"), "第一部剧缺少 E13");
    await fireEvent.click(screen.getByRole("button", { name: "更换作品" }));
    await fireEvent.click(screen.getByRole("button", { name: /另一部剧.*选择/ }));
    await waitFor(() => expect(screen.getByLabelText("申请说明（可选）")).toHaveValue(""));
    expect(screen.getByLabelText("申请分季")).toHaveValue("");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("uses the original version for admin handling and keeps a conflicting draft", async () => {
    const mock = vi.fn<typeof fetch>(async () => json({ error: "request_changed" }, 409));
    vi.stubGlobal("fetch", mock);
    const view = render(MediaRequestCard, { props: { item: { ...row, memberEmail: "a@example.test" }, admin: true } });
    await fireEvent.click(screen.getByRole("button", { name: "处理申请" }));
    await fireEvent.click(screen.getByRole("radio", { name: "已入库" }));
    await fireEvent.update(screen.getByLabelText("给会员的反馈"), "已补齐，刷新客户端查看");
    await fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("已被更新"));
    expect(screen.getByLabelText("给会员的反馈")).toHaveValue("已补齐，刷新客户端查看");
    expect(JSON.parse(mock.mock.calls[0]![1]!.body as string)).toEqual({
      status: "available",
      adminNote: "已补齐，刷新客户端查看",
      updatedAt: row.updatedAt,
    });
    expect(view.emitted("saved")).toBeUndefined();
    await fireEvent.click(screen.getByRole("button", { name: "取消编辑并刷新" }));
    expect(view.emitted("refresh")).toHaveLength(1);
    expect(screen.queryByLabelText("给会员的反馈")).not.toBeInTheDocument();
  });

  it("cancels lookup when leaving and ignores its late result", async () => {
    let finish!: (response: Response) => void;
    const mock = vi.fn<typeof fetch>(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    vi.stubGlobal("fetch", mock);
    const view = render(MediaRequestForm);
    await fireEvent.update(screen.getByLabelText("搜索作品"), "测试剧");
    await fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    view.unmount();
    expect(mock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    finish(json({ results: [tv] }));
    await Promise.resolve();
    expect(view.emitted("submitted")).toBeUndefined();
  });
});
