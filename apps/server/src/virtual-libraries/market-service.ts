import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import {
  appSettings,
  submissionUsers,
  virtualLibraries,
  virtualLibrarySubscriptions,
} from "@emby-task-center/database/schema";
import type {
  MarketDefaults,
  MarketLibrary,
  MarketUserLibrary,
} from "@emby-task-center/contracts/virtual-library-market";
import type { VirtualLibrary } from "@emby-task-center/contracts/virtual-library";
import { createVirtualLibraryStore } from "./store";
import { memberAccessError } from "../subscriptions/member-access";
import { privateIdentity } from "./private-access";
import { createUpstreamLibraryMarketService } from "./upstream-market-service";

export const adminMarketSubscriber = "admin:primary-admin";
export type MarketActor = { memberId?: number; adminId?: string };
export class MarketError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}
const defaultsKey = "virtualLibraryMarket.defaults";

export function createVirtualLibraryMarketService(database: AppDatabase) {
  const store = createVirtualLibraryStore(database, { all: true });
  const external = createUpstreamLibraryMarketService(database);
  function readValue(key: string): unknown {
    try {
      return JSON.parse(database.select().from(appSettings).where(eq(appSettings.key, key)).get()?.value ?? "null");
    } catch {
      return null;
    }
  }
  function writeValue(key: string, value: unknown) {
    const row = {
      value: JSON.stringify(value),
      updatedAt: new Date().toISOString(),
      updatedBy: "virtual-library-market",
    };
    database
      .insert(appSettings)
      .values({ key, ...row })
      .onConflictDoUpdate({ target: appSettings.key, set: row })
      .run();
  }
  function readDefaults(): MarketDefaults {
    const value = readValue(defaultsKey) as Partial<MarketDefaults> | null;
    return {
      libraryIds: Array.isArray(value?.libraryIds)
        ? value.libraryIds.filter((id): id is string => typeof id === "string")
        : [],
      adminEmbyUserId: typeof value?.adminEmbyUserId === "string" ? value.adminEmbyUserId : null,
    };
  }
  function owned(library: VirtualLibrary, actor: MarketActor) {
    return (
      (actor.memberId !== undefined && library.ownerMemberId === actor.memberId) ||
      (!!actor.adminId && library.ownerAdminId === actor.adminId)
    );
  }
  function authorAvailable(library: VirtualLibrary) {
    if (library.ownerAdminId === "primary-admin") return true;
    if (library.ownerMemberId == null) return false;
    const member = database.select().from(submissionUsers).where(eq(submissionUsers.id, library.ownerMemberId)).get();
    return !!member?.embyUserId && !memberAccessError(database, member.email, true);
  }
  function available(library: VirtualLibrary) {
    return library.published === true && authorAvailable(library);
  }
  function enabled(subscriberId: string, library: VirtualLibrary) {
    const row = database
      .select()
      .from(virtualLibrarySubscriptions)
      .where(
        and(
          eq(virtualLibrarySubscriptions.subscriberId, subscriberId),
          eq(virtualLibrarySubscriptions.libraryId, library.id),
        ),
      )
      .get();
    return !!row?.enabled && row.publicationVersion === library.publicationVersion;
  }
  function memberForEmby(embyId: string) {
    const matching = database
      .select()
      .from(submissionUsers)
      .all()
      .filter((member) => member.embyUserId && privateIdentity(member.embyUserId) === privateIdentity(embyId));
    return matching.length === 1 && !memberAccessError(database, matching[0].email, true) ? matching[0] : undefined;
  }
  function subscriberFor(actor: MarketActor) {
    if (actor.memberId !== undefined) return `member:${actor.memberId}`;
    const binding = readDefaults().adminEmbyUserId;
    const member = binding ? memberForEmby(binding) : undefined;
    return member ? `member:${member.id}` : adminMarketSubscriber;
  }
  function effectiveOwnIds(actor: MarketActor) {
    const embyId =
      actor.memberId === undefined
        ? readDefaults().adminEmbyUserId
        : database.select().from(submissionUsers).where(eq(submissionUsers.id, actor.memberId)).get()?.embyUserId;
    return new Set([
      ...store
        .list()
        .filter((library) => owned(library, actor))
        .map((library) => library.id),
      ...(embyId ? (resolveAccess(embyId)?.ownLibraryIds ?? []) : []),
    ]);
  }
  function list(actor: MarketActor): MarketLibrary[] {
    const ownIds = effectiveOwnIds(actor);
    return [
      ...store
        .list()
        .filter(available)
        .map((library) => ({
          ...library,
          ownerMemberId: undefined,
          ownerAdminId: undefined,
          itemCount: owned(library, actor) ? library.itemCount : 0,
          authorName: library.ownerAdminId ? "管理员" : "用户",
          owned: owned(library, actor),
          canSubscribe: !ownIds.has(library.id),
          enabled: ownIds.has(library.id) || enabled(subscriberFor(actor), library),
        })),
      ...external.list(subscriberFor(actor)),
    ];
  }
  function publication(actor: MarketActor, id: string, published: boolean) {
    return database.transaction(() => {
      const library = store.get(id);
      if (!library || !owned(library, actor)) throw new MarketError(404, "virtual_library_not_found");
      if (published && !authorAvailable(library)) throw new MarketError(403, "publisher_unavailable");
      if (library.published !== published)
        database
          .update(virtualLibraries)
          .set({
            published,
            publicationVersion: (library.publicationVersion ?? 0) + (published ? 0 : 1),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(virtualLibraries.id, id))
          .run();
      return store.get(id)!;
    });
  }
  function subscribe(subscriberId: string, id: string, value: boolean) {
    if (subscriberId === adminMarketSubscriber) subscriberId = subscriberFor({ adminId: "primary-admin" });
    if (external.get(id)) return external.subscribe(subscriberId, id, value);
    return database.transaction(() => {
      const library = store.get(id);
      if (!library || (value && !available(library))) throw new MarketError(404, "virtual_library_not_found");
      const row = {
        subscriberId,
        libraryId: id,
        enabled: value,
        publicationVersion: library.publicationVersion ?? 0,
        updatedAt: new Date().toISOString(),
      };
      database
        .insert(virtualLibrarySubscriptions)
        .values(row)
        .onConflictDoUpdate({
          target: [virtualLibrarySubscriptions.subscriberId, virtualLibrarySubscriptions.libraryId],
          set: row,
        })
        .run();
      return value;
    });
  }
  function saveDefaults(value: MarketDefaults) {
    return patchDefaults(value);
  }
  function patchDefaults(value: Partial<MarketDefaults>) {
    return database.transaction(() => {
      const current = readDefaults();
      const libraryIds = value.libraryIds === undefined ? current.libraryIds : [...new Set(value.libraryIds)];
      if (
        value.libraryIds !== undefined &&
        libraryIds.some((id) => {
          const library = store.get(id);
          const upstream = external.get(id);
          return upstream ? !upstream.available || !upstream.published : !library || !available(library);
        })
      )
        throw new MarketError(400, "market_library_unavailable");
      const result = {
        libraryIds,
        adminEmbyUserId:
          value.adminEmbyUserId === undefined ? current.adminEmbyUserId : value.adminEmbyUserId?.trim() || null,
      };
      writeValue(defaultsKey, result);
      return result;
    });
  }
  function initializeMember(memberId: number) {
    database.transaction(() => {
      const key = `virtualLibraryMarket.initialized.${memberId}`;
      if (readValue(key)) return;
      for (const id of readDefaults().libraryIds) {
        const library = store.get(id);
        const upstream = external.get(id);
        if ((library && available(library)) || (upstream?.available && upstream.published))
          subscribe(`member:${memberId}`, id, true);
      }
      writeValue(key, true);
    });
  }
  function resolveAccess(embyId: string) {
    const member = memberForEmby(embyId);
    const adminId = readDefaults().adminEmbyUserId;
    const isAdmin = !!adminId && privateIdentity(adminId) === privateIdentity(embyId);
    if (!member && !isAdmin) return undefined;
    const actor = { memberId: member?.id, adminId: isAdmin ? "primary-admin" : undefined };
    const own = store.list().filter((l) => owned(l, actor));
    const subscriberId = member ? `member:${member.id}` : adminMarketSubscriber;
    const visible = store.list().filter((l) => owned(l, actor) || (available(l) && enabled(subscriberId, l)));
    return {
      memberId: member?.id,
      subscriberId,
      ownLibraryIds: own.map((l) => l.id),
      visibleLibraryIds: visible.map((l) => l.id),
    };
  }
  function userLibraries(): MarketUserLibrary[] {
    const members = new Map(
      database
        .select()
        .from(submissionUsers)
        .all()
        .map((m) => [m.id, m]),
    );
    return store
      .list()
      .filter((l) => l.ownerMemberId != null)
      .map((l) => ({
        ...l,
        ownerEmail: members.get(l.ownerMemberId!)?.email ?? null,
        authorName: members.get(l.ownerMemberId!)?.email ?? "已删除用户",
      }));
  }
  return {
    canSubscribe: (actor: MarketActor, id: string) => !effectiveOwnIds(actor).has(id),
    subscriberFor,
    isEnabled: (subscriberId: string, id: string) => {
      if (external.get(id)) return external.isEnabled(subscriberId, id);
      const library = store.get(id);
      return !!library && enabled(subscriberId, library);
    },
    list,
    publication,
    subscribe,
    readDefaults,
    saveDefaults,
    patchDefaults,
    initializeMember,
    resolveAccess,
    userLibraries,
    available,
    owned,
  };
}
