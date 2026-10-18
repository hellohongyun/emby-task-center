import { fireEvent, render, screen, waitFor, within } from "@testing-library/vue";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import LogsView from "./LogsView.vue";
import type { LogEntry } from "../types";

const logs: LogEntry[] = [
  {
    id: 2,
    level: "error",
    source: "web",
    message: "POST /api/tasks/1/retry 请求失败",
    method: "POST",
    path: "/api/tasks/1/retry",
    status: null,
    durationMs: 12,
    detail: "TypeError: offline",
    createdAt: "2026-08-12T08:00:00.000Z",
  },
  {
    id: 1,
    level: "info",
    source: "server",
    message: "GET /api/system/status 200",
    method: "GET",
    path: "/api/system/status",
    status: 200,
    durationMs: 3,
    detail: null,
    createdAt: "2026-08-12T07:00:00.000Z",
  },
];

afterEach(() => vi.unstubAllGlobals());

function renderView(autoRefreshMs = 0) {
  const fetchImpl = vi.fn().mockResolvedValue(Response.json({ logs }));
  vi.stubGlobal("fetch", fetchImpl);
  render(LogsView, { props: { requireAuth: vi.fn(), autoRefreshMs } });
  return fetchImpl;
}

describe("LogsView", () => {
  it("renders log entries with level, source, request, status and duration", async () => {
    renderView();

    expect(await screen.findByText("POST /api/tasks/1/retry 请求失败")).toBeInTheDocument();
    const list = screen.getByRole("list");
    expect(within(list).getByText("错误")).toBeInTheDocument();
    expect(within(list).getByText("信息")).toBeInTheDocument();
    expect(within(list).getByText("前端")).toBeInTheDocument();
    expect(within(list).getByText("服务端")).toBeInTheDocument();
    expect(screen.getByText("GET /api/system/status")).toBeInTheDocument();
    expect(screen.getByText("GET /api/system/status 200")).toBeInTheDocument();
    expect(screen.getByText("200")).toBeInTheDocument();
    expect(screen.getByText("3ms")).toBeInTheDocument();
  });

  it("re-requests with the level filter applied", async () => {
    const fetchImpl = renderView();
    await screen.findByText("POST /api/tasks/1/retry 请求失败");

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "级别" }), "error");

    await waitFor(() => {
      expect(fetchImpl).toHaveBeenLastCalledWith(expect.stringContaining("level=error"), expect.anything());
    });
  });

  it("re-requests with the source filter applied", async () => {
    const fetchImpl = renderView();
    await screen.findByText("POST /api/tasks/1/retry 请求失败");

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "来源" }), "web");

    await waitFor(() => {
      expect(fetchImpl).toHaveBeenLastCalledWith(expect.stringContaining("source=web"), expect.anything());
    });
  });

  it("re-requests with the keyword search", async () => {
    const fetchImpl = renderView();
    await screen.findByText("POST /api/tasks/1/retry 请求失败");

    await fireEvent.update(screen.getByLabelText("关键字"), "retry");

    await waitFor(() => {
      expect(fetchImpl).toHaveBeenLastCalledWith(expect.stringContaining("q=retry"), expect.anything());
    });
  });

  it("refreshes on demand via the refresh button", async () => {
    const fetchImpl = renderView();
    await screen.findByText("POST /api/tasks/1/retry 请求失败");
    const callsBefore = fetchImpl.mock.calls.length;

    await fireEvent.click(screen.getByRole("button", { name: "刷新" }));

    await waitFor(() => expect(fetchImpl.mock.calls.length).toBe(callsBefore + 1));
  });

  it("shows an empty state when the server returns no logs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ logs: [] })));
    render(LogsView, { props: { requireAuth: vi.fn(), autoRefreshMs: 0 } });

    await waitFor(() => expect(screen.getByText("暂无日志")).toBeInTheDocument());
  });

  it("shows an error state with a retry button and recovers", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(Response.json({ logs }));
    vi.stubGlobal("fetch", fetchImpl);
    render(LogsView, { props: { requireAuth: vi.fn(), autoRefreshMs: 0 } });

    expect(await screen.findByText("无法读取日志，请稍后重试。")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByText("POST /api/tasks/1/retry 请求失败")).toBeInTheDocument();
  });

  it("expands and collapses the detail area", async () => {
    renderView();
    await screen.findByText("POST /api/tasks/1/retry 请求失败");

    await fireEvent.click(screen.getByRole("button", { name: "查看详情" }));
    expect(screen.getByText("TypeError: offline")).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "收起详情" }));
    expect(screen.queryByText("TypeError: offline")).not.toBeInTheDocument();
  });

  it("loads the next page with the before cursor", async () => {
    const page: LogEntry[] = Array.from({ length: 100 }, (_, i) => ({
      id: 200 - i,
      level: "info",
      source: "server",
      message: `GET /api/page/${200 - i} 200`,
      method: "GET",
      path: `/api/page/${200 - i}`,
      status: 200,
      durationMs: 1,
      detail: null,
      createdAt: "2026-08-12T08:00:00.000Z",
    }));
    const nextPage: LogEntry[] = Array.from({ length: 5 }, (_, i) => ({
      id: 100 - i,
      level: "info",
      source: "server",
      message: `GET /api/page/${100 - i} 200`,
      method: "GET",
      path: `/api/page/${100 - i}`,
      status: 200,
      durationMs: 1,
      detail: null,
      createdAt: "2026-08-11T08:00:00.000Z",
    }));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ logs: page }))
      .mockResolvedValueOnce(Response.json({ logs: nextPage }));
    vi.stubGlobal("fetch", fetchImpl);
    render(LogsView, { props: { requireAuth: vi.fn(), autoRefreshMs: 0 } });

    expect(await screen.findByText("GET /api/page/101")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "加载更多" }));

    expect(await screen.findByText("GET /api/page/100")).toBeInTheDocument();
    expect(fetchImpl).toHaveBeenLastCalledWith(expect.stringContaining("before=101"), expect.anything());
  });

  it("auto-refreshes periodically when polling is enabled", async () => {
    const fetchImpl = renderView(100);
    await screen.findByText("POST /api/tasks/1/retry 请求失败");

    await waitFor(() => expect(fetchImpl.mock.calls.length).toBeGreaterThan(1));
  });
});
