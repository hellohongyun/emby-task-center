import { fireEvent, render, screen, waitFor } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import PublicRequestsView from "./PublicRequestsView.vue";

const tv = {
  tmdbId: 100,
  mediaType: "tv",
  title: "同名作品",
  originalTitle: "Same Title",
  releaseYear: 2026,
  posterUrl: "/fixture-poster.png",
  seasons: [{ seasonNumber: 2, name: "第二季", episodeCount: 10, airDate: "2026-01-01" }],
};
const row = {
  id: 42,
  kind: "supplement",
  mediaType: "tv",
  tmdbId: 100,
  title: "同名作品",
  originalTitle: "Same Title",
  releaseYear: 2026,
  posterUrl: null,
  seasonNumber: 2,
  description: "E03–E05",
  status: "pending",
  adminNote: "",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

function setup() {
  let saved = false;
  const mock = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).includes("tmdb/search")) return json({ results: [tv] });
    if (String(url).includes("tmdb/details")) return json({ result: tv });
    if (init?.method === "POST") {
      saved = true;
      return json({ request: row, duplicate: false });
    }
    return json({ items: saved ? [row] : [], total: saved ? 1 : 0 });
  });
  vi.stubGlobal("fetch", mock);
  return { mock, ...render(PublicRequestsView) };
}
async function choose() {
  await fireEvent.update(screen.getByLabelText("搜索作品"), "同名作品");
  await fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  await fireEvent.click(await screen.findByRole("button", { name: /同名作品.*选择/ }));
  await screen.findByLabelText("申请分季");
}

describe("member request mobile flow", () => {
  it("keeps the draft between tabs, separates review, and provides a receipt and records action", async () => {
    const view = setup();
    expect(view.mock).not.toHaveBeenCalled();
    await choose();
    expect(screen.queryByRole("button", { name: /同名作品.*选择/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更换作品" })).toBeInTheDocument();
    await fireEvent.update(screen.getByLabelText("申请分季"), "2");
    await fireEvent.update(screen.getByLabelText("申请类型"), "supplement");
    await fireEvent.update(screen.getByLabelText("缺少的集号或补集说明（必填）"), "E03–E05");
    await fireEvent.click(screen.getByRole("tab", { name: "我的申请" }));
    await waitFor(() =>
      expect(view.mock.mock.calls.filter(([url]) => String(url).includes("media-requests"))).toHaveLength(1),
    );
    await fireEvent.click(screen.getByRole("tab", { name: "提交申请" }));
    expect(screen.getByLabelText("申请分季")).toHaveValue("2");
    expect(screen.getByLabelText("缺少的集号或补集说明（必填）")).toHaveValue("E03–E05");
    await fireEvent.click(screen.getByRole("button", { name: "下一步，核对申请" }));
    expect(screen.getByText("S02 · 第二季 · 10 集")).toBeInTheDocument();
    expect(screen.getByText("E03–E05")).toBeInTheDocument();
    expect(screen.queryByLabelText("申请分季")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认提交" })).toBeDisabled();
    await fireEvent.click(screen.getByRole("button", { name: "返回修改" }));
    expect(screen.getByLabelText("缺少的集号或补集说明（必填）")).toHaveValue("E03–E05");
    await fireEvent.click(screen.getByRole("button", { name: "下一步，核对申请" }));
    await fireEvent.click(screen.getByRole("checkbox"));
    await fireEvent.click(screen.getByRole("button", { name: "确认提交" }));
    expect(await screen.findByText(/申请 #42 已提交/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "查看我的申请" }));
    expect(screen.getByRole("tab", { name: "我的申请" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("待处理")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "+ 提交申请" }));
    expect(screen.getByLabelText("搜索作品")).toHaveValue("");
    view.unmount();
  });
  it("leaves visible poster fallbacks after a result or selected work image fails", async () => {
    const view = setup();
    await fireEvent.update(screen.getByLabelText("搜索作品"), "同名作品");
    await fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await screen.findByRole("button", { name: /同名作品.*选择/ });
    const resultImage = view.container.querySelector<HTMLImageElement>(".result-poster img")!;
    await fireEvent.error(resultImage);
    expect(resultImage).not.toBeVisible();
    expect(view.container.querySelector(".result-poster > span")).toBeVisible();
    await fireEvent.click(screen.getByRole("button", { name: /同名作品.*选择/ }));
    await screen.findByLabelText("申请分季");
    const selectedImage = view.container.querySelector<HTMLImageElement>(".selected-poster img")!;
    await fireEvent.error(selectedImage);
    expect(selectedImage).not.toBeVisible();
    expect(view.container.querySelector(".selected-poster > span")).toBeVisible();
    view.unmount();
  });
});
