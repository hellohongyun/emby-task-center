import { describe, expect, it } from "vitest";
import { externalLibraryAccess } from "./external-library-access";
import { overlayLibraries } from "./owned-library-overlay";
import { integerParameter, result, type Item, type QueryUpstream, type VirtualQueryStore } from "./query-helpers";

const natives = Array.from({ length: 25 }, (_, index) => ({
  Id: `native-${index}`,
  Name: `Native ${index}`,
  Type: "CollectionFolder",
}));
const externals = Array.from({ length: 15 }, (_, index) => ({
  Id: `external-${index}`,
  Name: `External ${index}`,
  Type: "CollectionFolder",
}));
const owned = Array.from({ length: 8 }, (_, index) => ({
  id: `owned-${index}`,
  name: `Own ${index}`,
  ownerAdminId: "primary-admin",
  collectionType: "mixed" as const,
  itemCount: 0,
  sortOrder: index,
  createdAt: "2026-11-16T00:00:00Z",
  updatedAt: "2026-11-16T00:00:00Z",
}));
const store: VirtualQueryStore = {
  list: () => owned,
  get: (id) => owned.find((library) => library.id === id),
  listItems: () => [],
};
const expected = [
  ...owned.map((library) => library.id),
  ...natives.map((item) => item.Id),
  ...externals.slice(8, 10).map((item) => item.Id),
];

function fixture(paginate: boolean) {
  const raw: QueryUpstream = async (url) => {
    if (url.pathname === "/Users/admin") return result({ Id: "admin", Configuration: {} });
    if (url.pathname === "/Users/admin/HomeSections")
      return result([
        { Id: "resume", SectionType: "resume" },
        ...externals.map((item) => ({
          Id: `tgto123-virtual-library-${item.Id}`,
          SectionType: "tgto123-virtual-library",
          Name: item.Name,
          ParentItem: item,
        })),
      ]);
    // The real source injects external folders into Views, but its explicit
    // CollectionFolder Items query still returns only physical folders.
    const all = url.pathname === "/Items" ? natives : [...natives, ...externals];
    const start = integerParameter(url, "StartIndex", 0);
    const limit = integerParameter(url, "Limit", all.length);
    return result({ Items: paginate ? all.slice(start, start + limit) : all, TotalRecordCount: all.length });
  };
  return externalLibraryAccess(
    { libraries: externals.map((item, index) => ({ id: item.Id, aliases: [], enabled: index === 8 || index === 9 })) },
    raw,
    "admin",
  ).query;
}

async function browse(path: string, paginate: boolean) {
  const url = new URL(path, "http://fixture");
  const upstream = fixture(paginate);
  const reply = await overlayLibraries({
    url,
    store,
    upstream,
    reply: await upstream(url),
    ownLibraryIds: owned.map((library) => library.id),
    personalOrder: expected,
  });
  return reply.body as { Items: Item[]; TotalRecordCount: number };
}

describe("market discovery with a full upstream catalog and selective subscriptions", () => {
  it.each([
    "/Users/admin/Views",
    "/Library/MediaFolders?UserId=admin",
    "/Items?UserId=admin&IncludeItemTypes=CollectionFolder&Recursive=false",
  ])("preserves an upstream full-list response on %s despite a client Limit=30", async (route) => {
    const body = await browse(`${route}${route.includes("?") ? "&" : "?"}Limit=30`, false);
    expect(body.Items.map((item) => item.Id)).toEqual(expected);
    expect(body.TotalRecordCount).toBe(35);
  });

  it("keeps actual upstream paging and returns subscribed libraries on the final page", async () => {
    const first = await browse("/Users/admin/Views?StartIndex=0&Limit=30", true);
    const last = await browse("/Users/admin/Views?StartIndex=30&Limit=30", true);
    expect(first.Items).toHaveLength(30);
    expect(last.Items).toHaveLength(5);
    expect([...first.Items, ...last.Items].map((item) => item.Id)).toEqual(expected);
    expect(first.TotalRecordCount).toBe(35);
    expect(last.TotalRecordCount).toBe(35);
  });

  it("retains only enabled TgtoDrive home sections with their original section type and parent DTO", async () => {
    const reply = await fixture(false)(new URL("/Users/admin/HomeSections", "http://fixture"));
    expect(reply.body).toEqual([
      { Id: "resume", SectionType: "resume" },
      ...externals.slice(8, 10).map((item) => ({
        Id: `tgto123-virtual-library-${item.Id}`,
        SectionType: "tgto123-virtual-library",
        Name: item.Name,
        ParentItem: item,
      })),
    ]);
  });
});
