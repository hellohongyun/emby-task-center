import { fireEvent, render, screen, waitFor, within } from "@testing-library/vue";
import { afterEach, expect, it, vi } from "vitest";
import VirtualLibrariesPage from "./VirtualLibrariesPage.vue";
import PublicVirtualLibraries from "../components/PublicVirtualLibraries.vue";
import { resetPortalSession } from "../composables/usePortalSession";

const base = "/api/public/virtual-libraries";
const library = {
  id: "private-one",
  name: "我的精选",
  collectionType: "mixed",
  sortOrder: 0,
  itemCount: 0,
  createdAt: "",
  updatedAt: "",
  posterImageTag: "cover",
};
const movie = { itemId: "42", name: "小众电影", type: "Movie", year: 2026, imageTag: "image" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => {
  resetPortalSession();
  vi.unstubAllGlobals();
});

function setup() {
  let value = { ...library };
  let added = false;
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === `${base}/source-libraries`) return json({ items: [{ id: "source", name: "电影" }] });
    if (url.startsWith(`${base}/source-items?`)) return json({ items: [movie], total: 1 });
    if (url.endsWith("/items") && options?.method === "POST") added = true;
    if (url.endsWith("/items/42") && options?.method === "DELETE") {
      added = false;
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/items")) return json({ items: added ? [movie] : [] });
    if (url === `${base}/${value.id}` && options?.method === "PATCH") {
      value = { ...value, ...JSON.parse(String(options.body)) };
      return json({ library: value });
    }
    if (url === `${base}/${value.id}/poster` && options?.method === "DELETE") {
      value.posterImageTag = "";
      return json({ library: value });
    }
    if (url === base) return json({ libraries: [value] });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  render(VirtualLibrariesPage, { props: { personal: true, requireAuth: vi.fn() } });
  return fetcher;
}

it("uses only member endpoints and preserves personal controls without global proxy settings", async () => {
  const fetcher = setup();
  expect(await screen.findByRole("heading", { name: "我的私人媒体库" })).toBeInTheDocument();
  expect(await screen.findByRole("heading", { name: "我的精选" })).toBeInTheDocument();
  expect(screen.getByText(/私人库排在公共库之前/)).toBeInTheDocument();
  expect(screen.queryByText("反代设置")).not.toBeInTheDocument();
  expect(screen.getByAltText("我的精选媒体库海报")).toHaveAttribute("src", `${base}/private-one/poster?tag=cover`);
  await fireEvent.click(await screen.findByRole("checkbox", { name: "选择 小众电影" }));
  await fireEvent.click(screen.getByRole("button", { name: "加入已选（1）" }));
  const content = screen.getByRole("region", { name: "已加入的内容" });
  expect(await within(content).findByText("小众电影")).toBeInTheDocument();
  expect(within(content).getByAltText("小众电影 海报")).toHaveAttribute("src", "/api/public/emby-poster?id=42");
  await fireEvent.click(screen.getByRole("button", { name: "编辑媒体库" }));
  await fireEvent.update(screen.getByLabelText("媒体库名称"), "私人科幻");
  await fireEvent.update(screen.getByLabelText("排序"), "-10");
  await fireEvent.click(screen.getByRole("button", { name: "保存媒体库" }));
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      `${base}/private-one`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ name: "私人科幻", collectionType: "mixed", sortOrder: -10 }),
      }),
    ),
  );
  await fireEvent.click(screen.getByRole("button", { name: "移除自定义海报" }));
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(`${base}/private-one/poster`, expect.objectContaining({ method: "DELETE" })),
  );
  expect(fetcher.mock.calls.every(([url]) => url.startsWith(base))).toBe(true);
});

it("asks members without an Emby binding to contact the administrator without loading libraries", async () => {
  const fetcher = vi.fn(async () => json({ embyUserId: null, embyUsername: null }));
  vi.stubGlobal("fetch", fetcher);
  render(PublicVirtualLibraries);
  expect(await screen.findByText(/请联系管理员绑定 Emby 账号/)).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]).toEqual(expect.arrayContaining(["/api/public/subscriptions/member/emby"]));
});

it("invalidates a portal session when personal requests are refused", async () => {
  const requireAuth = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ error: "unauthorized" }, 401)),
  );
  render(VirtualLibrariesPage, { props: { personal: true, requireAuth } });
  await waitFor(() => expect(requireAuth).toHaveBeenCalled());
});
