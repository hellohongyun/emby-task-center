import { effectScope } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMediaRequestApi } from "./media-request-api";
import { invalidatePortalIdentity, portalAccessError } from "./portal-access";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  portalAccessError.value = "";
});

describe("media request lifetime", () => {
  it("discards a superseded list response even when transport ignores abort", async () => {
    const finishes: Array<(response: Response) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise((done) => finishes.push(done))),
    );
    const scope = effectScope();
    const api = scope.run(() => useMediaRequestApi())!;
    const first = api.run("list", "/api/public/media-requests?page=1");
    const second = api.run("list", "/api/public/media-requests?page=2");
    finishes[1]!(json({ items: [2] }));
    expect(await second).toEqual({ items: [2] });
    finishes[0]!(json({ items: [1] }));
    expect(await first).toBeNull();
    expect(api.error.value).toBe("");
    scope.stop();
  });

  it("does not apply an old identity's late refusal to a new session", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((done) => {
            finish = done;
          }),
      ),
    );
    const scope = effectScope();
    const api = scope.run(() => useMediaRequestApi())!;
    const pending = api.run("list", "/api/public/media-requests");
    invalidatePortalIdentity();
    finish(json({ error: "unauthorized" }, 401));
    expect(await pending).toBeNull();
    expect(api.error.value).toBe("");
    expect(portalAccessError.value).toBe("");
    scope.stop();
  });

  it("ends a write waiting on a stalled body and never automatically retries it", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }));
    vi.stubGlobal("fetch", fetchMock);
    const scope = effectScope();
    const api = scope.run(() => useMediaRequestApi(true))!;
    const pending = api.run("save", "/api/media-requests/1", { method: "PATCH", body: "{}" });
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await pending).toBeNull();
    expect(api.error.value).toContain("提交结果尚未确认");
    expect(api.busy.value.save).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    scope.stop();
  });
});
