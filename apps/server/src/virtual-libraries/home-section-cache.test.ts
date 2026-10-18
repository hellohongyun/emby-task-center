import { describe, expect, it } from "vitest";
import { createHomeSectionCache } from "./home-section-cache";

describe("home section classification cache", () => {
  it("retains only section IDs and types without user data or content", () => {
    const cache = createHomeSectionCache();
    cache.write("hash", "u", [
      { Id: "row", SectionType: "userviews", Name: "Private name", UserData: { secret: true }, Items: ["content"] },
      null,
      { Id: 1, SectionType: "resume" },
      { Id: "missing" },
    ]);
    expect(cache.read("hash", "u")).toEqual([{ Id: "row", SectionType: "userviews" }]);
  });

  it("isolates authentication scopes and users including ambiguous concatenations", () => {
    const cache = createHomeSectionCache();
    cache.write("a:b", "c", [{ Id: "first", SectionType: "userviews" }]);
    cache.write("a", "b:c", []);
    expect(cache.read("a:b", "c")).toEqual([{ Id: "first", SectionType: "userviews" }]);
    expect(cache.read("a", "b:c")).toEqual([]);
    expect(cache.read("other", "c")).toBeUndefined();
    expect(cache.read("a:b", "other")).toBeUndefined();
  });

  it("expires at 60 seconds and refreshes on a successful rewrite", () => {
    let now = 0;
    const cache = createHomeSectionCache(() => now);
    cache.write("scope", "u", []);
    now = 59_999;
    expect(cache.read("scope", "u")).toEqual([]);
    cache.write("scope", "u", [{ Id: "new", SectionType: "resume" }]);
    now = 60_000;
    expect(cache.read("scope", "u")).toEqual([{ Id: "new", SectionType: "resume" }]);
    now = 119_999;
    expect(cache.read("scope", "u")).toBeUndefined();
  });

  it("accepts empty arrays and ignores non-array failures without overriding valid hints", () => {
    const cache = createHomeSectionCache();
    cache.write("scope", "u", []);
    cache.write("scope", "u", { error: "failure" });
    expect(cache.read("scope", "u")).toEqual([]);
  });

  it("keeps at most 200 entries and evicts the least recently written", () => {
    const cache = createHomeSectionCache();
    for (let index = 0; index < 200; index++) cache.write("scope", String(index), []);
    cache.write("scope", "0", [{ Id: "renewed", SectionType: "userviews" }]);
    cache.write("scope", "200", []);
    expect(cache.read("scope", "1")).toBeUndefined();
    expect(cache.read("scope", "0")).toEqual([{ Id: "renewed", SectionType: "userviews" }]);
    expect(cache.read("scope", "200")).toEqual([]);
  });

  it("copies descriptors on write and read", () => {
    const cache = createHomeSectionCache();
    const source = [{ Id: "row", SectionType: "userviews" }];
    cache.write("scope", "u", source);
    source[0].Id = "mutated";
    const read = cache.read("scope", "u") as typeof source;
    read[0].SectionType = "mutated";
    expect(cache.read("scope", "u")).toEqual([{ Id: "row", SectionType: "userviews" }]);
  });
});
