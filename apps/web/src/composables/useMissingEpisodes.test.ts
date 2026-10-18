import { effectScope } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useMissingEpisodes } from "./useMissingEpisodes";

const payload = {
  generatedAt: "2026-09-19T08:00:00.000Z",
  lastScanAt: "2026-09-19T07:00:00.000Z",
  scanning: false,
  progress: null,
  mismatchCount: 0,
  mismatches: [],
  showCount: 1,
  episodeCount: 2,
  shows: [
    {
      mediaItemId: 1,
      tmdbId: 202,
      title: "暗黑",
      posterUrl: null,
      airProgress: 3,
      storedProgress: 1,
      missingCount: 2,
      libraries: [],
      unmatchedSeasons: [],
      suspectSeasons: [],
      seasons: [],
    },
  ],
};

function createSubject(fetchImpl: typeof fetch) {
  const scope = effectScope();
  const subject = scope.run(() => useMissingEpisodes({ fetchImpl, autoLoad: false }))!;
  return { ...subject, stop: () => scope.stop() };
}

afterEach(() => vi.unstubAllGlobals());

describe("useMissingEpisodes", () => {
  it("loads the missing-episode payload with the session cookie", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(payload));
    const subject = createSubject(fetchImpl as unknown as typeof fetch);

    await subject.load();

    expect(subject.payload.value).toMatchObject({
      showCount: 1,
      episodeCount: 2,
      lastScanAt: "2026-09-19T07:00:00.000Z",
    });
    expect(subject.error.value).toBe("");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/missing-episodes");
    expect(init).toMatchObject({ credentials: "include" });
    subject.stop();
  });

  it("opens the login gate on 401 and stops polling", async () => {
    vi.useFakeTimers();
    try {
      const requireAuth = vi.fn();
      const fetchImpl = vi.fn().mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }));
      const subject = effectScope().run(() =>
        useMissingEpisodes({ fetchImpl: fetchImpl as unknown as typeof fetch, requireAuth, autoLoad: false }),
      )!;
      subject.startAutoRefresh(1_000);
      await subject.load();

      expect(requireAuth).toHaveBeenCalledTimes(1);
      expect(subject.payload.value).toBeNull();
      const callsAfterUnauthorized = fetchImpl.mock.calls.length;
      // 停在登录页时不再每 60 秒打 401
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchImpl.mock.calls.length).toBe(callsAfterUnauthorized);
      subject.stopAutoRefresh();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a retryable error when the server fails or returns invalid data", async () => {
    const failing = createSubject(
      vi.fn().mockResolvedValue(new Response(null, { status: 500 })) as unknown as typeof fetch,
    );
    await failing.load();
    expect(failing.error.value).toContain("缺集清单暂时不可用");
    failing.stop();

    const invalid = createSubject(vi.fn().mockResolvedValue(Response.json({ shows: null })) as unknown as typeof fetch);
    await invalid.load();
    expect(invalid.error.value).toContain("缺集清单暂时不可用");
    invalid.stop();
  });

  it("deletes selected shows through the API and reloads the list", async () => {
    const deleteResult = {
      deleted: 1,
      failed: 0,
      results: [{ mediaItemId: 1, title: "暗黑", ok: true, embyItemIds: ["series-a"] }],
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json(deleteResult))
      .mockResolvedValueOnce(Response.json({ ...payload, showCount: 0, episodeCount: 0, shows: [] }));
    const subject = createSubject(fetchImpl as unknown as typeof fetch);

    const result = await subject.deleteShows([1], "7");

    expect(result).toMatchObject({ deleted: 1 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/missing-episodes/delete");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ mediaItemIds: [1], rootId: "7" });
    expect(subject.actionMessage.value).toContain("已从 Emby 删除 1 部剧");
    expect(subject.payload.value?.showCount).toBe(0);
    subject.stop();
  });

  it("starts a manual scan and fast-polls until it finishes", async () => {
    vi.useFakeTimers();
    try {
      const scanningPayload = { ...payload, scanning: true, progress: { processed: 1, total: 10 } };
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ started: true, scanning: true }))
        .mockResolvedValueOnce(Response.json(scanningPayload))
        .mockResolvedValue(Response.json({ ...payload, lastScanAt: "2026-09-19T09:00:00.000Z" }));
      const subject = effectScope().run(() =>
        useMissingEpisodes({ fetchImpl: fetchImpl as unknown as typeof fetch, autoLoad: false }),
      )!;

      await subject.triggerScan();
      expect(fetchImpl.mock.calls[0]![0]).toBe("/api/missing-episodes/scan");
      expect(subject.payload.value?.scanning).toBe(true);

      // 快轮询一次：后台已结束 → 回到常规刷新
      await vi.advanceTimersByTimeAsync(5_000);
      expect(subject.payload.value?.scanning).toBe(false);
      expect(subject.payload.value?.lastScanAt).toBe("2026-09-19T09:00:00.000Z");
      subject.stopScanPolling();
    } finally {
      vi.useRealTimers();
    }
  });
});
