import { describe, expect, it, vi } from "vitest";

import { useTmdbSearch } from "./useTmdbSearch";

describe("useTmdbSearch", () => {
  it("encodes the title and returns normalized candidates", async () => {
    const candidate = { id: 101, mediaType: "movie", title: "流浪地球 2" };
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ results: [candidate] }));
    const { search } = useTmdbSearch(fetchImpl as typeof fetch);

    await expect(search("流浪地球 2")).resolves.toEqual([candidate]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/tmdb/search?q=%E6%B5%81%E6%B5%AA%E5%9C%B0%E7%90%83+2",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("does not call TMDB for a blank query", async () => {
    const fetchImpl = vi.fn();
    const { search } = useTmdbSearch(fetchImpl as typeof fetch);

    await expect(search("  ")).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("opens the shared login gate when search returns 401", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    const onUnauthorized = vi.fn();
    const { search } = useTmdbSearch(fetchImpl as typeof fetch, onUnauthorized);

    await expect(search("暗黑")).rejects.toThrow("unauthorized");
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("rejects an invalid search response instead of treating it as empty", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ unexpected: [] }));
    const { search } = useTmdbSearch(fetchImpl as typeof fetch);

    await expect(search("暗黑")).rejects.toThrow("invalid TMDB response");
  });
});
