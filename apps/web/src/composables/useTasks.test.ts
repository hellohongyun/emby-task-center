import { effectScope } from "vue";
import { describe, expect, it, vi } from "vitest";

import { useTasks } from "./useTasks";

const task = {
  id: 1,
  tmdbId: 70523,
  mediaType: "tv" as const,
  title: "暗黑",
  taskType: "ingest" as const,
  status: "pending" as const,
  statusMessage: null,
  airProgress: 10,
  storedProgress: 8,
  version: 1,
  createdAt: "2026-08-10T08:00:00.000Z",
  updatedAt: "2026-08-10T09:00:00.000Z",
};

function createSubject(fetchImpl: typeof fetch) {
  const scope = effectScope();
  const subject = scope.run(() => useTasks({ fetchImpl, autoLoad: false }))!;
  return { ...subject, stop: () => scope.stop() };
}

describe("useTasks", () => {
  it("opens the login gate when protected tasks return 401", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }));
    const subject = createSubject(fetchImpl as typeof fetch);

    await subject.load();

    expect(subject.authRequired.value).toBe(true);
    expect(subject.authChecking.value).toBe(false);
    expect(subject.tasks.value).toEqual([]);
    subject.stop();
  });

  it("stops polling while unauthenticated, and resumes after a successful load", async () => {
    vi.useFakeTimers();
    try {
      const unauthorized = () => Promise.resolve(new Response('{"error":"unauthorized"}', { status: 401 }));
      const fetchImpl = vi.fn().mockImplementation(unauthorized);
      const subject = createSubject(fetchImpl as typeof fetch);

      subject.startAutoRefresh(1_000);
      await subject.load();
      expect(subject.authRequired.value).toBe(true);
      const callsAfterUnauthorized = fetchImpl.mock.calls.length;

      // 停在登录页时不该继续每 30 秒打 401
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchImpl.mock.calls.length).toBe(callsAfterUnauthorized);

      // 登录成功后轮询恢复（恢复时用默认 30s 间隔）
      fetchImpl.mockImplementation(() => Promise.resolve(Response.json({ tasks: [] })));
      await subject.load();
      expect(subject.authRequired.value).toBe(false);
      const callsAfterLogin = fetchImpl.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetchImpl.mock.calls.length).toBeGreaterThan(callsAfterLogin);
      subject.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps authChecking true until the first session check settles", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ tasks: [] }));
    const subject = createSubject(fetchImpl as typeof fetch);

    expect(subject.authChecking.value).toBe(true);
    await subject.load();

    expect(subject.authChecking.value).toBe(false);
    expect(subject.authRequired.value).toBe(false);
    subject.stop();
  });

  it("enriches API tasks with real TMDB poster URLs", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ tasks: [task] }))
      .mockResolvedValueOnce(Response.json({ result: { posterUrl: "https://image.tmdb.org/t/p/w500/dark.jpg" } }));
    const subject = createSubject(fetchImpl as typeof fetch);

    await subject.load();

    await vi.waitFor(() => expect(subject.tasks.value[0]?.posterUrl).toBe("https://image.tmdb.org/t/p/w500/dark.jpg"));
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "/api/tmdb/tv/70523",
      expect.objectContaining({ credentials: "include" }),
    );
    subject.stop();
  });

  it("does not call TMDB for manual tasks without a tmdbId", async () => {
    const manual = { ...task, id: 99, tmdbId: null, posterUrl: null };
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ tasks: [manual] }));
    const subject = createSubject(fetchImpl as typeof fetch);

    await subject.load();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(subject.tasks.value[0]?.posterUrl).toMatch(/^\/demo-posters\//);
    subject.stop();
  });

  it("opens the login gate when a TMDB detail request returns 401", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ tasks: [task] }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const subject = createSubject(fetchImpl as typeof fetch);

    await subject.load();

    await vi.waitFor(() => expect(subject.authRequired.value).toBe(true));
    expect(subject.tasks.value).toEqual([]);
    subject.stop();
  });

  it("uses local poster fixtures only when the API is unreachable", async () => {
    const subject = createSubject(vi.fn().mockRejectedValue(new TypeError("offline")) as typeof fetch);

    await subject.load();

    expect(subject.demoMode.value).toBe(true);
    expect(subject.tasks.value.length).toBeGreaterThan(0);
    expect(subject.tasks.value.every((item) => item.posterUrl?.startsWith("/demo-posters/"))).toBe(true);
    subject.stop();
  });

  it("preserves a real empty task response instead of substituting demo data", async () => {
    const subject = createSubject(vi.fn().mockResolvedValue(Response.json({ tasks: [] })) as typeof fetch);

    await subject.load();

    expect(subject.demoMode.value).toBe(false);
    expect(subject.tasks.value).toEqual([]);
    subject.stop();
  });

  it.each([
    ["server error", new Response(null, { status: 503 })],
    ["invalid response", Response.json({ unexpected: [] })],
  ])("surfaces a %s without substituting demo data", async (_name, response) => {
    const subject = createSubject(vi.fn().mockResolvedValue(response) as typeof fetch);

    await subject.load();

    expect(subject.demoMode.value).toBe(false);
    expect(subject.tasks.value).toEqual([]);
    expect(subject.error.value).not.toBe("");
    subject.stop();
  });

  it("logs in with the shared password and reloads tasks", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ tasks: [] }));
    const subject = createSubject(fetchImpl as typeof fetch);

    expect(await subject.login("family password", "admin")).toBe(true);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "/api/auth/login",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ username: "admin", password: "family password" }),
      }),
    );
    subject.stop();
  });

  it("records the server lockout when login is throttled", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": "60" } }));
    const subject = createSubject(fetchImpl as typeof fetch);

    expect(await subject.login("family password")).toBe(false);
    expect(subject.lockRemaining.value).toBe(60);
    subject.stop();
  });

  it("loads the remaining server lockout", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ locked: true, retryAfterSeconds: 42 }));
    const subject = createSubject(fetchImpl as typeof fetch);

    await subject.refreshLockStatus();

    expect(subject.lockRemaining.value).toBe(42);
    expect(subject.lockChecking.value).toBe(false);
    subject.stop();
  });

  // 手动建任务已移除：createTask / createTaskBatch / createManualTask / publishScan 四个方法连同
  // 「发布任务」对话框一起删除（任务不再由应用创建）。
});
