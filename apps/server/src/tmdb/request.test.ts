import { afterEach, describe, expect, it, vi } from "vitest";
import { createTmdbRequest } from "./request";

afterEach(() => vi.useRealTimers());
describe("TMDB request deadline", () => {
  it("rejects and aborts a hung transport even if it ignores cancellation", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      signal = init?.signal;
      return new Promise(() => undefined);
    });
    const request = createTmdbRequest({ token: "fake", fetchImpl, timeoutMs: 100 });
    const pending = request("/tv/1");
    const rejected = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(signal?.aborted).toBe(true);
  });

  it("keeps the deadline while reading JSON and releases the response", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(async () => undefined);
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          body: { cancel },
          json: () => new Promise(() => undefined),
        }) as unknown as Response,
    );
    const request = createTmdbRequest({ token: "fake", fetchImpl, timeoutMs: 100 });
    const rejected = expect(request("/tv/1")).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(cancel).toHaveBeenCalled();
  });

  it("releases error responses and accepts a later successful request", async () => {
    const cancel = vi.fn(async () => undefined);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: false,
        body: { cancel },
      } as unknown as Response)
      .mockResolvedValueOnce(Response.json({ id: 1 }));
    const request = createTmdbRequest({ token: "fake", fetchImpl });
    await expect(request("/tv/1")).rejects.toThrow("request failed");
    expect(cancel).toHaveBeenCalled();
    await expect(request("/tv/1")).resolves.toEqual({ id: 1 });
  });
});
