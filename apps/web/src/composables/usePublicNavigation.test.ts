import { describe, expect, it } from "vitest";

import { memberStatusText } from "./usePublicNavigation";

describe("member status text", () => {
  it("maps the known statuses and passes unknown ones through", () => {
    expect(memberStatusText("active")).toBe("有效");
    expect(memberStatusText("expiring")).toBe("即将到期");
    expect(memberStatusText("expired")).toBe("已过期");
    expect(memberStatusText("none")).toBe("未开通");
    expect(memberStatusText("weird")).toBe("weird");
  });
});

describe("public navigation", () => {
  /** 组装最小依赖，验证"搜索 → 影视库"这条交接路径。 */
  async function setup(
    overrides: { loggedInEmail?: string | null; memberStatus?: string; contentAllowed?: boolean } = {},
  ) {
    const { usePublicNavigation } = await import("./usePublicNavigation");
    const { ref } = await import("vue");
    const nav = usePublicNavigation({
      session: {
        loggedInEmail: ref(overrides.loggedInEmail ?? null),
        memberStatus: ref(overrides.memberStatus ?? "none"),
        contentAllowed: ref(overrides.contentAllowed ?? true),
      } as never,
      navItems: [{ value: "home", label: "首页", icon: "icon" }],
    });
    return { nav };
  }

  it("hands a trimmed query to the library page and clears the input", async () => {
    const { nav } = await setup();
    nav.searchQuery.value = "  沙丘  ";
    nav.submitSearch();
    expect(nav.libraryQuery.value).toBe("沙丘");
    expect(nav.searchQuery.value).toBe("");
    expect(nav.view.value).toBe("library");
  });

  it("ignores empty searches", async () => {
    const { nav } = await setup();
    nav.searchQuery.value = "   ";
    nav.submitSearch();
    expect(nav.view.value).toBe("home");
  });

  it("hands the home search query to the library page", async () => {
    const { nav } = await setup();
    nav.handleHomeSearch("  沙丘 ");
    expect(nav.libraryQuery.value).toBe("沙丘");
    expect(nav.view.value).toBe("library");
    nav.handleHomeSearch("   ");
    expect(nav.libraryQuery.value).toBe("沙丘");
  });

  it("summarizes the session only when logged in", async () => {
    const anonymous = await setup();
    expect(anonymous.nav.sessionSummary.value).toBe("");
    const member = await setup({ loggedInEmail: "a@b.c", memberStatus: "expiring" });
    expect(member.nav.sessionSummary.value).toBe("a@b.c · 即将到期");
  });

  it("keeps restricted members on profile for navigation and both search entry points", async () => {
    const { nav } = await setup({ contentAllowed: false, memberStatus: "expired" });
    expect(nav.view.value).toBe("profile");
    nav.navigateTo("home");
    nav.searchQuery.value = "沙丘";
    nav.submitSearch();
    nav.handleHomeSearch("沙丘");
    expect(nav.view.value).toBe("profile");
    expect(nav.libraryQuery.value).toBe("");
  });
});
