import { fireEvent, render, screen, waitFor } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import ConcurrencyPolicyPanel from "./ConcurrencyPolicyPanel.vue";

/** 注意 remindAfterMinutes 故意与组件默认值(2)不同：只有加载完成才会出现这个值。 */
const policy = {
  enabled: true,
  remindAfterMinutes: 7,
  disableAfterMinutes: 5,
  disableForHours: 1,
  adminEmail: null,
  interruptStreams: true,
  defaultStreamLimit: 1,
};

/**
 * 并发超限升级面板：口径是"超限到点**直接冻结**"（冻结 = 停用 + 断掉全部设备），
 * 且提醒可以关掉（0 = 不提醒，到点直接冻结）。
 */
describe("ConcurrencyPolicyPanel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the freeze wording and lets the operator turn the reminder off", async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return { ok: true, json: async () => ({ policy }) } as never;
      }),
    );

    render(ConcurrencyPolicyPanel);
    // loading 初值是 false：首帧会先画"带默认值的表单"，加载回来才换成真实值。
    // 用只有加载后才会出现的数值来等，避免拿到会被卸载的临时节点。
    const remindInput = (await screen.findByDisplayValue("7")) as HTMLInputElement;

    // 提醒分钟数允许填 0（0 = 不提醒，到点直接冻结）
    expect(remindInput.min).toBe("0");
    // 冻结口径写在"超限多少分钟后冻结"那一项的说明里
    expect(screen.getByDisplayValue("5").closest("label")?.textContent ?? "").toContain(
      "冻结 = 立即断开该账号全部设备",
    );

    await fireEvent.update(remindInput, "0");
    await fireEvent.click(screen.getByRole("button", { name: /保存并生效/ }));

    await waitFor(() => expect(calls.some((call) => call.url === "/api/concurrency-policy" && call.body)).toBe(true));
    const saved = calls.find((call) => call.body)?.body;
    expect(saved?.remindAfterMinutes).toBe(0);
  });

  it("notifies the parent when the current load needs administrator login", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 401 })),
    );
    const requireAuth = vi.fn();
    render(ConcurrencyPolicyPanel, { props: { requireAuth } });
    await waitFor(() => expect(requireAuth).toHaveBeenCalledTimes(1));
  });

  it("cancels loading when unmounted and ignores a late unauthorized response", async () => {
    let resolve!: (response: Response) => void;
    const fetchImpl = vi.fn(
      (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const requireAuth = vi.fn();
    const { unmount } = render(ConcurrencyPolicyPanel, { props: { requireAuth } });
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const signal = fetchImpl.mock.calls[0]?.[1]?.signal;
    unmount();
    expect(signal?.aborted).toBe(true);
    resolve(new Response("", { status: 401 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(requireAuth).not.toHaveBeenCalled();
  });
});
