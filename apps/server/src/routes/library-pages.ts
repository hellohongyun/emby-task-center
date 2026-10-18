import type { Express } from "express";
import type { AppDatabase } from "@emby-task-center/database/client";
import type { LibraryService } from "../library/service";
import {
  codecs,
  resolutions,
  createWorkSummaryStore,
  type WorkSummary,
  type InventorySummary,
} from "../library/work-summaries";

type ReasonBucket = { label: string; count: number; sample: string[] };
function unmatchedReport(works: WorkSummary[]): ReasonBucket[] {
  const reasons = new Map<string, ReasonBucket>();
  for (const work of works.filter((w) => !w.matchedFiles)) {
    const label =
      work.year == null
        ? "标题缺年份"
        : /^(电影|剧集|更新|动漫|综艺)-/.test(work.title) && /-[a-z0-9]+$/i.test(work.title)
          ? "疑似分类目录误解析"
          : /^[\u0020-\u007E]+$/.test(work.title.trim())
            ? "外语片名/缺中文别名"
            : /[：:]/.test(work.title)
              ? "标题带分隔符（冒号）"
              : "其他/未知";
    const bucket = reasons.get(label) ?? { label, count: 0, sample: [] };
    bucket.count += 1;
    if (bucket.sample.length < 5) bucket.sample.push(work.title);
    reasons.set(label, bucket);
  }
  return [...reasons.values()].sort((a, b) => b.count - a.count);
}
function facets(works: WorkSummary[]) {
  const tags = new Set(works.flatMap((w) => w.tags));
  return {
    resolutions: resolutions.filter((s) => tags.has(s)),
    codecs: codecs.filter((s) => tags.has(s)),
    genres: [...new Set(works.flatMap((w) => w.genres))].sort((a, b) => a.localeCompare(b, "zh-CN")),
    years: [...new Set(works.flatMap((w) => (w.year == null ? [] : [w.year])))].sort((a, b) => b - a),
  };
}
export function registerLibraryPages(app: Express, database: AppDatabase, library: LibraryService) {
  const store = createWorkSummaryStore(database);
  app.get("/api/library/summary", (_request, response) => {
    const active = library.listRoots().flatMap((root) => {
      const state = store.get(root);
      return state ? [{ root, state }] : [];
    });
    const roots = active.map(({ root }) => root);
    const states = active.map(({ state }) => state);
    const summary: InventorySummary = {
      totalFiles: 0,
      workCount: 0,
      matchedFiles: 0,
      unmatchedFiles: 0,
      matchRatio: 0,
      posterFiles: 0,
      posterRatio: 0,
      missingGenreFiles: 0,
    };
    for (const { summary: s } of states)
      for (const field of [
        "totalFiles",
        "workCount",
        "matchedFiles",
        "unmatchedFiles",
        "posterFiles",
        "missingGenreFiles",
      ] as const)
        summary[field] += s[field];
    if (summary.totalFiles) {
      summary.matchRatio = Math.round((100 * summary.matchedFiles) / summary.totalFiles);
      summary.posterRatio = Math.round((100 * summary.posterFiles) / summary.totalFiles);
    }
    response.json({ roots, summary, unmatchedReport: unmatchedReport(states.flatMap((s) => s.works)) });
  });
  app.get("/api/library/roots/:rootId/works", (request, response) => {
    const root = library.listRoots().find((r) => r.id === request.params.rootId);
    const state = root && store.get(root);
    if (!root || !state) return void response.status(404).json({ error: "library_root_not_found" });
    const q = Object.fromEntries(Object.entries(request.query).map(([k, v]) => [k, String(v ?? "")]));
    const rawSize = Number(q.pageSize),
      rawPage = Number(q.page);
    const pageSize = Number.isFinite(rawSize) && rawSize > 0 ? Math.max(1, Math.min(100, Math.floor(rawSize))) : 48;
    const requestedPage =
      Number.isFinite(rawPage) && rawPage > 0 ? Math.max(1, Math.min(1_000_000, Math.floor(rawPage))) : 1;
    const needle = (q.q ?? "").trim().toLocaleLowerCase();
    const filtered = state.works
      .filter((w) => {
        if ((q.type === "tv" && !w.isTv) || (q.type === "movie" && w.isTv)) return false;
        if ((q.status === "matched" && !w.matchedFiles) || (q.status === "unresolved" && w.matchedFiles)) return false;
        if (q.year && q.year !== "all" && w.year !== Number(q.year)) return false;
        for (const name of ["resolution", "codec", "genre"] as const)
          if (q[name] && q[name] !== "all" && !(name === "genre" ? w.genres : w.tags).includes(q[name]!)) return false;
        return !needle || w.titles.some((title) => title.toLocaleLowerCase().includes(needle));
      })
      .sort((a, b) => {
        const title = a.title.localeCompare(b.title, "zh-CN");
        if (q.sort === "year") return (b.year ?? 0) - (a.year ?? 0) || title;
        if (q.sort === "latest") return (b.addedAt ?? "").localeCompare(a.addedAt ?? "") || title;
        return title;
      });
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(filtered.length / pageSize)));
    response.json({
      root,
      works: store.page(root, filtered.slice((page - 1) * pageSize, page * pageSize)),
      total: filtered.length,
      page,
      pageSize,
      summary: state.summary,
      facets: facets(state.works),
      unmatchedReport: unmatchedReport(state.works),
    });
  });
  app.get("/api/library/roots/:rootId/works/items", (request, response) => {
    const root = library.listRoots().find((r) => r.id === request.params.rootId);
    const key = String(request.query.key ?? "");
    if (!key || key.length > 2048) return void response.status(400).json({ error: "invalid_work_key" });
    const items = root && store.details(root, key);
    if (!items) return void response.status(404).json({ error: "library_work_not_found" });
    response.json({ items });
  });
  return store.invalidate;
}
