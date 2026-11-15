import { fireEvent, render, screen, waitFor } from "@testing-library/vue";
import { afterEach, expect, it, vi } from "vitest";
import DevelopmentModePanel from "./DevelopmentModePanel.vue";

const payload = (enabled: boolean, emailForcedDisabled = true) => ({
  developmentMode: { enabled, emailForcedDisabled },
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it("saves only the mode key immediately and uses the confirmed server state", async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(payload(false)))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
  vi.stubGlobal("fetch", fetcher);
  const view = render(DevelopmentModePanel);
  const toggle = await screen.findByRole("switch", { name: "启用开发调试模式" });
  await waitFor(() => expect(toggle).toBeEnabled());
  expect(screen.getByText(/当前运行环境强制禁发邮件/)).toBeVisible();
  await fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(toggle).toBeDisabled();
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ values: { "development.enabled": true } });
  finish(Response.json(payload(true)));
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  expect(view.emitted().saved).toHaveLength(1);
});

it("keeps enabled state and emits nothing when disabling is rejected", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(Response.json(payload(true)))
      .mockResolvedValueOnce(
        Response.json({ rejected: [{ key: "development.enabled", error: "failed" }] }, { status: 400 }),
      ),
  );
  const view = render(DevelopmentModePanel);
  const toggle = await screen.findByRole("switch", { name: "关闭开发调试模式" });
  await fireEvent.click(toggle);
  expect(await screen.findByRole("alert")).toHaveTextContent("无法保存或读取开发调试模式");
  expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(toggle).toBeEnabled();
  expect(view.emitted().saved).toBeUndefined();
});

it("requires administrator authentication and prevents writes before status is loaded", async () => {
  const requireAuth = vi.fn();
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
  vi.stubGlobal("fetch", fetcher);
  render(DevelopmentModePanel, { props: { requireAuth } });
  expect(await screen.findByRole("alert")).toHaveTextContent("登录已过期");
  expect(requireAuth).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("switch")).toBeDisabled();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("ignores completion after the panel is removed", async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(Response.json(payload(false)))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
  );
  const view = render(DevelopmentModePanel);
  const toggle = await screen.findByRole("switch", { name: "启用开发调试模式" });
  await waitFor(() => expect(toggle).toBeEnabled());
  await fireEvent.click(toggle);
  view.unmount();
  finish(Response.json(payload(true)));
  await Promise.resolve();
  expect(view.emitted().saved).toBeUndefined();
});
