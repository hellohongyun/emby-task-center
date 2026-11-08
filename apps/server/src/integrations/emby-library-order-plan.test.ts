import { describe, expect, it } from "vitest";
import {
  libraryOrderSnapshot,
  matchesLibraryOrder,
  planLibraryOrderFromTokens,
  sameOrder,
  viewIdentity,
} from "./emby-library-order-plan";

const films = { id: "101", guid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "电影" };
const tv = { id: "102", guid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "剧集" };
const anime = { id: "103", guid: "cccccccccccccccccccccccccccccccc", name: "动漫" };

function snapshot(orderedViews: string[], views: (typeof films)[]) {
  return libraryOrderSnapshot({ orderedViews, hiddenViews: [], isAdministrator: false }, views, new Set());
}

describe("Emby library order planning", () => {
  it("normalizes GUID spellings and compares orders by identity", () => {
    expect(viewIdentity(films.guid)).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(sameOrder([films.guid, tv.id], [films.guid.replaceAll("-", "").toLowerCase(), tv.id])).toBe(true);
  });

  it("moves visible libraries into the requested order and preserves unknown tokens", () => {
    const target = snapshot([tv.guid, films.guid, "removed-token"], [films, tv, anime]);
    const plan = planLibraryOrderFromTokens([anime.guid, films.guid, tv.guid], target);
    expect(plan.before).toEqual(["剧集", "电影", "动漫"]);
    expect(plan.after).toEqual(["动漫", "电影", "剧集"]);
    expect(plan.expected).toEqual([anime.guid, films.guid, tv.guid]);
    expect(plan.update).toEqual([anime.guid, films.guid, "removed-token", tv.guid]);

    const actual = snapshot(plan.update!, [films, tv, anime]);
    expect(matchesLibraryOrder(actual, plan)).toBe(true);
  });

  it("does not rewrite an account whose displayed order already matches", () => {
    const target = snapshot([anime.id, films.guid, tv.guid], [films, tv, anime]);
    const plan = planLibraryOrderFromTokens([anime.guid, films.guid, tv.guid], target);
    expect(plan.update).toBeNull();
    expect(plan.before).toEqual(plan.after);
    expect(matchesLibraryOrder(target, plan)).toBe(false);
  });

  it("uses the stored order as the fallback for libraries missing from the global order", () => {
    const target = snapshot([tv.guid, films.guid], [films, tv, anime]);
    const plan = planLibraryOrderFromTokens([films.guid], target);
    expect(plan.after).toEqual(["电影", "剧集", "动漫"]);
    expect(plan.update).toEqual([films.guid, tv.guid, anime.guid]);
  });

  it("persists an implicit order and requires an explicit match on read-back", () => {
    const target = snapshot([], [films, tv]);
    const plan = planLibraryOrderFromTokens([films.guid, tv.guid], target);
    expect(plan.before).toEqual(plan.after);
    expect(plan.update).toEqual([films.guid, tv.guid]);
    expect(matchesLibraryOrder(target, plan)).toBe(false);
  });
});
