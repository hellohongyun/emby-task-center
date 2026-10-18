import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmbyClient, EmbySession } from "./emby-client";
import { createEmbyClient } from "./emby-client";
import { clearSessionStreamCache, enrichSessionStreams } from "./emby-session-streams";

const sessions = (count = 1): EmbySession[] =>
  Array.from({ length: count }, (_, i) => ({
    Id: `session${i}`,
    NowPlayingItem: { Id: `item${i}`, Name: "Movie" },
  }));
const streams = (container: string) => ({ container, mediaStreams: [{ Type: "Video" }] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Emby session stream enrichment", () => {
  afterEach(() => {
    clearSessionStreamCache();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("bounds overlapping reads to four external requests and merges identical items", async () => {
    vi.useFakeTimers();
    let active = 0;
    let max = 0;
    const fetch = vi.fn(async () => {
      active += 1;
      max = Math.max(max, active);
      await new Promise((done) => setTimeout(done, 30));
      active -= 1;
      return streams("MKV");
    });
    const client = { itemMediaStreams: fetch } as unknown as EmbyClient;
    const first = sessions(9);
    const second = sessions(9);
    const work = Promise.all([enrichSessionStreams(client, first), enrichSessionStreams(client, second)]);
    expect(fetch).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(90);
    await work;
    expect(fetch).toHaveBeenCalledTimes(9);
    expect(max).toBe(4);
    expect([...first, ...second].every((session) => session.NowPlayingItem?.Container === "MKV")).toBe(true);
  });

  it("isolates two clients with the same item ID, including late completions", async () => {
    const old = deferred<ReturnType<typeof streams>>();
    const a = { itemMediaStreams: vi.fn(() => old.promise) } as unknown as EmbyClient;
    const b = { itemMediaStreams: vi.fn(async () => streams("B")) } as unknown as EmbyClient;
    const first = sessions();
    const aWork = enrichSessionStreams(a, first);
    const second = sessions();
    await enrichSessionStreams(b, second);
    old.resolve(streams("A"));
    await aWork;
    const third = sessions();
    await enrichSessionStreams(b, third);
    expect(first[0]!.NowPlayingItem!.Container).toBe("A");
    expect(second[0]!.NowPlayingItem!.Container).toBe("B");
    expect(third[0]!.NowPlayingItem!.Container).toBe("B");
    expect(b.itemMediaStreams).toHaveBeenCalledTimes(1);
  });

  it("invalidates a client cache when live URL or API key changes", async () => {
    let baseUrl = "https://a.test";
    let apiKey = "a";
    const fetch = vi.fn(
      async (_url, init) =>
        new Response(
          JSON.stringify({
            Items: [
              {
                Container: init.headers["X-Emby-Token"],
                MediaStreams: [{ Type: "Video" }],
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const client = createEmbyClient({ resolve: () => ({ baseUrl, apiKey }) });
    await enrichSessionStreams(client, sessions());
    apiKey = "b";
    const second = sessions();
    await enrichSessionStreams(client, second);
    baseUrl = "https://b.test";
    await enrichSessionStreams(client, sessions());
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(second[0]!.NowPlayingItem!.Container).toBe("b");
  });

  it("discards late old-connection results and skips queued old-connection requests", async () => {
    let generation = {};
    const old = deferred<ReturnType<typeof streams>>();
    const fetch = vi.fn(() => old.promise);
    const client = {
      get mediaStreamsCacheIdentity() {
        return generation;
      },
      itemMediaStreams: fetch,
    } as unknown as EmbyClient;
    const first = sessions(5);
    const work = enrichSessionStreams(client, first);
    expect(fetch).toHaveBeenCalledTimes(4);
    generation = {};
    fetch.mockImplementation(async () => streams("NEW"));
    const second = sessions();
    await enrichSessionStreams(client, second);
    old.resolve(streams("OLD"));
    await work;
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(first.every((session) => session.NowPlayingItem?.Container == null)).toBe(true);
    expect(second[0]!.NowPlayingItem!.Container).toBe("NEW");
  });

  it("keeps other details after one failure and retries the failed item after thirty seconds", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (id: string) => {
      if (id === "item0") throw new Error("timeout");
      return streams("OK");
    });
    const client = { itemMediaStreams: fetch } as unknown as EmbyClient;
    const first = sessions(2);
    await enrichSessionStreams(client, first);
    expect(first[1]!.NowPlayingItem!.Container).toBe("OK");
    await enrichSessionStreams(client, sessions(2));
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    fetch.mockResolvedValue(streams("RETRY"));
    const next = sessions(2);
    await enrichSessionStreams(client, next);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(next[0]!.NowPlayingItem!.Container).toBe("RETRY");
  });

  it("returns basic sessions after the total wait budget and caches late detail without duplicate reads", async () => {
    vi.useFakeTimers();
    const slow = deferred<ReturnType<typeof streams>>();
    const fetch = vi.fn((id: string) => (id === "item0" ? slow.promise : Promise.resolve(streams("FAST"))));
    const client = { itemMediaStreams: fetch } as unknown as EmbyClient;
    const first = sessions(2);
    let completed = false;
    const initial = enrichSessionStreams(client, first).then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(completed).toBe(false);
    expect(first[1]!.NowPlayingItem!.Container).toBe("FAST");
    await vi.advanceTimersByTimeAsync(1);
    await initial;
    expect(completed).toBe(true);
    expect(first[0]!.NowPlayingItem!.Container).toBeUndefined();
    const second = sessions(2);
    const repeat = enrichSessionStreams(client, second);
    await vi.advanceTimersByTimeAsync(2_000);
    await repeat;
    expect(fetch).toHaveBeenCalledTimes(2);
    slow.resolve(streams("LATE"));
    await vi.advanceTimersByTimeAsync(0);
    const third = sessions(2);
    await enrichSessionStreams(client, third);
    expect(third[0]!.NowPlayingItem!.Container).toBe("LATE");
    expect(third[1]!.NowPlayingItem!.Container).toBe("FAST");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
