import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { appSettings } from "@emby-task-center/database/schema";

const SETTING_KEY = "emby.libraryOrder";
const ACTIVE_KEY = "emby.libraryOrder.active";

export interface SavedLibraryOrder {
  baseUrl: string;
  order: string[];
  names: Record<string, string>;
  aliases: Record<string, string[]>;
  updatedAt: string;
  revision: string;
}

export function expandLibraryOrder(order: string[], aliases: SavedLibraryOrder["aliases"]): string[] {
  return order.flatMap((id) => [id, ...(Object.hasOwn(aliases, id) ? aliases[id]! : [])]);
}

function normalizeBaseUrl(value: string): string {
  try {
    return new URL(value).href.replace(/\/+$/, "");
  } catch {
    return value.trim().replace(/\/+$/, "");
  }
}

function parse(value: string | undefined, baseUrl: string, proxyUpstream?: string): SavedLibraryOrder | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<SavedLibraryOrder & { proxyUpstream: string }>;
    if (
      typeof parsed.baseUrl !== "string" ||
      normalizeBaseUrl(parsed.baseUrl) !== baseUrl ||
      (proxyUpstream !== undefined && parsed.proxyUpstream !== proxyUpstream) ||
      !Array.isArray(parsed.order) ||
      parsed.order.length === 0 ||
      !parsed.order.every((item) => typeof item === "string" && item.length > 0) ||
      !parsed.names ||
      typeof parsed.names !== "object" ||
      Array.isArray(parsed.names) ||
      !Object.values(parsed.names).every((item) => typeof item === "string") ||
      typeof parsed.updatedAt !== "string"
    )
      return null;
    return {
      baseUrl,
      order: [...new Set(parsed.order)],
      names: parsed.names as Record<string, string>,
      aliases: Object.fromEntries(
        Object.entries(parsed.aliases ?? {}).filter(
          ([, items]) => Array.isArray(items) && items.every((item) => typeof item === "string"),
        ),
      ),
      updatedAt: parsed.updatedAt,
      revision: typeof parsed.revision === "string" ? parsed.revision : parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

export interface EmbyLibraryOrderStore {
  read(baseUrl: string): SavedLibraryOrder | null;
  readActive(baseUrl: string, proxyUpstream?: string): SavedLibraryOrder | null;
  save(baseUrl: string, order: string[], names: Record<string, string>): SavedLibraryOrder;
  activate(
    baseUrl: string,
    proxyUpstream: string,
    order: string[],
    names: Record<string, string>,
    aliases?: SavedLibraryOrder["aliases"],
  ): SavedLibraryOrder;
}

/** Persist the manual global order independently from Emby's per-user settings. */
export function createEmbyLibraryOrderStore(database: AppDatabase): EmbyLibraryOrderStore {
  function readValue(key: string) {
    const row = database.select().from(appSettings).where(eq(appSettings.key, key)).get();
    return row?.value ?? undefined;
  }

  function write(
    key: string,
    baseUrl: string,
    order: string[],
    names: Record<string, string>,
    aliases: SavedLibraryOrder["aliases"],
    proxyUpstream?: string,
  ): SavedLibraryOrder {
    const value: SavedLibraryOrder = {
      baseUrl: normalizeBaseUrl(baseUrl),
      order: [...new Set(order)],
      names,
      aliases,
      updatedAt: new Date().toISOString(),
      revision: randomUUID(),
    };
    const data = {
      value: JSON.stringify(proxyUpstream === undefined ? value : { ...value, proxyUpstream }),
      updatedAt: value.updatedAt,
      updatedBy: "library-order",
    };
    database
      .insert(appSettings)
      .values({ key, isSecret: false, ...data })
      .onConflictDoUpdate({ target: appSettings.key, set: data })
      .run();
    return value;
  }

  return {
    read(baseUrl) {
      return parse(readValue(SETTING_KEY), normalizeBaseUrl(baseUrl));
    },
    readActive(baseUrl, proxyUpstream = baseUrl) {
      return parse(readValue(ACTIVE_KEY), normalizeBaseUrl(baseUrl), normalizeBaseUrl(proxyUpstream));
    },
    save(baseUrl, order, names) {
      return write(SETTING_KEY, baseUrl, order, names, {});
    },
    activate(baseUrl, proxyUpstream, order, names, aliases = {}) {
      return write(ACTIVE_KEY, baseUrl, order, names, aliases, normalizeBaseUrl(proxyUpstream));
    },
  };
}
