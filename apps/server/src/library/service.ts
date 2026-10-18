import { matchInventoryToMediaItem } from "./inventory-matcher";
export { matchInventoryToMediaItem } from "./inventory-matcher";
import { applyRootPlan, disableMissingRoots, isSameMedia, synchronizeRoots } from "./root-state";
import { itemId, sanitizeItem } from "./scan-items";
import { countFolderEpisodesForRoot } from "./scan-progress";
import { persistScan, persistScanFailure } from "./scan-persistence";
import { readInventory, readPublicRoot } from "./inventory-reader";
import { createScanWriter } from "./scan-writer";
export { classifyItemMediaType } from "./scan-items";
import { eq } from "drizzle-orm";
import type { RootMediaType } from "@emby-task-center/contracts/media";
import type { AppDatabase } from "@emby-task-center/database/client";
import { libraryItems, mediaRoots, type MediaItemRow } from "@emby-task-center/database/schema";
import { calculateMissing } from "./gap-calculator";
import { planRootSync, type RootSyncPlan } from "./emby-roots";
import type { ScannedMediaItem, ScanOutput } from "./scan-types";
import { checkedScanResult } from "./scan-result";

export interface LibraryRootConfig {
  id: string;
  name: string;
  mediaType: RootMediaType;
  path: string;
}
export interface LibraryRoot {
  id: string;
  name: string;
  mediaType: RootMediaType;
  lastScannedAt?: string | null;
  lastScanStatus?: string | null;
}

export interface LibraryScanResult {
  root: LibraryRoot;
  items: ScannedMediaItem[];
}
export interface LibraryInventoryItem extends ScannedMediaItem {
  id: string;
  databaseId?: number;
  sourceTitle?: string;
  sourceYear?: number | null;
  mediaItemId?: number | null;
  recognitionStatus?: string;
  genres?: string[];
  cast?: string[];
  addedAt?: string | null;
}
export interface LibraryInventory {
  root: LibraryRoot;
  items: LibraryInventoryItem[];
}
export type ScanRoot = (path: string) => Promise<ScanOutput>;

export interface LibraryRootsProvider {
  load(): Promise<readonly LibraryRootConfig[]>;
}

function isRootsProvider(value: readonly LibraryRootConfig[] | LibraryRootsProvider): value is LibraryRootsProvider {
  return typeof (value as LibraryRootsProvider).load === "function";
}

export interface RootRefreshOutcome {
  plan: RootSyncPlan;
  error?: unknown;
}

export interface LibraryService {
  close?(): Promise<void>;
  listRoots(): LibraryRoot[];
  scanRoot(rootId: string): Promise<LibraryScanResult | null>;
  scanEnabledRoots(): Promise<void>;
  matchInventory(mediaItem: MediaItemRow): number;
  getInventory(rootId: string): LibraryInventory | null;
  getInventoryPayload(rootId: string): string | null;
  invalidateInventory(rootId?: string): void;
  getItem(rootId: string, itemId: string): LibraryInventoryItem | null;
  getMissingEpisodes(
    rootId: string,
    itemId: string,
    mode: "seasonal" | "absolute",
    expected: readonly number[],
  ): number[] | null;
  rootIdForPath?(containerPath: string): string | null;
  refreshRoots?(): Promise<RootRefreshOutcome>;
  listRootFolders?(rootId: string): string[];
  countFolderEpisodes?(rootId: string, folderPath: string): number;
}

export function createLibraryService(
  rootsOrProvider: readonly LibraryRootConfig[] | LibraryRootsProvider,
  // 没有给扫描器时给一个"明确失败"的默认值：生产接线必须显式传（Emby 扫描器），
  // 而只读库存的调用方/测试不需要扫描能力。
  scan: ScanRoot = async () => {
    throw new Error("library_scan_not_configured");
  },
  database?: AppDatabase,
  hooks?: {
    onLegacyInventoryRemoved?: (info: { roots: number; rows: number; error?: string }) => void;
    databasePath?: string;
    workerUrl?: URL;
  },
): LibraryService {
  // 由来源驱动时初始为空：启动后先 refreshRoots() 再从 Emby 得到库根。
  let provider: LibraryRootsProvider | null = null;
  let roots: LibraryRootConfig[];
  if (isRootsProvider(rootsOrProvider)) {
    provider = rootsOrProvider;
    roots = [];
  } else {
    roots = [...rootsOrProvider];
  }
  const memory = new Map<string, LibraryInventoryItem[]>();
  const writer =
    database && hooks?.databasePath && hooks.databasePath !== ":memory:"
      ? createScanWriter(hooks.databasePath, hooks.workerUrl)
      : null;
  const scans = new Map<string, Promise<LibraryScanResult | null>>();

  const inventoryCache = new Map<string, { payload: string; at: number }>();
  const inventoryTtlMs = 5 * 60_000;

  function invalidateInventory(rootId?: string): void {
    if (rootId) inventoryCache.delete(rootId);
    else inventoryCache.clear();
  }

  if (database && roots.length) synchronizeRoots(database, roots);

  function isEnabled(root: LibraryRootConfig): boolean {
    return (
      !database ||
      Boolean(
        database
          .select({ enabled: mediaRoots.enabled })
          .from(mediaRoots)
          .where(eq(mediaRoots.containerPath, root.path))
          .get()?.enabled,
      )
    );
  }

  function readInventoryPayload(rootId: string, root: LibraryRootConfig): string {
    const cached = inventoryCache.get(rootId);
    if (cached && Date.now() - cached.at < inventoryTtlMs) return cached.payload;
    if (!database) return JSON.stringify({ root: readPublicRoot(root), items: memory.get(rootId) ?? [] });
    const payload = JSON.stringify({ root: readPublicRoot(root, database), items: readInventory(database, root) });
    inventoryCache.set(rootId, { payload, at: Date.now() });
    return payload;
  }

  async function performScan(rootId: string): Promise<LibraryScanResult | null> {
    const root = roots.find((candidate) => candidate.id === rootId);
    if (!root) return null;
    const startedAt = new Date().toISOString();
    try {
      const batch = checkedScanResult(await scan(root.path));
      const sanitized = batch.items.map(sanitizeItem);
      if (database) {
        if (writer) await writer.persist(root, sanitized, startedAt, roots, batch.complete);
        else persistScan(database, root, sanitized, startedAt, roots, batch.complete);
      } else
        memory.set(
          rootId,
          sanitized.map((item) => ({ ...item, id: itemId(rootId, item.relativePath) })),
        );
      invalidateInventory(rootId);
      return { root: readPublicRoot(root, database), items: sanitized };
    } catch (error) {
      if (database) persistScanFailure(database, root, startedAt, error);
      throw error;
    }
  }
  const service: LibraryService = {
    close: async () => {
      await writer?.close();
    },
    listRoots: () => roots.filter(isEnabled).map((root) => readPublicRoot(root, database)),
    scanRoot(rootId) {
      const existing = scans.get(rootId);
      if (existing) return existing;
      const running = performScan(rootId).finally(() => {
        scans.delete(rootId);
      });
      scans.set(rootId, running);
      return running;
    },
    async scanEnabledRoots() {
      const failures: unknown[] = [];
      for (const root of roots) {
        try {
          await service.scanRoot(root.id);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError(failures, `${failures.length} media root scan(s) failed.`);
    },
    matchInventory: (mediaItem) => (database ? matchInventoryToMediaItem(database, mediaItem, roots) : 0),
    getInventory(rootId) {
      const root = roots.find((candidate) => candidate.id === rootId);
      if (!root || !isEnabled(root)) {
        invalidateInventory(rootId);
        return null;
      }
      if (!database) return { root: readPublicRoot(root), items: memory.get(rootId) ?? [] };
      return JSON.parse(readInventoryPayload(rootId, root)) as LibraryInventory;
    },
    getInventoryPayload(rootId) {
      const root = roots.find((candidate) => candidate.id === rootId);
      if (!root || !isEnabled(root)) {
        invalidateInventory(rootId);
        return null;
      }
      return readInventoryPayload(rootId, root);
    },
    invalidateInventory(rootId) {
      invalidateInventory(rootId);
    },
    getItem(rootId, requestedId) {
      return service.getInventory(rootId)?.items.find((item) => item.id === requestedId) ?? null;
    },
    rootIdForPath(containerPath) {
      return roots.find((root) => root.path === containerPath)?.id ?? null;
    },
    getMissingEpisodes(rootId, requestedId, mode, expected) {
      const inventory = service.getInventory(rootId);
      if (!inventory) return null;
      const item = inventory.items.find((candidate) => candidate.id === requestedId);
      if (!item) return null;
      const related = inventory.items.filter((candidate) => isSameMedia(candidate, item));
      const sameSeason =
        mode === "seasonal" && item.identity.parsedSeason !== null
          ? related.filter((candidate) => candidate.identity.parsedSeason === item.identity.parsedSeason)
          : related;
      const stored = sameSeason.flatMap((candidate) =>
        mode === "absolute" ? candidate.identity.absoluteEpisodeNumbers : candidate.identity.episodeNumbers,
      );
      return calculateMissing(expected, stored);
    },
    listRootFolders(rootId) {
      const root = roots.find((candidate) => candidate.id === rootId);
      if (!root || !database) return [];
      const rootRow = database.select().from(mediaRoots).where(eq(mediaRoots.containerPath, root.path)).get();
      if (!rootRow) return [];
      // ????? STRM ???????????????????????
      const folders = new Set<string>();
      for (const row of database
        .select({ relativePath: libraryItems.relativePath })
        .from(libraryItems)
        .where(eq(libraryItems.mediaRootId, rootRow.id))
        .all()) {
        const directory = row.relativePath.slice(0, row.relativePath.lastIndexOf("/"));
        if (!directory) continue;
        let current = "";
        for (const segment of directory.split("/")) {
          current = current ? current + "/" + segment : segment;
          folders.add(current);
        }
      }
      return [...folders].sort((left, right) => left.localeCompare(right));
    },
    countFolderEpisodes(rootId, folderPath) {
      const root = roots.find((candidate) => candidate.id === rootId);
      if (!root || !database) return 0;
      return countFolderEpisodesForRoot(database, root, folderPath);
    },
    async refreshRoots(): Promise<RootRefreshOutcome> {
      if (!provider) return { plan: { added: [], updated: [], removed: [] } };
      let incoming: readonly LibraryRootConfig[];
      try {
        incoming = await provider.load();
      } catch (error) {
        // 拉取失败 ≠ 库被删光：保持现有库根与库存不动，把错误交给调用方提示。
        return { plan: { added: [], updated: [], removed: [] }, error };
      }
      const plan = planRootSync(roots, incoming);
      roots = applyRootPlan(roots, incoming, plan);
      // 库被删：只把数据库行置为停用（保留历史与已扫描记录），不删行。
      if (database) {
        synchronizeRoots(database, roots);
        disableMissingRoots(database, new Set(roots.map((root) => root.path)));
        // 停用库保留库存、分集与扫描历史；重新发现后恢复展示。
      }
      memory.clear();
      return { plan };
    },
  };
  return service;
}
