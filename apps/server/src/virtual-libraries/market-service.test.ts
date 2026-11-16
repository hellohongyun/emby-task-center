import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { concurrencyEscalationState, submissionUsers } from "@emby-task-center/database/schema";
import { createVirtualLibraryStore } from "./store";
import { createVirtualLibraryMarketService } from "./market-service";

describe("market ownership and live access", () => {
  let db: DatabaseHandle;
  let service: ReturnType<typeof createVirtualLibraryMarketService>;
  let alice: number, bob: number, id: string, adminId: string;
  beforeEach(() => {
    db = createDatabase(":memory:");
    const now = new Date().toISOString();
    alice = db.db
      .insert(submissionUsers)
      .values({ email: "alice@example.test", embyUserId: "alice", createdAt: now, updatedAt: now })
      .returning()
      .get().id;
    bob = db.db
      .insert(submissionUsers)
      .values({ email: "bob@example.test", embyUserId: "bob", createdAt: now, updatedAt: now })
      .returning()
      .get().id;
    const own = createVirtualLibraryStore(db.db, { ownerMemberId: alice });
    id = own.create({ name: "original", collectionType: "movies" }).id;
    own.addItems(id, [{ itemId: "film", name: "private-film-name", type: "Movie", year: null, imageTag: null }]);
    adminId = createVirtualLibraryStore(db.db).create({ name: "admin" }).id;
    service = createVirtualLibraryMarketService(db.db);
  });
  afterEach(() => db.close());
  it("publishes one live library and denies other writers including administrator", () => {
    expect(service.list({ memberId: bob })).toEqual([]);
    expect(() => service.publication({ memberId: bob }, id, true)).toThrow("virtual_library_not_found");
    expect(() => service.publication({ adminId: "primary-admin" }, id, true)).toThrow("virtual_library_not_found");
    service.publication({ memberId: alice }, id, true);
    expect(service.list({ memberId: bob })[0]).toMatchObject({ id, itemCount: 0, enabled: false });
    service.subscribe(`member:${bob}`, id, true);
    expect(service.resolveAccess("bob")?.visibleLibraryIds).toEqual([id]);
    createVirtualLibraryStore(db.db, { ownerMemberId: alice }).update(id, { name: "updated" });
    expect(service.list({ memberId: bob })[0]).toMatchObject({ id, name: "updated", enabled: true, itemCount: 0 });
    expect(service.userLibraries()[0]).toMatchObject({ ownerEmail: "alice@example.test" });
  });
  it("unpublishing revokes immediately and republishing never restores old subscriptions", () => {
    service.publication({ memberId: alice }, id, true);
    service.subscribe(`member:${bob}`, id, true);
    service.publication({ memberId: alice }, id, false);
    expect(service.resolveAccess("bob")?.visibleLibraryIds).toEqual([]);
    expect(service.resolveAccess("alice")?.ownLibraryIds).toEqual([id]);
    service.publication({ memberId: alice }, id, true);
    expect(service.resolveAccess("bob")?.visibleLibraryIds).toEqual([]);
    service.subscribe(`member:${bob}`, id, true);
    expect(service.resolveAccess("bob")?.visibleLibraryIds).toEqual([id]);
    service.subscribe(`member:${bob}`, id, false);
    expect(service.resolveAccess("bob")?.visibleLibraryIds).toEqual([]);
  });
  it.each(["disabled", "expired", "frozen", "deleted"])(
    "suspends sharing when author is %s without deleting their library",
    (state) => {
      service.publication({ memberId: alice }, id, true);
      service.subscribe(`member:${bob}`, id, true);
      if (state === "disabled")
        db.db.update(submissionUsers).set({ enabled: false }).where(eq(submissionUsers.id, alice)).run();
      if (state === "expired")
        db.db
          .update(submissionUsers)
          .set({ subscriptionExpiresAt: "2000-01-01T00:00:00Z" })
          .where(eq(submissionUsers.id, alice))
          .run();
      if (state === "frozen")
        db.db
          .insert(concurrencyEscalationState)
          .values({ memberId: alice, disabledUntil: "2100-01-01T00:00:00Z", updatedAt: new Date().toISOString() })
          .run();
      if (state === "deleted") db.db.delete(submissionUsers).where(eq(submissionUsers.id, alice)).run();
      expect(service.resolveAccess("bob")?.visibleLibraryIds).toEqual([]);
      expect(createVirtualLibraryStore(db.db, { all: true }).get(id)).toBeTruthy();
    },
  );
  it("initializes selected defaults once, skipping currently unlisted entries", () => {
    service.publication({ memberId: alice }, id, true);
    service.saveDefaults({ libraryIds: [id], adminEmbyUserId: null });
    service.initializeMember(bob);
    expect(service.resolveAccess("bob")?.visibleLibraryIds).toEqual([id]);
    service.subscribe(`member:${bob}`, id, false);
    service.initializeMember(bob);
    expect(service.resolveAccess("bob")?.visibleLibraryIds).toEqual([]);
    expect(() => service.saveDefaults({ libraryIds: [adminId], adminEmbyUserId: null })).toThrow(
      "market_library_unavailable",
    );
  });
  it("requires explicit administrator Emby binding and merges overlapping member access", () => {
    service.publication({ adminId: "primary-admin" }, adminId, true);
    expect(service.resolveAccess("unmapped-admin")).toBeUndefined();
    service.saveDefaults({ libraryIds: [], adminEmbyUserId: "bob" });
    service.subscribe("admin:primary-admin", id, false);
    expect(service.resolveAccess("bob")?.ownLibraryIds).toEqual([adminId]);
    service.publication({ memberId: alice }, id, true);
    service.subscribe("admin:primary-admin", id, true);
    expect(service.resolveAccess("bob")?.visibleLibraryIds).toEqual(expect.arrayContaining([adminId, id]));
  });
  it("does not restore old administrator choices when binding to an existing member", () => {
    service.publication({ memberId: alice }, id, true);
    service.subscribe("admin:primary-admin", id, true);
    service.saveDefaults({ libraryIds: [], adminEmbyUserId: "bob" });
    expect(service.subscriberFor({ adminId: "primary-admin" })).toBe(`member:${bob}`);
    expect(service.list({ adminId: "primary-admin" }).find((l) => l.id === id)?.enabled).toBe(false);
    expect(service.resolveAccess("bob")?.visibleLibraryIds).not.toContain(id);
    expect(() => service.publication({ adminId: "primary-admin" }, id, false)).toThrow("virtual_library_not_found");
  });
});
