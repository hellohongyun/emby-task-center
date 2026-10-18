import { fireEvent, render, screen, waitFor } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import DashboardPage from "./DashboardPage.vue";
import { APP_SERVICES, type AppServices } from "../state/app-services";

afterEach(() => vi.unstubAllGlobals());
function setup() {
  const requireAuth = vi.fn(),
    goToView = vi.fn();
  const services = { requireAuth, ui: { goToView } } as unknown as AppServices;
  render(DashboardPage, { global: { provide: { [APP_SERVICES]: services } } });
  return { requireAuth, goToView };
}
describe("dashboard service wiring", () => {
  it("returns expired sessions to the shared login gate", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    const { requireAuth } = setup();
    await waitFor(() => expect(requireAuth).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("navigates dashboard metrics through the shared router callback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            summary: {
              tasks: { total: 1, pending: 1, processing: 0, completed: 0, failed: 0 },
              library: { items: 1, matched: 1, unmatched: 0, roots: 1 },
              members: { total: 1, active: 1, expiring: 0, expired: 0, concurrencyActive: 0 },
              recentTasks: [],
            },
          }),
        ),
      ),
    );
    const { goToView } = setup();
    await fireEvent.click(await screen.findByRole("button", { name: /全部任务/ }));
    expect(goToView).toHaveBeenCalledWith("tasks");
  });
});
