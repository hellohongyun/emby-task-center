import { describe, expect, it } from "vitest";

import { createDatabase } from "@emby-task-center/database/client";
import { auditLogs, submissionUsers } from "@emby-task-center/database/schema";
import type { EmbyClient, EmbyUser, EmbyUserPolicy } from "../integrations/emby-client";
import { writeSettings } from "../settings/store";
import { linkOrphanEmbyUsers } from "./emby-member-sync";

function makeEmby(users: EmbyUser[]) {
  const policies: Record<string, EmbyUserPolicy> = {};
  // 形状对齐 createEmbyUserService().manager() 的要求：它按能力探测，缺一个就整体不可用。
  const client = {
    configured: true,
    listUsers: async () => users,
    createUser: async () => ({ Id: "x", Name: "x" }),
    setUserPassword: async () => undefined,
    updateUserPolicy: async (id: string, policy: EmbyUserPolicy) => {
      policies[id] = { ...(policies[id] ?? {}), ...policy };
    },
    deleteUser: async () => undefined,
    listSessions: async () => [],
  } as unknown as EmbyClient;
  return { client, policies };
}

function embyUser(id: string, name: string, policy: EmbyUserPolicy = {}): EmbyUser {
  return { Id: id, Name: name, Policy: policy };
}

const DAY_MS = 86_400_000;

describe("linkOrphanEmbyUsers", () => {
  it("binds email-named orphan accounts as members with the configured default days", async () => {
    const database = createDatabase(":memory:");
    const now = new Date("2026-09-13T08:00:00.000Z");
    const { client, policies } = makeEmby([embyUser("u1", "Family@QQ.com")]);

    const result = await linkOrphanEmbyUsers(database.db, client, now);

    expect(result.linked).toHaveLength(1);
    expect(result.linked[0]).toMatchObject({ email: "family@qq.com", embyUserId: "u1" });
    const row = database.db.select().from(submissionUsers).all()[0]!;
    expect(row).toMatchObject({
      email: "family@qq.com",
      enabled: true,
      embyUserId: "u1",
      embyUsername: "family@qq.com",
      note: "Emby 账号自动绑定",
      embyMaxStreams: null,
    });
    // 到期 = 绑定那一刻 + 默认 15 天
    expect(Math.round((Date.parse(row.subscriptionExpiresAt!) - now.getTime()) / DAY_MS)).toBe(15);
    // 顺手把默认并发路数写进 Emby 策略（修复：以前这里会写成 0=不限）
    expect(policies["u1"]).toMatchObject({ SimultaneousStreamLimit: 1 });
    // 留审计痕
    const audits = database.db.select().from(auditLogs).all();
    expect(audits.some((item) => item.action === "member.auto_linked" && item.operator === "system")).toBe(true);
    database.close();
  });

  it("honours the member.autoLinkDays setting", async () => {
    const database = createDatabase(":memory:");
    writeSettings(database.db, { "member.autoLinkDays": 7 });
    const now = new Date("2026-09-13T08:00:00.000Z");
    const { client } = makeEmby([embyUser("u1", "week@example.com")]);

    await linkOrphanEmbyUsers(database.db, client, now);

    const row = database.db.select().from(submissionUsers).all()[0]!;
    expect(Math.round((Date.parse(row.subscriptionExpiresAt!) - now.getTime()) / DAY_MS)).toBe(7);
    database.close();
  });

  it("skips administrators, non-email names and disabled accounts", async () => {
    const database = createDatabase(":memory:");
    const { client } = makeEmby([
      embyUser("a1", "owner@example.com", { IsAdministrator: true }),
      embyUser("a2", "sample-member"),
      embyUser("a3", "sleeper@example.com", { IsDisabled: true }),
      embyUser("a4", "ok@example.com"),
    ]);

    const result = await linkOrphanEmbyUsers(database.db, client);

    expect(result.linked.map((item) => item.email)).toEqual(["ok@example.com"]);
    expect(result.skipped).toEqual([
      { name: "owner@example.com", reason: "administrator" },
      { name: "sample-member", reason: "not_email" },
      { name: "sleeper@example.com", reason: "disabled" },
    ]);
    expect(database.db.select().from(submissionUsers).all()).toHaveLength(1);
    database.close();
  });

  it("is idempotent, and adopts an existing member row without touching its expiry", async () => {
    const database = createDatabase(":memory:");
    const timestamp = "2026-01-01T00:00:00.000Z";
    const future = "2099-01-01T00:00:00.000Z";
    database.db
      .insert(submissionUsers)
      .values({
        email: "friend@example.com",
        enabled: true,
        subscriptionExpiresAt: future,
        note: "手工登记",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    const { client } = makeEmby([embyUser("u9", "friend@example.com")]);

    const first = await linkOrphanEmbyUsers(database.db, client);
    expect(first.adopted).toEqual([{ email: "friend@example.com", embyUserId: "u9" }]);
    expect(first.linked).toHaveLength(0);
    const adopted = database.db.select().from(submissionUsers).all()[0]!;
    // 只补绑定，到期时间保持原样
    expect(adopted).toMatchObject({ embyUserId: "u9", subscriptionExpiresAt: future, note: "手工登记" });

    // 第二轮：已经绑定过 → 全部跳过，不再写库
    const second = await linkOrphanEmbyUsers(database.db, client);
    expect(second.linked).toHaveLength(0);
    expect(second.adopted).toHaveLength(0);
    expect(second.skipped).toEqual([{ name: "friend@example.com", reason: "already_linked" }]);
    expect(database.db.select().from(submissionUsers).all()).toHaveLength(1);
    database.close();
  });

  it("does nothing when Emby is not configured", async () => {
    const database = createDatabase(":memory:");
    const client = { configured: false } as unknown as EmbyClient;
    const result = await linkOrphanEmbyUsers(database.db, client);
    expect(result).toEqual({ linked: [], adopted: [], skipped: [] });
    database.close();
  });
});
