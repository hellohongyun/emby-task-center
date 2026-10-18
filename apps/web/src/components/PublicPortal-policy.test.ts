import { render, screen, waitFor } from "@testing-library/vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PublicPortal from "./PublicPortal.vue";
import { resetPortalSession, usePortalSession } from "../composables/usePortalSession";
import { portalFetch } from "../composables/portal-access";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const member = (status = "active", contentAccess = true) => ({
  email: "member@example.com",
  member: {
    email: "member@example.com",
    status,
    contentAccess,
    subscriptionExpiresAt: null,
    embyUsername: "member",
    embyUserId: null,
  },
});
const mount = () =>
  render(PublicPortal, {
    global: {
      stubs: {
        PublicHomeView: { template: "<div>影片内容</div>" },
        PublicLibraryView: { template: "<div>影视库内容</div>" },
        PublicProfileView: { template: "<div>资料和续费</div>" },
        PublicLoginView: { template: "<div>重新登录</div>" },
        AnnouncementModal: true,
      },
    },
  });

beforeEach(() => {
  resetPortalSession();
  vi.unstubAllGlobals();
});

describe("portal member access policy", () => {
  it.each(["expired", "active"])("opens only profile for %s with denied content", async (status) => {
    const fetchMock = vi.fn(async () => json(200, member(status, false)));
    vi.stubGlobal("fetch", fetchMock);
    mount();
    expect(await screen.findByText("资料和续费")).toBeInTheDocument();
    expect(screen.queryByText("影片内容")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "影视库" })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("搜影视库 / 影片…")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["membership_expired", "member_frozen"])("removes loaded content on %s", async (code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(200, member())),
    );
    mount();
    await screen.findByText("影片内容");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(403, { error: code })),
    );
    await portalFetch("/api/public/library/list");
    await waitFor(() => expect(screen.queryByText("影片内容")).not.toBeInTheDocument());
    expect(screen.getByText("资料和续费")).toBeInTheDocument();
    expect(usePortalSession().loggedInEmail.value).toBe("member@example.com");
  });

  it.each(["member_disabled", "not_member", "unauthorized"])("clears the session on %s", async (code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(200, member())),
    );
    mount();
    await screen.findByText("影片内容");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(code === "unauthorized" ? 401 : 403, { error: code })),
    );
    await portalFetch("/api/public/library/list");
    expect(await screen.findByText("重新登录")).toBeInTheDocument();
    expect(screen.queryByText("影片内容")).not.toBeInTheDocument();
    expect(usePortalSession().loggedInEmail.value).toBe("");
    expect(usePortalSession().error.value).not.toBe(code);
  });

  it("hides old content when a refreshed profile loses access", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(200, member())),
    );
    mount();
    await screen.findByText("影片内容");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(200, member("expired", false))),
    );
    await usePortalSession().loadMember();
    expect(await screen.findByText("资料和续费")).toBeInTheDocument();
    expect(screen.queryByText("影片内容")).not.toBeInTheDocument();
  });
  it("does not restore a session from a profile response started before disablement", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(200, member())),
    );
    mount();
    await screen.findByText("影片内容");
    let resolveProfile!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveProfile = resolve;
          }),
      ),
    );
    const refresh = usePortalSession().loadMember();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(403, { error: "member_disabled" })),
    );
    await portalFetch("/api/public/library/list");
    resolveProfile(json(200, member()));
    expect(await refresh).toBe(false);
    expect(usePortalSession().loggedInEmail.value).toBe("");
    expect(await screen.findByText("重新登录")).toBeInTheDocument();
  });
});
