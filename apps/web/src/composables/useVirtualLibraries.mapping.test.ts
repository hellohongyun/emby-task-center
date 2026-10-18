import { expect, it, vi, afterEach } from "vitest";
import { useVirtualLibraries } from "./useVirtualLibraries";

const json = (body: unknown) => new Response(JSON.stringify(body));
const item = (id: string) => ({ itemId: id, name: id, type: "Movie", year: 2026, imageTag: null });
const issue = (id: string) => ({ itemId: id, reason: "missing" as const, message: `《${id}》来源已失效` });
afterEach(() => vi.unstubAllGlobals());

it("clears old mapping issues when a refreshed response omits issues", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(json({ items: [item("42")], issues: [issue("42")] }))
      .mockResolvedValueOnce(json({ items: [item("43")] })),
  );
  const api = useVirtualLibraries(vi.fn());
  await api.selectLibrary("one");
  expect(api.issues.value).toEqual([issue("42")]);
  await api.loadItems();
  expect(api.issues.value).toEqual([]);
  expect(api.items.value[0]?.itemId).toBe("43");
});

it("isolates issues across library switches even when an old request ignores cancellation", async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(json({ items: [item("second")], issues: [issue("second")] })),
  );
  const api = useVirtualLibraries(vi.fn());
  api.issues.value = [issue("previous")];
  const first = api.selectLibrary("one");
  expect(api.issues.value).toEqual([]);
  await api.selectLibrary("two");
  finish(json({ items: [item("first")], issues: [issue("first")] }));
  await first;
  expect(api.items.value[0]?.itemId).toBe("second");
  expect(api.issues.value).toEqual([issue("second")]);
  await api.selectLibrary("");
  expect(api.issues.value).toEqual([]);
  expect(api.items.value).toEqual([]);
});

it("refreshes mapping issues after addition without hiding unresolved content", async () => {
  const library = {
    id: "one",
    name: "精选",
    collectionType: "mixed" as const,
    sortOrder: 0,
    itemCount: 2,
    createdAt: "",
    updatedAt: "",
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json({ items: [item("unresolved"), item("42")] }))
    .mockResolvedValueOnce(json({ items: [item("unresolved"), item("42")], issues: [issue("unresolved")] }))
    .mockResolvedValueOnce(json({ libraries: [library] }));
  vi.stubGlobal("fetch", fetch);
  const api = useVirtualLibraries(vi.fn());
  api.libraries.value = [library];
  api.selectedId.value = "one";
  api.issues.value = [issue("replaced"), issue("unresolved")];
  api.sourceItems.value = [item("42")];
  api.selectedItems.value = ["42"];
  await api.addItems();
  expect(api.issues.value).toEqual([issue("unresolved")]);
  expect(api.selectedItems.value).toEqual([]);
  expect(fetch).toHaveBeenNthCalledWith(2, "/api/virtual-libraries/one/items", expect.anything());
});
