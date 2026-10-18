import { effectScope } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import { useMemberUsage } from "./useMemberUsage";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const response = (value: unknown) => new Response(JSON.stringify(value));
it("keeps the latest range when older responses arrive later", async () => {
  let finish!: (r: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((r) => {
            finish = r;
          }),
      )
      .mockResolvedValueOnce(response({ days: 30 })),
  );
  const usage = useMemberUsage();
  const old = usage.load(7);
  await usage.load(30);
  finish(response({ days: 7 }));
  await old;
  expect(usage.overview.value).toEqual({ days: 30 });
  expect(usage.loading.value).toBe(false);
});
it("keeps the latest member and closes pending details permanently", async () => {
  const resolvers: Array<(r: Response) => void> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>((r) => resolvers.push(r))),
  );
  const usage = useMemberUsage();
  const a = usage.loadDetail("A", 7);
  const b = usage.loadDetail("B", 7);
  resolvers[1]!(response({ member: { email: "B" } }));
  await b;
  resolvers[0]!(response({ member: { email: "A" } }));
  await a;
  expect(usage.detail.value?.member.email).toBe("B");
  const c = usage.loadDetail("C", 7);
  usage.closeDetail();
  expect(usage.detailLoading.value).toBe(false);
  resolvers[2]!(response({ member: { email: "C" } }));
  await c;
  expect(usage.detail.value).toBeNull();
});
it("times out body consumption and resets loading", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) })),
  );
  const usage = useMemberUsage();
  const pending = usage.load(7);
  await vi.advanceTimersByTimeAsync(15_000);
  await pending;
  expect(usage.loading.value).toBe(false);
  expect(usage.error.value).toBeTruthy();
});
it("cancels refresh on disposal without starting followup reads", async () => {
  let finish!: (r: Response) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((r) => {
        finish = r;
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const scope = effectScope();
  const usage = scope.run(() => useMemberUsage())!;
  const pending = usage.refreshNow(7);
  scope.stop();
  finish(response({ ok: true }));
  await pending;
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(usage.refreshing.value).toBe(false);
});
