import { effectScope, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { virtualLibraryRequests } from "./virtual-library-requests";

const upload = { method: "PUT", body: new Blob(["poster"], { type: "image/webp" }) };
const uploadOptions = { timeoutMs: 120_000 };
const json = () => Response.json({ library: { id: "library" } });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("virtual library upload deadlines", () => {
  it.each(["/api/virtual-libraries", "/api/public/virtual-libraries"])(
    "allows a slow upload after the ordinary deadline at %s",
    async (base) => {
      vi.useFakeTimers();
      let complete!: (response: Response) => void;
      const fetch = vi.fn((_url, _init) => new Promise<Response>((resolve) => (complete = resolve)));
      vi.stubGlobal("fetch", fetch);
      const api = virtualLibraryRequests(vi.fn(), base);
      const busy = ref(false);
      const pending = api.run("poster", busy, "/library/poster", upload, uploadOptions);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(busy.value).toBe(true);
      expect(fetch.mock.calls[0]![1].signal.aborted).toBe(false);
      complete(json());
      expect(await pending).toEqual({ library: { id: "library" } });
      expect(busy.value).toBe(false);
      expect(api.error.value).toBe("");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("aborts at 120 seconds, keeps retry possible, and ignores a late upload response", async () => {
    vi.useFakeTimers();
    let complete!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    const fetch = vi
      .fn()
      .mockImplementationOnce((_url, init) => {
        signal = init.signal;
        return new Promise<Response>((resolve) => (complete = resolve));
      })
      .mockResolvedValueOnce(json());
    vi.stubGlobal("fetch", fetch);
    const api = virtualLibraryRequests(vi.fn());
    const busy = ref(false);
    const pending = api.run("poster", busy, "/library/poster", upload, uploadOptions);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(busy.value).toBe(true);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(busy.value).toBe(false);
    expect(api.error.value).toBe("请求超时，请重试");
    expect(await api.run("poster", busy, "/library/poster", upload, uploadOptions)).toEqual({
      library: { id: "library" },
    });
    complete(json());
    await vi.advanceTimersByTimeAsync(0);
    expect(api.error.value).toBe("");
    expect(busy.value).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([{}, { method: "DELETE" }])("keeps ordinary requests and removal at 15 seconds: %j", async (init) => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined)),
    );
    const api = virtualLibraryRequests(vi.fn());
    const busy = ref(false);
    const pending = api.run("normal", busy, "/library/poster", init);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(busy.value).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeNull();
    expect(api.error.value).toBe("请求超时，请重试");
    expect(busy.value).toBe(false);
  });

  it("aborts a pending upload on disposal and releases busy state without an error", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, init) => {
        signal = init.signal;
        return new Promise(() => undefined);
      }),
    );
    const scope = effectScope();
    const api = scope.run(() => virtualLibraryRequests(vi.fn()))!;
    const busy = ref(false);
    const pending = api.run("poster", busy, "/library/poster", upload, uploadOptions);
    scope.stop();
    expect(await pending).toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(busy.value).toBe(false);
    expect(api.error.value).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });
});
