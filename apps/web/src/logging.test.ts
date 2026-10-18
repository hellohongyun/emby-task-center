import { afterEach, describe, expect, it, vi } from "vitest";

import { installFetchLogging, resetLogging } from "./logging";

type FetchMock = ReturnType<typeof vi.fn>;

function installWith(mock: FetchMock) {
  vi.stubGlobal("fetch", mock as unknown as typeof fetch);
  installFetchLogging();
  return mock;
}

function logsCalls(mock: FetchMock) {
  return mock.mock.calls.filter((call) => call[0] === "/api/logs") as Array<[string, RequestInit]>;
}

function lastLogsPayload(mock: FetchMock) {
  const calls = logsCalls(mock);
  const init = calls[calls.length - 1]![1];
  return JSON.parse(init.body as string) as { logs: Array<Record<string, unknown>> };
}

afterEach(() => {
  resetLogging();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("installFetchLogging", () => {
  it("backs off on temporary server errors and resumes after recovery", async () => {
    vi.useFakeTimers();
    let unavailable = true;
    const fetchImpl = installWith(
      vi.fn(async (url) => {
        return Response.json({}, { status: url === "/api/logs" && unavailable ? 503 : 200 });
      }),
    );
    for (let i = 0; i < 10; i++) await window.fetch(`/api/tasks/${i}`);
    await vi.advanceTimersByTimeAsync(0);
    expect(logsCalls(fetchImpl)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(logsCalls(fetchImpl)).toHaveLength(1);
    unavailable = false;
    await vi.advanceTimersByTimeAsync(1);
    expect(logsCalls(fetchImpl)).toHaveLength(2);
    expect(lastLogsPayload(fetchImpl).logs).toHaveLength(10);
  });
  it("backs off after a failed batch instead of recursively retrying ten logs", async () => {
    vi.useFakeTimers();
    const fetchImpl = installWith(
      vi.fn(async (url) => {
        if (url === "/api/logs") throw new TypeError("offline");
        return Response.json({ ok: true });
      }),
    );
    for (let i = 0; i < 10; i++) await window.fetch(`/api/tasks/${i}`);
    await vi.advanceTimersByTimeAsync(0);
    expect(logsCalls(fetchImpl)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(logsCalls(fetchImpl)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(logsCalls(fetchImpl)).toHaveLength(2);
    await window.fetch("/api/tasks/new");
    await vi.advanceTimersByTimeAsync(9999);
    expect(logsCalls(fetchImpl)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(logsCalls(fetchImpl)).toHaveLength(3);
  });

  it("bounds the offline backlog and drains it in small batches after recovery", async () => {
    vi.useFakeTimers();
    let offline = true;
    const fetchImpl = installWith(
      vi.fn(async (url) => {
        if (url === "/api/logs" && offline) throw new TypeError("offline");
        return Response.json({ ok: true });
      }),
    );
    for (let i = 0; i < 10; i++) await window.fetch(`/api/tasks/${i}`);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 10; i < 310; i++) await window.fetch(`/api/tasks/${i}`);
    expect(logsCalls(fetchImpl)).toHaveLength(1);
    offline = false;
    await vi.advanceTimersByTimeAsync(5000);
    const recovered = logsCalls(fetchImpl)
      .slice(1)
      .map(([, init]) => JSON.parse(init.body as string).logs);
    expect(recovered.flat()).toHaveLength(200);
    expect(recovered.every((logs) => logs.length <= 10)).toBe(true);
    const sent = recovered.flat();
    expect(sent[sent.length - 1]?.path).toBe("/api/tasks/309");
  });

  it("queues a successful request as an info log and flushes it to POST /api/logs", async () => {
    vi.useFakeTimers();
    const fetchImpl = installWith(vi.fn().mockResolvedValue(Response.json({ tasks: [] })));

    await window.fetch("/api/tasks", { credentials: "include" });
    await vi.advanceTimersByTimeAsync(5000);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "/api/logs",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    const payload = lastLogsPayload(fetchImpl);
    expect(payload.logs).toEqual([
      expect.objectContaining({
        level: "info",
        source: "web",
        message: "GET /api/tasks",
        method: "GET",
        path: "/api/tasks",
        status: 200,
      }),
    ]);
    expect(payload.logs[0]).not.toHaveProperty("detail");
  });

  it("queues HTTP error responses with error level and status", async () => {
    vi.useFakeTimers();
    const fetchImpl = installWith(vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    await window.fetch("/api/tasks");
    await vi.advanceTimersByTimeAsync(5000);

    const payload = lastLogsPayload(fetchImpl);
    expect(payload.logs).toEqual([expect.objectContaining({ level: "error", status: 503, message: "GET /api/tasks" })]);
  });

  it("queues network failures with error level and a TypeError detail", async () => {
    vi.useFakeTimers();
    const fetchImpl = installWith(vi.fn().mockRejectedValue(new TypeError("offline")));

    await expect(window.fetch("/api/tasks")).rejects.toThrow("offline");
    await vi.advanceTimersByTimeAsync(5000);

    const payload = lastLogsPayload(fetchImpl);
    expect(payload.logs).toEqual([
      expect.objectContaining({
        level: "error",
        source: "web",
        message: "GET /api/tasks 请求失败",
        method: "GET",
        path: "/api/tasks",
        detail: "TypeError: offline",
      }),
    ]);
  });

  it("skips logging its own /api/logs requests", async () => {
    vi.useFakeTimers();
    const fetchImpl = installWith(vi.fn().mockResolvedValue(Response.json({ logs: [] })));

    await window.fetch("/api/logs?level=error");
    await vi.advanceTimersByTimeAsync(5000);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith("/api/logs?level=error", undefined);
  });

  it("flushes immediately once 10 entries are queued", async () => {
    const fetchImpl = installWith(vi.fn().mockResolvedValue(Response.json({ accepted: 10 })));

    for (let i = 0; i < 10; i++) {
      await window.fetch(`/api/tasks/${i}`);
    }
    await vi.waitFor(() => expect(logsCalls(fetchImpl)).toHaveLength(1));

    const payload = lastLogsPayload(fetchImpl);
    expect(payload.logs).toHaveLength(10);
    expect(payload.logs[0]).toEqual(expect.objectContaining({ path: "/api/tasks/0" }));
    expect(payload.logs[9]).toEqual(expect.objectContaining({ path: "/api/tasks/9" }));
  });

  it("keeps 401 responses flowing without throwing and still queues them", async () => {
    vi.useFakeTimers();
    const fetchImpl = installWith(vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

    const response = await window.fetch("/api/tasks");
    expect(response.status).toBe(401);
    await vi.advanceTimersByTimeAsync(5000);

    const payload = lastLogsPayload(fetchImpl);
    expect(payload.logs).toEqual([expect.objectContaining({ level: "error", status: 401, path: "/api/tasks" })]);
  });

  it("flushes remaining entries with keepalive on pagehide", async () => {
    const fetchImpl = installWith(vi.fn().mockResolvedValue(Response.json({ accepted: 1 })));

    await window.fetch("/api/tasks");
    window.dispatchEvent(new Event("pagehide"));

    const calls = logsCalls(fetchImpl);
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toMatchObject({ keepalive: true, method: "POST" });
  });
});
