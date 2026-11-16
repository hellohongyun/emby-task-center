import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { virtualLibrarySubscriptions } from "@emby-task-center/database/schema";
import { createCardKeys } from "./cards";
import { activateMembershipWithCard } from "./card-activation";
import { getSubmissionUserByEmail } from "./membership";
import { createVirtualLibraryStore } from "../virtual-libraries/store";
import { createVirtualLibraryMarketService } from "../virtual-libraries/market-service";

describe("market defaults during card registration", () => {
  let database: DatabaseHandle;
  let first: string, second: string;
  let service: ReturnType<typeof createVirtualLibraryMarketService>;
  const now = new Date("2026-11-15T00:00:00Z");
  const card = () => createCardKeys(database.db, { kind: "month", count: 1 })[0]!;
  const register = (email: string, code = card()) =>
    activateMembershipWithCard(database.db, code, email, now, {
      kind: "register",
      qqNumber: email.split("@")[0],
      joinSource: null,
    });
  const subscriptions = (memberId: number) =>
    database.db
      .select()
      .from(virtualLibrarySubscriptions)
      .where(eq(virtualLibrarySubscriptions.subscriberId, `member:${memberId}`))
      .all();
  beforeEach(() => {
    database = createDatabase(":memory:");
    const store = createVirtualLibraryStore(database.db);
    first = store.create({ name: "first" }).id;
    second = store.create({ name: "second" }).id;
    service = createVirtualLibraryMarketService(database.db);
    service.publication({ adminId: "primary-admin" }, first, true);
    service.publication({ adminId: "primary-admin" }, second, true);
    service.saveDefaults({ libraryIds: [first, second], adminEmbyUserId: null });
  });
  afterEach(() => database.close());
  it("initializes only available selected libraries for a newly registered member", () => {
    service.publication({ adminId: "primary-admin" }, second, false);
    register("123456@qq.com");
    const member = getSubmissionUserByEmail(database.db, "123456@qq.com")!;
    expect(subscriptions(member.id)).toMatchObject([{ libraryId: first, enabled: true }]);
  });
  it("does not restore a closed default on activation retries or renewal", () => {
    const email = "123456@qq.com",
      code = card();
    register(email, code);
    const member = getSubmissionUserByEmail(database.db, email)!;
    service.subscribe(`member:${member.id}`, first, false);
    expect(() => register(email, code)).toThrow("already_registered");
    activateMembershipWithCard(database.db, code, email, now, { kind: "renew" });
    activateMembershipWithCard(database.db, card(), email, now, { kind: "renew" });
    expect(subscriptions(member.id).find((s) => s.libraryId === first)?.enabled).toBe(false);
    expect(subscriptions(member.id)).toHaveLength(2);
  });
  it("does not apply portal defaults to legacy activation without explicit registration mode", () => {
    const email = "123456@qq.com";
    activateMembershipWithCard(database.db, card(), email, now);
    const member = getSubmissionUserByEmail(database.db, email)!;
    expect(subscriptions(member.id)).toEqual([]);
    activateMembershipWithCard(database.db, card(), email, now, { kind: "renew" });
    expect(subscriptions(member.id)).toEqual([]);
  });
});
