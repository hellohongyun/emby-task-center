import { describe, expect, it, vi } from "vitest";
import { fetchSectionsWithDeadline } from "./refresh";

describe("source refresh preserves individual request cancellation", () => {
  it("passes an earlier request abort through and skips calls using an already aborted signal", async () => {
    const request = new AbortController();
    let combinedSignal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      combinedSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        combinedSignal!.addEventListener("abort", () => reject(combinedSignal!.reason), { once: true });
      });
    });
    const refresh = fetchSectionsWithDeadline(
      {
        source: "tmdb",
        fetchSections: async (context) => {
          await expect(context.fetchImpl("https://example.test/first", { signal: request.signal })).rejects.toThrow(
            "individual deadline",
          );
          await expect(context.fetchImpl("https://example.test/second", { signal: request.signal })).rejects.toThrow(
            "individual deadline",
          );
          return [];
        },
      },
      { tmdbToken: "test", fetchImpl },
      60_000,
    );
    request.abort(new Error("individual deadline"));
    await refresh;
    expect(combinedSignal).not.toBe(request.signal);
    expect(combinedSignal!.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch later pages after the total deadline even if the first fetch ignores abort", async () => {
    vi.useFakeTimers();
    let release!: (response: Response) => void;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    let finished!: () => void;
    const adapterFinished = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const refresh = fetchSectionsWithDeadline(
      {
        source: "tmdb",
        fetchSections: async (context) => {
          await context.fetchImpl("https://example.test/first");
          await expect(context.fetchImpl("https://example.test/second")).rejects.toMatchObject({ name: "AbortError" });
          finished();
          return [];
        },
      },
      { tmdbToken: "test", fetchImpl },
      100,
    );
    try {
      const assertion = expect(refresh).rejects.toThrow("trending_refresh_timeout");
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
      release(new Response("late"));
      await adapterFinished;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
