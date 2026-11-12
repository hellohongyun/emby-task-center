import { fireEvent, render, screen, waitFor, within } from "@testing-library/vue";
import { afterEach, expect, it, vi } from "vitest";
import MembersView from "./MembersView.vue";

afterEach(() => vi.unstubAllGlobals());

it("opens reduction for finite memberships and refreshes the member list after saving", async () => {
  let reduced = false;
  const oldExpiry = "2030-01-10T00:00:00.000Z";
  const newExpiry = "2030-01-09T00:00:00.000Z";
  const request = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url === "/api/submission-users")
      return json({
        users: [
          {
            id: 1,
            email: "finite@example.com",
            status: "active",
            enabled: true,
            subscriptionExpiresAt: reduced ? newExpiry : oldExpiry,
            deferredMembershipMs: 0,
          },
          { id: 2, email: "unlimited@example.com", status: "active", enabled: true, subscriptionExpiresAt: null },
          {
            id: 3,
            email: "following@example.com",
            status: "active",
            enabled: true,
            subscriptionExpiresAt: oldExpiry,
            followsDriveExpiry: true,
          },
        ],
      });
    if (url === "/api/membership-drive-expiry") return json({ limit: null });
    if (url === "/api/emby/users") return json({ users: [] });
    if (url === "/api/emby/sessions") return json({ sessions: [] });
    if (url === "/api/submission-users/1/reduce-days") {
      reduced = true;
      return json({ user: { subscriptionExpiresAt: newExpiry }, embyStatus: "not_configured", emailStatus: "pending" });
    }
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", request);
  const view = render(MembersView, { props: { requireAuth: vi.fn() } });
  try {
    const row = within(await screen.findByRole("row", { name: /finite@example.com/ }));
    expect(
      within(screen.getByRole("row", { name: /unlimited@example.com/ })).queryByRole("button", { name: "减少天数" }),
    ).toBeNull();
    expect(
      within(screen.getByRole("row", { name: /following@example.com/ })).queryByRole("button", { name: "减少天数" }),
    ).toBeNull();
    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/membership-drive-expiry", expect.anything()));
    await fireEvent.click(row.getByRole("button", { name: "减少天数" }));
    const dialog = within(screen.getByRole("dialog", { name: "减少会员天数" }));
    await fireEvent.click(dialog.getByRole("button", { name: "确认减少天数" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText(/已减少 finite@example.com/)).toHaveTextContent("系统将自动补发");
    await waitFor(() => expect(request.mock.calls.filter(([url]) => url === "/api/submission-users")).toHaveLength(2));
    expect(within(await screen.findByRole("row", { name: /finite@example.com/ })).getByText(/2030/)).toHaveAttribute(
      "title",
      new Date(newExpiry).toLocaleString("zh-CN"),
    );
  } finally {
    view.unmount();
  }
});
