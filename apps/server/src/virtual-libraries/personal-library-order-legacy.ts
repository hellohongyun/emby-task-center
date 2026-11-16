import type { AppDatabase } from "@emby-task-center/database/client";
import { readSettings } from "../settings/store";
import { anchorOwnedViews, applyAdminLibraryOrder } from "./view-order";
import { viewIdentity, type OwnedViewAnchor } from "./owned-view-preferences";
import type { Item } from "./query-helpers";

export function legacyLibrarySequence(
  source: Item[],
  additions: Item[],
  order: readonly string[],
  anchors: OwnedViewAnchor[],
  ownLibraryIds: readonly string[],
) {
  const keys = (item: Item) =>
    [item.Id, item.Guid].filter((id): id is string => typeof id === "string").map(viewIdentity);
  const visible = new Set([...source, ...additions].flatMap(keys));
  const kept = anchors.filter((anchor) => visible.has(viewIdentity(anchor.id)));
  const historical = kept.length ? [...kept[0].previous.slice().reverse(), kept[0].id, ...kept[0].next] : [];
  const recognized = [...new Set([...historical, ...order].map(viewIdentity))].filter((id) => visible.has(id));
  if (!recognized.length && !kept.length) return undefined;
  const known = new Set([...recognized, ...kept.map((anchor) => viewIdentity(anchor.id))]);
  const own = new Set(ownLibraryIds.map(viewIdentity));
  const leading = additions.filter((item) => keys(item).some((id) => own.has(id) && !known.has(id)));
  const leadingIds = new Set(leading.flatMap(keys));
  const rest = additions.filter((item) => !keys(item).some((id) => leadingIds.has(id)));
  if (kept.length) return [...leading, ...applyAdminLibraryOrder([...source, ...rest], recognized, keys)];
  return [...leading, ...anchorOwnedViews(applyAdminLibraryOrder(source, recognized, keys), rest, recognized, kept)];
}

/** This is a preference read for an already authenticated account, never an ownership proof. */
export async function legacyLibraryConfiguration(database: AppDatabase, userId: string, fetcher = fetch) {
  const { values } = readSettings(database);
  if (!values["emby.baseUrl"] || !values["emby.apiKey"]) return {};
  try {
    const url = new URL(`${values["emby.baseUrl"].replace(/\/+$/, "")}/Users/${encodeURIComponent(userId)}`);
    const response = await fetcher(url, {
      headers: { "X-Emby-Token": values["emby.apiKey"] },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return {};
    }
    const body = (await response.json()) as { Configuration?: Record<string, unknown> };
    return body.Configuration ?? {};
  } catch {
    return {};
  }
}
