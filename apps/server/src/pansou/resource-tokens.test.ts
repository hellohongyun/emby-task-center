import { describe, expect, it } from "vitest";

import { createResourceTokenStore, RESOURCE_TOKEN_TTL_MS } from "./resource-tokens";
import type { PansouResource } from "./pansou-filter";

function fakeResource(): PansouResource {
  return {
    resourceId: "",
    platformKey: "other",
    displayType: "网盘",
    url: "https://www.guangyapan.com/s/secret",
    password: "pwd123",
    note: "光鸭云盘资源",
    maskedNote: "xxx资源",
    source: "plugin:gying",
    datetime: "2026-08-30T00:00:00Z",
    images: [],
    score: 80,
    qualityTags: ["4K"],
    isGying: true,
    raw: { url: "https://www.guangyapan.com/s/secret", note: "光鸭云盘资源", source: "plugin:gying" },
  };
}

describe("resource token store", () => {
  it("issues a resourceId and resolves back to the full resource", () => {
    const store = createResourceTokenStore();
    const id = store.issue(fakeResource());
    expect(id).toBeTruthy();
    const resolved = store.resolve(id);
    expect(resolved?.url).toBe("https://www.guangyapan.com/s/secret");
    expect(resolved?.password).toBe("pwd123");
    expect(resolved?.platformKey).toBe("other");
  });

  it("public view strips url/password", () => {
    const store = createResourceTokenStore();
    const token = store.resolve(store.issue(fakeResource()))!;
    const publicView = store.toPublicView(token);
    expect(publicView.resourceId).toBeTruthy();
    expect(publicView).not.toHaveProperty("url");
    expect(publicView).not.toHaveProperty("password");
    expect(publicView.sourceLabel).toBe("观影");
  });

  it("drops expired tokens", () => {
    const store = createResourceTokenStore(1);
    const id = store.issue(fakeResource());
    expect(store.resolve(id)).toBeTruthy();
  });

  it("configured default TTL is 30 minutes", () => {
    expect(RESOURCE_TOKEN_TTL_MS).toBe(30 * 60_000);
  });
});
