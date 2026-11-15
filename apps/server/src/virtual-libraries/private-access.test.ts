import { describe, expect, it, vi } from "vitest";
import { forbiddenPrivateReference, privateMember, privateRequestStore } from "./private-access";
import type { VirtualLibraryStore } from "./store";
import { result, type QueryUpstream } from "./query-helpers";
import { overlayLibraries } from "./owned-library-overlay";

const libraries = [
  { id: "public", ownerMemberId: null, sortOrder: 0 },
  { id: "alice-first", ownerMemberId: 1, sortOrder: 1 },
  { id: "alice-second", ownerMemberId: 1, sortOrder: 2 },
  { id: "bob", ownerMemberId: 2, sortOrder: 0 },
].map((library) => ({
  ...library,
  name: library.id,
  collectionType: "mixed" as const,
  itemCount: 0,
  createdAt: "",
  updatedAt: "",
}));
function fixture() {
  return {
    list: () => libraries,
    get: (id: string) => libraries.find((library) => library.id === id),
    listItems: vi.fn(() => []),
    getPoster: vi.fn(() => ({ imageTag: "private-tag" })),
  } as unknown as VirtualLibraryStore;
}
const url = (path: string) => new URL(path, "http://proxy.test");

describe("private proxy authorization", () => {
  it("resolves only upstream token identity and strips the claimed UserId from the probe", async () => {
    const upstream = vi.fn<QueryUpstream>().mockResolvedValue(result({ Id: "alice" }));
    const lookup = vi.fn(() => 1);
    expect(await privateMember(url("/Users/alice/Views?UserId=alice&api_key=secret"), upstream, lookup)).toBe(1);
    expect(upstream.mock.calls[0][0].pathname).toBe("/Users/Me");
    expect([...upstream.mock.calls[0][0].searchParams]).toEqual([["api_key", "secret"]]);
    expect(lookup).toHaveBeenCalledWith("alice");
  });
  it.each(["/Users/bob/Views", "/Items?UserId=bob", "/Users/alice/Views?UserId=alice&USERID=bob"])(
    "rejects mismatched user claims: %s",
    async (path) => {
      const lookup = vi.fn(() => 1);
      expect(await privateMember(url(path), async () => result({ Id: "alice" }), lookup)).toBeUndefined();
      expect(lookup).not.toHaveBeenCalled();
    },
  );
  it("fails closed for missing or failed authenticated identity", async () => {
    expect(
      await privateMember(
        url("/Items"),
        async () => result({}),
        () => 1,
      ),
    ).toBeUndefined();
    expect(
      await privateMember(
        url("/Items"),
        async () => {
          throw new Error("offline");
        },
        () => 1,
      ),
    ).toBeUndefined();
  });
  it("scopes libraries, items and posters to the authenticated member", () => {
    const all = fixture();
    const scoped = privateRequestStore(all, 1);
    expect(scoped.list().map((library) => library.id)).toEqual(["public", "alice-first", "alice-second"]);
    expect(scoped.get("bob")).toBeUndefined();
    expect(scoped.getPoster("bob")).toBeUndefined();
    expect(scoped.listItems("bob")).toEqual([]);
    expect(all.getPoster).not.toHaveBeenCalled();
    expect(all.listItems).not.toHaveBeenCalled();
  });
  it.each([
    "/Items/bob",
    "/Items/bob/Images/Primary?tag=private-tag",
    "/Items?ParentId=bob",
    "/Items?Ids=public,bob",
    "/Users/alice/Sections/task-center-latest%3Abob/Items",
  ])("blocks forbidden private references before upstream: %s", (path) => {
    const all = fixture();
    expect(forbiddenPrivateReference(url(path), all, privateRequestStore(all, 1))).toBe(true);
  });
  it("frontloads private libraries before the shared administrator template and paginates the combined list", async () => {
    const store = privateRequestStore(fixture(), 1);
    const upstream = vi.fn<QueryUpstream>(async (target) =>
      target.pathname === "/Users/alice"
        ? result({ Configuration: { OrderedViews: ["public", "alice-second", "alice-first"] } })
        : result({ Items: [{ Id: "native" }], TotalRecordCount: 1 }),
    );
    const response = await overlayLibraries({
      url: url("/Users/alice/Views?StartIndex=1&Limit=2"),
      store,
      upstream,
      reply: result({ Items: [], TotalRecordCount: 1 }),
      adminOrder: ["native", "public"],
    });
    expect(response.body).toMatchObject({ Items: [{ Id: "alice-second" }, { Id: "native" }], TotalRecordCount: 4 });
  });
});
