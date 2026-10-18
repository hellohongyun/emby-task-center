import { effectScope } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import { useVirtualLibraries } from "./useVirtualLibraries";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const item = (id: string) => ({ itemId: id, name: id, type: "Movie", year: 2026, imageTag: null });
const library = {
  id: "library",
  name: "精选",
  collectionType: "mixed" as const,
  sortOrder: 0,
  itemCount: 0,
  createdAt: "",
  updatedAt: "",
};
function prepareSelection(api: ReturnType<typeof useVirtualLibraries>) {
  api.libraries.value = [library];
  api.selectedId.value = "library";
  api.sourceItems.value = [item("42")];
  api.selectedItems.value = ["42"];
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("isolates source search responses when the old fetch ignores cancellation", async () => {
  let finish!: (response: Response) => void;
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(json({ items: [item("new")], total: 1 }));
  vi.stubGlobal("fetch", fetch);
  const api = useVirtualLibraries(vi.fn());
  const old = api.loadSources();
  api.searchTerm.value = "new";
  await api.loadSources(true);
  finish(json({ items: [item("old")], total: 50 }));
  await old;
  expect(api.sourceItems.value.map((value) => value.itemId)).toEqual(["new"]);
  expect(api.total.value).toBe(1);
  expect(api.sourceLoading.value).toBe(false);
});

it("never applies previous-library content after switching libraries", async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(json({ items: [item("second")] })),
  );
  const api = useVirtualLibraries(vi.fn());
  const first = api.selectLibrary("one");
  await api.selectLibrary("two");
  finish(json({ items: [item("first")] }));
  await first;
  expect(api.items.value.map((value) => value.itemId)).toEqual(["second"]);
});

it("preserves selected items on a failed addition so it can be retried", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "上游暂时不可用" }, 502)));
  const api = useVirtualLibraries(vi.fn());
  prepareSelection(api);
  await api.addItems();
  expect(api.error.value).toBe("上游暂时不可用");
  expect(api.selectedItems.value).toEqual(["42"]);
  expect(api.items.value).toEqual([]);
  expect(api.saving.value).toBe(false);
});

it("expires the session once and cancels other pending reads without reviving old data", async () => {
  let finish!: (response: Response) => void;
  const requireAuth = vi.fn();
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(json({}, 401));
  vi.stubGlobal("fetch", fetch);
  const api = useVirtualLibraries(requireAuth);
  const pending = api.loadSources();
  await api.loadProxy();
  finish(json({ items: [item("stale")], total: 1 }));
  await pending;
  await api.load();
  expect(requireAuth).toHaveBeenCalledOnce();
  expect(api.sourceItems.value).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(api.sourceLoading.value).toBe(false);
});

it("disposes pending mutations without a follow-up read or list update", async () => {
  let finish!: (response: Response) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const scope = effectScope();
  const api = scope.run(() => useVirtualLibraries(vi.fn()))!;
  prepareSelection(api);
  const pending = api.addItems();
  scope.stop();
  finish(json({ items: [item("42")] }));
  await pending;
  expect(api.items.value).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(api.saving.value).toBe(false);
});

it("times out a stalled response body", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) })),
  );
  const api = useVirtualLibraries(vi.fn());
  const pending = api.load();
  await vi.advanceTimersByTimeAsync(15_000);
  await pending;
  expect(api.loading.value).toBe(false);
  expect(api.error.value).toContain("超时");
});

it("shows the backend explanation for proxy configuration failures", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      json(
        {
          error: "proxy_configuration_failed",
          message: "端口 8097 已被占用，请更换端口",
        },
        409,
      ),
    ),
  );
  const api = useVirtualLibraries(vi.fn());
  await api.saveProxy({ enabled: true, upstream: "http://tgtd.local:8096", port: 8097 });
  expect(api.error.value).toBe("端口 8097 已被占用，请更换端口");
  expect(api.proxySaving.value).toBe(false);
});

it("blocks incompatible toggles and stale selections before sending a mutation", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const api = useVirtualLibraries(vi.fn());
  prepareSelection(api);
  api.selectedItems.value = [];
  api.libraries.value = [{ ...library, collectionType: "tvshows" }];
  api.toggleItem("42");
  expect(api.selectedItems.value).toEqual([]);
  expect(api.error.value).toContain("不兼容");
  api.selectedItems.value = ["42"];
  await api.addItems();
  expect(fetch).not.toHaveBeenCalled();
  expect(api.error.value).toContain("混合库");
  api.sourceItems.value = [];
  await api.addItems();
  expect(fetch).not.toHaveBeenCalled();
  expect(api.error.value).toContain("重新选择");
});

it("checks existing mappings before changing type but allows correcting to mixed", async () => {
  const fetch = vi.fn(async (url: string) => json(url.endsWith("/items") ? { items: [item("42")] } : { library }));
  vi.stubGlobal("fetch", fetch);
  const api = useVirtualLibraries(vi.fn());
  prepareSelection(api);
  api.items.value = [item("42")];
  expect(await api.saveLibrary({ name: "精选", collectionType: "tvshows", sortOrder: 0 }, "library")).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  expect(api.error.value).toContain("42");
  api.libraries.value = [{ ...library, collectionType: "tvshows" }];
  await api.saveLibrary({ name: "精选", collectionType: "mixed", sortOrder: 0 }, "library");
  expect(fetch).toHaveBeenCalledWith("/api/virtual-libraries/library", expect.objectContaining({ method: "PATCH" }));
});

it.each(["Season", "Episode", "Person"])(
  "prevents selecting or submitting a %s from a stale source response",
  async (type) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const api = useVirtualLibraries(vi.fn());
    prepareSelection(api);
    api.sourceItems.value = [{ ...item("42"), type }];
    api.selectedItems.value = [];
    api.toggleItem("42");
    expect(api.selectedItems.value).toEqual([]);
    expect(api.error.value).toContain("请选择电影或整部剧");
    api.selectedItems.value = ["42"];
    await api.addItems();
    expect(fetch).not.toHaveBeenCalled();
  },
);
