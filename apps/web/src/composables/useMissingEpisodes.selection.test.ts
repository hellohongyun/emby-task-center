import { effectScope } from "vue";
import { describe, expect, it, vi } from "vitest";
import { useMissingEpisodes } from "./useMissingEpisodes";

const snapshot = (rootId: string) => ({ rootId, shows: [], scanning: false });
function subject(fetchImpl: typeof fetch) {
  const scope = effectScope();
  const state = scope.run(() => useMissingEpisodes({ fetchImpl, autoLoad: false }))!;
  return { ...state, dispose: () => scope.stop() };
}

describe("missing episodes selected library", () => {
  it("keeps the server-selected default library on refresh and encodes explicit selections", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => Response.json(snapshot("emby-guid")));
    const state = subject(fetchImpl);
    await state.load();
    expect(fetchImpl.mock.calls[0]![0]).toBe("/api/missing-episodes");
    expect(state.selectedRootId.value).toBe("emby-guid");
    await state.load();
    expect(fetchImpl.mock.calls[1]![0]).toBe("/api/missing-episodes?rootId=emby-guid");
    await state.load("guid&other=value");
    expect(fetchImpl.mock.calls[2]![0]).toBe("/api/missing-episodes?rootId=guid%26other%3Dvalue");
    state.dispose();
  });

  it("clears the previous library immediately and cancels its pending read on switching", async () => {
    let oldResolve!: (value: Response) => void;
    let newResolve!: (value: Response) => void;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ...snapshot("old"), shows: [{ mediaItemId: 1 }] }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (oldResolve = resolve)))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (newResolve = resolve)));
    const state = subject(fetchImpl);
    await state.load();
    const oldRead = state.load();
    const newRead = state.load("new");
    expect(state.payload.value).toBeNull();
    expect(state.selectedRootId.value).toBe("new");
    await oldRead;
    expect(state.loading.value).toBe(true);
    newResolve(Response.json(snapshot("new")));
    await newRead;
    oldResolve(Response.json(snapshot("old")));
    await Promise.resolve();
    expect(state.payload.value?.rootId).toBe("new");
    expect(state.selectedRootId.value).toBe("new");
    state.dispose();
  });

  it("accepts a GUID deletion scope and reloads the selected library", async () => {
    const result = { deleted: 1, failed: 0, results: [] };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json(snapshot("library-guid")))
      .mockResolvedValueOnce(Response.json(result))
      .mockResolvedValueOnce(Response.json(snapshot("library-guid")));
    const state = subject(fetchImpl);
    await state.load();
    expect(await state.deleteShows([1], "library-guid")).toMatchObject({ deleted: 1 });
    expect(JSON.parse(fetchImpl.mock.calls[1]![1].body)).toEqual({ mediaItemIds: [1], rootId: "library-guid" });
    expect(fetchImpl.mock.calls[2]![0]).toBe("/api/missing-episodes?rootId=library-guid");
    state.dispose();
  });

  it("clears the selected scope when no enabled library remains", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json(snapshot("old")))
      .mockResolvedValueOnce(Response.json({ ...snapshot(""), rootId: null }));
    const state = subject(fetchImpl);
    await state.load();
    await state.load();
    expect(state.selectedRootId.value).toBe("");
    state.dispose();
  });
});
