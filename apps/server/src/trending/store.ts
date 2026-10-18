import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { trendingSnapshots, trendingSourceConfigs } from "@emby-task-center/database/schema";
import { DEFAULT_SECTIONS, DEFAULT_SOURCE_SETTINGS } from "./adapters";
import type { TrendingItem, TrendingSection, TrendingSectionConfig, TrendingSource } from "./types";

export interface SourceConfig {
  enabled: boolean;
  ttlMs: number;
  refreshMs: number;
}

export function loadSourceConfigs(db: AppDatabase): Record<TrendingSource, SourceConfig> {
  const rows = db.select().from(trendingSourceConfigs).all();
  const result = {} as Record<TrendingSource, SourceConfig>;
  for (const source of Object.keys(DEFAULT_SOURCE_SETTINGS) as TrendingSource[]) {
    const defaults = DEFAULT_SOURCE_SETTINGS[source];
    const row = rows.find((entry) => entry.source === source);
    result[source] = {
      enabled: row ? Boolean(row.enabled) : defaults.enabled,
      ttlMs: row ? row.ttlMinutes * 60_000 : defaults.ttlMs,
      refreshMs: row ? row.refreshMinutes * 60_000 : defaults.refreshMs,
    };
  }
  return result;
}

export function effectiveSectionConfigs(db: AppDatabase): TrendingSectionConfig[] {
  const sourceConfigs = loadSourceConfigs(db);
  return DEFAULT_SECTIONS.map((section) => {
    const config = sourceConfigs[section.source];
    return {
      key: section.key,
      source: section.source,
      label: section.label,
      enabled: config.enabled,
      ttlMs: config.ttlMs,
      refreshMs: config.refreshMs,
    };
  });
}

/** 持久化某个区块的最新快照（用于重启/降级兜底）。 */
export function saveSnapshot(db: AppDatabase, section: TrendingSection): void {
  const now = new Date(section.updatedAt).toISOString();
  const existing = db
    .select({ id: trendingSnapshots.id })
    .from(trendingSnapshots)
    .where(and(eq(trendingSnapshots.source, section.source), eq(trendingSnapshots.sectionKey, section.key)))
    .get();
  if (existing) {
    db.update(trendingSnapshots)
      .set({
        payload: JSON.stringify(section.items),
        fetchedAt: now,
        updatedAt: now,
      })
      .where(eq(trendingSnapshots.id, existing.id))
      .run();
  } else {
    db.insert(trendingSnapshots)
      .values({
        source: section.source,
        sectionKey: section.key,
        payload: JSON.stringify(section.items),
        fetchedAt: now,
        updatedAt: now,
      })
      .run();
  }
}

/** 从 DB 读取某个区块的快照。 */
export function loadSnapshot(db: AppDatabase, sectionKey: string): TrendingSection | null {
  const row = db.select().from(trendingSnapshots).where(eq(trendingSnapshots.sectionKey, sectionKey)).get();
  if (!row) return null;
  try {
    const items = JSON.parse(row.payload) as TrendingItem[];
    const updatedAt = Date.parse(row.fetchedAt);
    if (!Array.isArray(items) || !Number.isFinite(updatedAt)) return null;
    const section = DEFAULT_SECTIONS.find((entry) => entry.key === sectionKey);
    if (!section) return null;
    return {
      key: section.key,
      label: section.label,
      source: section.source,
      items,
      updatedAt,
      stale: true,
    };
  } catch {
    return null;
  }
}

/** 加载全部 DB 快照（冷启动兜底）。 */
export function loadAllSnapshots(db: AppDatabase): TrendingSection[] {
  const rows = db.select().from(trendingSnapshots).all();
  const sections: TrendingSection[] = [];
  for (const row of rows) {
    const section = loadSnapshot(db, row.sectionKey);
    if (section && section.items.length) sections.push(section);
  }
  return sections;
}
