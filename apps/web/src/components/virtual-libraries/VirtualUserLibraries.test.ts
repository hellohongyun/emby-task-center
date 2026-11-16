import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/vue";
import { afterEach, expect, it, vi } from "vitest";
import VirtualUserLibraries from "./VirtualUserLibraries.vue";
import VirtualReadonlyFilms from "./VirtualReadonlyFilms.vue";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const film = { itemId: "movie/id", name: "天空之旅", type: "Movie", year: 2025, imageTag: null };
const series = { itemId: "series-id", name: "远方的故事", type: "Series", year: 2024, imageTag: "cover-tag" };
const libraries = [
  { id: "first", name: "第一片单", ownerEmail: "first@example.test", authorName: "用户", itemCount: 1 },
  { id: "second", name: "第二片单", ownerEmail: "second@example.test", authorName: "用户", itemCount: 1 },
];
it("requests relation-scoped posters including historical items without tags and provides filters and a failed-image fallback", async () => {
  render(VirtualReadonlyFilms, { props: { libraryId: "lib/id", items: [film, series] } });
  const poster = screen.getByRole("img", { name: "天空之旅 海报" });
  expect(poster).toHaveAttribute("src", "/api/virtual-library-market/user-libraries/lib%2Fid/items/movie%2Fid/poster");
  await fireEvent.error(poster);
  expect(screen.getByRole("img", { name: "天空之旅暂无海报" })).toBeTruthy();
  await fireEvent.update(screen.getByRole("combobox", { name: "内容类型" }), "Movie");
  expect(screen.queryByRole("article", { name: series.name })).toBeNull();
  await fireEvent.update(screen.getByRole("searchbox", { name: "搜索当前库影片" }), "不存在");
  expect(screen.getByText("没有匹配的影片")).toBeTruthy();
  expect(screen.queryByText("此库尚无影片。")).toBeNull();
  await fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
  expect(screen.getAllByRole("article")).toHaveLength(2);
});
it("shows an empty library separately from filtered results", () => {
  render(VirtualReadonlyFilms, { props: { libraryId: "empty", items: [] } });
  expect(screen.getByText("此库尚无影片。")).toBeTruthy();
  expect(screen.queryByText("没有匹配的影片")).toBeNull();
});
it("clears previous contents during library switches and ignores an older response", async () => {
  let first!: (value: Response) => void;
  let second!: (value: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      url.endsWith("/user-libraries")
        ? Promise.resolve(json({ libraries }))
        : new Promise<Response>((resolve) => {
            if (url.includes("/first/")) first = resolve;
            else second = resolve;
          }),
    ),
  );
  render(VirtualUserLibraries, { props: { requireAuth: vi.fn() } });
  const other = await screen.findByRole("button", { name: "第二片单 second@example.test" });
  const toggle = screen.getByText("切换媒体库", { selector: "button" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(toggle).toHaveAttribute("aria-controls", "vul-picker-options");
  await fireEvent.click(toggle);
  expect(screen.getByText("收起选择", { selector: "button" })).toHaveAttribute("aria-expanded", "true");
  await fireEvent.click(other);
  expect(screen.getByText("切换媒体库", { selector: "button" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText("正在读取内容…")).toBeTruthy();
  second(json({ items: [series] }));
  await screen.findByRole("heading", { name: series.name });
  first(json({ items: [film] }));
  await waitFor(() => expect(screen.queryByRole("heading", { name: film.name })).toBeNull());
  expect(other).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("button", { name: /删除|修改|编辑|上架/ })).toBeNull();
});
it("shows a failed read with retry instead of falsely reporting an empty library", async () => {
  let attempts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/user-libraries")
        ? json({ libraries })
        : ++attempts === 1
          ? json({ message: "来源暂不可用" }, 503)
          : json({ items: [] }),
    ),
  );
  render(VirtualUserLibraries, { props: { requireAuth: vi.fn() } });
  await screen.findByRole("alert");
  expect(screen.getByText("内容读取失败")).toBeTruthy();
  expect(screen.queryByText("此库尚无影片。")).toBeNull();
  await fireEvent.click(screen.getByRole("button", { name: "重试读取内容" }));
  await screen.findByText("此库尚无影片。");
  expect(screen.queryByRole("alert")).toBeNull();
});
