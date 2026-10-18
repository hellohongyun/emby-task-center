import { effectScope } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import { useTrending } from "./useTrending";

const section = (title: string) => ({
  key: "tmdb_hot",
  source: "tmdb",
  label: "热门",
  stale: true,
  updatedAt: 123,
  items: [{ id: "tmdb:1", title }],
});
const response = (sections: unknown[], refreshing: boolean) =>
  new Response(
    JSON.stringify({
      sections,
      refreshing,
      updatedAt: 123,
      degradedSources: [],
    }),
    { headers: { "content-type": "application/json" } },
  );
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("shows snapshots immediately and polls only while the server is refreshing", async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response([section("旧榜单")], true))
    .mockResolvedValueOnce(response([section("新榜单")], false));
  vi.stubGlobal("fetch", fetch);
  const scope = effectScope();
  const trending = scope.run(() => useTrending())!;
  await trending.load();
  expect(trending.sections.value[0]?.items[0]?.title).toBe("旧榜单");
  expect(trending.loading.value).toBe(false);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(trending.sections.value[0]?.items[0]?.title).toBe("新榜单");
  await vi.advanceTimersByTimeAsync(20_000);
  expect(fetch).toHaveBeenCalledTimes(2);
  scope.stop();
});

it("keeps the displayed snapshot when a background poll fails", async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response([section("旧榜单")], true))
    .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
  vi.stubGlobal("fetch", fetch);
  const trending = useTrending();
  await trending.load();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(trending.sections.value[0]?.items[0]?.title).toBe("旧榜单");
  expect(trending.error.value).toBe("");
  expect(trending.refreshing.value).toBe(false);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(fetch).toHaveBeenCalledTimes(2);
  trending.stop();
});

it("cancels a pending request when the owning view is disposed", async () => {
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: unknown, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise<Response>(() => {});
    }),
  );
  const scope = effectScope();
  const trending = scope.run(() => useTrending())!;
  const pending = trending.load();
  scope.stop();
  await pending;
  expect(signal?.aborted).toBe(true);
  expect(trending.loading.value).toBe(false);
  expect(trending.error.value).toBe("");
});
