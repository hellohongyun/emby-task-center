import { fireEvent, render, screen, waitFor } from "@testing-library/vue";
import { describe, expect, it } from "vitest";
import LibraryView from "./LibraryView.vue";
import { libraryFixture } from "../test/library-fixture";

describe("LibraryView", () => {
  it("loads only one library page and uses total file counts instead of representative rows", async () => {
    const { library, fetchImpl } = libraryFixture(60);
    render(LibraryView, { props: { library } });
    await screen.findByRole("button", { name: "查看 仙逆" });
    expect(screen.getByText("整部剧")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^查看 / })).toHaveLength(48);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^查看 / })).toHaveLength(12));
    expect(fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1]?.[0]).toContain("page=2");
    await fireEvent.update(screen.getByRole("combobox", { name: "选择媒体库" }), "movie");
    await waitFor(() => expect(library.worksPage.value?.root.id).toBe("movie"));
    expect(fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1]?.[0]).toContain("/movie/works?page=1");
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/inventory"))).toBe(false);
  });

  it("runs filters on the server and loads full episode details only when opened", async () => {
    const { library, fetchImpl } = libraryFixture();
    render(LibraryView, { props: { library } });
    await screen.findByRole("button", { name: "查看 仙逆" });
    await fireEvent.click(screen.getByRole("button", { name: "剧集" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "查看 阿凡达" })).not.toBeInTheDocument());
    expect(fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1]?.[0]).toContain("type=tv");
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/works/items"))).toBe(false);
    await fireEvent.click(screen.getByRole("button", { name: "查看 仙逆" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("仙逆 S01E159.strm")).toBeInTheDocument();
    expect(fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1]?.[0]).toContain("/works/items?key=work-0");
  });

  it("refreshes overview and current page after a lightweight scan", async () => {
    const { library, fetchImpl } = libraryFixture();
    render(LibraryView, { props: { library } });
    await screen.findByRole("button", { name: "查看 仙逆" });
    await fireEvent.click(screen.getByRole("button", { name: "立即扫描" }));
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(5));
    expect(fetchImpl.mock.calls.map(([url]) => String(url)).slice(2)).toEqual([
      "/api/library/roots/tv/scan",
      "/api/library/summary",
      expect.stringContaining("/api/library/roots/tv/works?"),
    ]);
    expect(screen.getByText("整部剧")).toBeInTheDocument();
  });
});
