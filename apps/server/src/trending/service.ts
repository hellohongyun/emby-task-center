import { eq } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { trendingSourceConfigs } from "@emby-task-center/database/schema";
import { DEFAULT_SOURCE_SETTINGS } from "./adapters";
import { createTrendingAdapters } from "./adapters";
import { createMemoryCacheStore } from "./cache";
import type { AdapterContext } from "./adapters/common";
import type { CacheStore, TrendingResult, TrendingSection, TrendingSectionConfig, TrendingSource } from "./types";
import { effectiveSectionConfigs, loadAllSnapshots, saveSnapshot } from "./store";
import { fetchSectionsWithDeadline } from "./refresh";

export interface TrendingServiceOptions {
  database: AppDatabase;
  tmdbToken: string;
  fetchImpl?: typeof fetch;
  cache?: CacheStore;
  /** 日志回调（可空）。 */
  log?: (event: string, message?: string) => void;
  now?: () => number;
}

export interface TrendingService {
  getSections(filterKeys?: string[]): Promise<TrendingResult>;
  refresh(): Promise<void>;
  start(): void;
  stop(): void;
  getConfigs(): TrendingSectionConfig[];
  updateSource(
    source: TrendingSource,
    patch: { enabled?: boolean; ttlMinutes?: number; refreshMinutes?: number },
  ): void;
}

export function createTrendingService(options: TrendingServiceOptions): TrendingService {
  const database = options.database;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => undefined);
  const adapters = createTrendingAdapters();
  const cache = options.cache ?? createMemoryCacheStore();
  const adapterContext: AdapterContext = {
    fetchImpl: options.fetchImpl ?? fetch,
    tmdbToken: options.tmdbToken,
  };

  let configs = effectiveSectionConfigs(database);
  const sectionsByKey = new Map(loadAllSnapshots(database).map((section) => [section.key, section]));
  const inFlight = new Map<TrendingSource, Promise<TrendingSection[] | null>>();
  const lastRefreshAt = new Map<TrendingSource, number>();
  const failures = new Map<TrendingSource, { count: number; retryAt: number }>();
  const generations = new Map<TrendingSource, number>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function configFor(source: TrendingSource, key: string): TrendingSectionConfig | undefined {
    return configs.find((entry) => entry.source === source && entry.key === key);
  }

  async function refreshSource(source: TrendingSource): Promise<TrendingSection[] | null> {
    const existing = inFlight.get(source);
    if (existing) return existing;
    if (!configs.some((entry) => entry.source === source && entry.enabled)) return null;
    if ((failures.get(source)?.retryAt ?? 0) > now()) return null;
    const adapter = adapters[source];
    if (!adapter) return null;
    const generation = generations.get(source) ?? 0;
    const task = (async () => {
      try {
        const sections = await fetchSectionsWithDeadline(adapter, adapterContext);
        if (generation !== (generations.get(source) ?? 0)) return null;
        let persisted = 0;
        for (const section of sections) {
          if (section.items.length === 0) continue; // 空结果不覆盖已有快照/缓存
          const sectionConfig = configFor(section.source, section.key);
          if (!sectionConfig?.enabled) continue;
          persisted += 1;
          const ttl = sectionConfig?.ttlMs ?? 60 * 60_000;
          sectionsByKey.set(section.key, { ...section, stale: false });
          // Redis 不参与 HTTP 读取路径，写入失败/卡住也不阻断快照刷新。
          void cache.set(`trending:${section.key}`, { ...section, stale: false }, ttl).catch(() => undefined);
          try {
            saveSnapshot(database, section);
          } catch {
            /* 快照写失败不影响返回 */
          }
        }
        if (persisted === 0) throw new Error(`${source} returned no items`);
        lastRefreshAt.set(source, now());
        failures.delete(source);
        log("trending_refreshed", `${source}: ${sections.map((section) => section.key).join(",")}`);
        return sections;
      } catch (error) {
        if (generation !== (generations.get(source) ?? 0)) return null;
        const count = (failures.get(source)?.count ?? 0) + 1;
        failures.set(source, { count, retryAt: now() + Math.min(30_000 * 2 ** Math.min(count - 1, 5), 15 * 60_000) });
        log("trending_refresh_failed", `${source}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      } finally {
        if (generation === (generations.get(source) ?? 0)) inFlight.delete(source);
      }
    })();
    inFlight.set(source, task);
    return task;
  }

  async function getSections(filterKeys?: string[]): Promise<TrendingResult> {
    const activeConfigs = configs.filter((entry) => entry.enabled);
    const targets = filterKeys?.length
      ? activeConfigs.filter((entry) => filterKeys.includes(entry.key))
      : activeConfigs;

    const sections: TrendingSection[] = [];
    const degradedSources = new Set<TrendingSource>();
    for (const entry of targets) {
      const key = entry.key;
      const resolved = sectionsByKey.get(key);
      const stale = !resolved || resolved.stale || now() - resolved.updatedAt >= entry.ttlMs;
      const due = now() - (lastRefreshAt.get(entry.source) ?? resolved?.updatedAt ?? 0) >= entry.refreshMs;
      const lastRefresh = lastRefreshAt.get(entry.source);
      const refreshDue = lastRefresh === undefined || now() - lastRefresh >= Math.min(entry.refreshMs, entry.ttlMs);
      if ((stale || due) && refreshDue) void refreshSource(entry.source);
      if (resolved && resolved.items.length > 0) {
        if (stale || failures.has(entry.source)) degradedSources.add(entry.source);
        sections.push({ ...resolved, stale: stale || failures.has(entry.source) });
      } else {
        degradedSources.add(entry.source);
      }
    }

    return {
      sections: sections.sort((a, b) => rank(a) - rank(b)),
      updatedAt: sections.reduce((max, section) => Math.max(max, section.updatedAt), 0),
      degradedSources: [...degradedSources],
      refreshing: targets.some((entry) => inFlight.has(entry.source)),
    };
  }

  function rank(section: TrendingSection): number {
    const index = configs.findIndex((entry) => entry.key === section.key);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  }

  async function refresh(): Promise<void> {
    const refreshable = new Set<TrendingSource>();
    for (const entry of configs) {
      if (!entry.enabled) continue;
      const last = lastRefreshAt.get(entry.source);
      if (last === undefined || now() - last >= entry.refreshMs) refreshable.add(entry.source);
    }
    await Promise.all([...refreshable].map((source) => refreshSource(source).catch(() => null)));
  }

  function start(): void {
    if (timer) return;
    const intervals = configs.filter((entry) => entry.enabled).map((entry) => entry.refreshMs);
    const refreshMs = Math.min(...(intervals.length ? intervals : [15 * 60_000]), 15 * 60_000);
    timer = setInterval(() => void refresh().catch(() => undefined), refreshMs);
    timer.unref?.();
    void refresh().catch(() => undefined);
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
    for (const source of inFlight.keys()) generations.set(source, (generations.get(source) ?? 0) + 1);
    inFlight.clear();
  }

  function getConfigs(): TrendingSectionConfig[] {
    return [...configs];
  }

  function updateSource(
    source: TrendingSource,
    patch: { enabled?: boolean; ttlMinutes?: number; refreshMinutes?: number },
  ): void {
    const existing = database
      .select()
      .from(trendingSourceConfigs)
      .where(eq(trendingSourceConfigs.source, source))
      .get();
    const defaults = DEFAULT_SOURCE_SETTINGS[source];
    const ttlMinutes = patch.ttlMinutes ?? existing?.ttlMinutes ?? Math.round(defaults.ttlMs / 60_000);
    const refreshMinutes = patch.refreshMinutes ?? existing?.refreshMinutes ?? Math.round(defaults.refreshMs / 60_000);
    const enabled = patch.enabled ?? existing?.enabled ?? defaults.enabled;
    const updatedAt = new Date().toISOString();
    if (existing) {
      database
        .update(trendingSourceConfigs)
        .set({ enabled, ttlMinutes, refreshMinutes, updatedAt })
        .where(eq(trendingSourceConfigs.source, source))
        .run();
    } else {
      database.insert(trendingSourceConfigs).values({ source, enabled, ttlMinutes, refreshMinutes, updatedAt }).run();
    }
    configs = effectiveSectionConfigs(database);
    if (!enabled) {
      generations.set(source, (generations.get(source) ?? 0) + 1);
      inFlight.delete(source);
    }
  }

  return { getSections, refresh, start, stop, getConfigs, updateSource };
}
