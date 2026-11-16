import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { virtualLibraryUserOrders } from "@emby-task-center/database/schema";
import { viewIdentity } from "./owned-view-preferences";
import { applyAdminLibraryOrder } from "./view-order";

export interface PersonalLibraryOrderItem {
  id: string;
  name: string;
  guid?: string;
  posterImageTag?: string | null;
  marketId?: string;
  source?: "local" | "tgtodrive";
  kind: "native" | "owned" | "subscribed";
}

export function orderUpstream(value: string) {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/+$/, "");
}

export function composeLibraryOrder(
  items: readonly PersonalLibraryOrderItem[],
  personalOrder?: readonly string[],
  defaultOrder: readonly string[] = [],
) {
  const saved = new Set(personalOrder?.map(viewIdentity));
  const leading = items.filter((item) => item.kind === "owned" && !saved.has(viewIdentity(item.id)));
  const ids = new Set(leading.map((item) => viewIdentity(item.id)));
  const keys = (item: PersonalLibraryOrderItem) => [item.id, ...(item.guid ? [item.guid] : [])];
  const rest = applyAdminLibraryOrder(
    items.filter((item) => !ids.has(viewIdentity(item.id))),
    defaultOrder,
    keys,
  );
  return [...leading, ...(personalOrder ? applyAdminLibraryOrder(rest, personalOrder, keys) : rest)];
}

/** Orders contain identifiers only; every read is intersected with independently authorized libraries. */
export function createPersonalLibraryOrderService(database: AppDatabase) {
  const where = (upstream: string, userId: string) =>
    and(
      eq(virtualLibraryUserOrders.upstream, orderUpstream(upstream)),
      eq(virtualLibraryUserOrders.userId, viewIdentity(userId)),
    );
  function read(upstream: string, userId: string): string[] | undefined {
    const row = database.select().from(virtualLibraryUserOrders).where(where(upstream, userId)).get();
    if (!row) return undefined;
    return Array.isArray(row.order) && row.order.every((id) => typeof id === "string") ? row.order : undefined;
  }
  function write(upstream: string, userId: string, order: readonly string[]) {
    const value = [...new Set(order.map(viewIdentity))];
    const row = {
      upstream: orderUpstream(upstream),
      userId: viewIdentity(userId),
      order: value,
      updatedAt: new Date().toISOString(),
    };
    database
      .insert(virtualLibraryUserOrders)
      .values(row)
      .onConflictDoUpdate({
        target: [virtualLibraryUserOrders.upstream, virtualLibraryUserOrders.userId],
        set: { order: value, updatedAt: row.updatedAt },
      })
      .run();
    return value;
  }
  return {
    read,
    write,
    reset(upstream: string, userId: string) {
      write(upstream, userId, []);
    },
    prepend(upstream: string, userId: string, id: string, initial: readonly string[] = []) {
      const saved = read(upstream, userId);
      return write(upstream, userId, [
        id,
        ...(saved?.length ? saved : initial).filter((value) => viewIdentity(value) !== viewIdentity(id)),
      ]);
    },
    append(upstream: string, userId: string, id: string, initial: readonly string[] = []) {
      const saved = read(upstream, userId);
      const current = saved?.length ? saved : [...initial];
      return write(upstream, userId, [...current.filter((value) => viewIdentity(value) !== viewIdentity(id)), id]);
    },
  };
}
