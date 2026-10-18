import { describe, expect, it } from "vitest";

import { createDatabase } from "@emby-task-center/database/client";
import type { EmbyClient, EmbyUserPolicy } from "../integrations/emby-client";
import { writeSettings } from "../settings/store";
import { syncEmbyStreamLimit } from "./emby-account";

function makeEmby() {
  const policies: Record<string, EmbyUserPolicy> = { u1: { IsDisabled: true }, u2: { IsDisabled: false } };
  const client = {
    configured: true,
    listUsers: async () => Object.entries(policies).map(([Id, Policy]) => ({ Id, Name: Id, Policy })),
    createUser: async () => ({ Id: "x", Name: "x" }),
    setUserPassword: async () => undefined,
    updateUserPolicy: async (id: string, policy: EmbyUserPolicy) => {
      policies[id] = { ...policy };
    },
    deleteUser: async () => undefined,
    listSessions: async () => [],
  } as unknown as EmbyClient;
  return { client, policies };
}

describe("syncEmbyStreamLimit", () => {
  it("maps the member limit to Emby SimultaneousStreamLimit", async () => {
    const database = createDatabase(":memory:");
    const { client, policies } = makeEmby();
    expect(await syncEmbyStreamLimit(database.db, client, "u1", 3)).toBe(true);
    expect(policies["u1"]).toMatchObject({ SimultaneousStreamLimit: 3 });
    expect(policies["u1"].IsDisabled).toBe(true);
    database.close();
  });

  /**
   * 回归：会员没登记上限时曾经写 0（=不限），于是自助开卡/自动绑定的会员在 Emby 侧完全不设防。
   * 现在写全局默认路数（默认 1）。
   */
  it("falls back to the global default limit instead of 'unlimited' when the member has none", async () => {
    const database = createDatabase(":memory:");
    const { client, policies } = makeEmby();
    expect(await syncEmbyStreamLimit(database.db, client, "u1", null)).toBe(true);
    expect(policies["u1"]).toMatchObject({ SimultaneousStreamLimit: 1 });
    // 0 与 null 同义（都表示"没登记"）
    expect(await syncEmbyStreamLimit(database.db, client, "u2", 0)).toBe(true);
    expect(policies["u2"]).toMatchObject({ SimultaneousStreamLimit: 1 });
    database.close();
  });

  it("writes 'unlimited' only when the global default itself is 0", async () => {
    const database = createDatabase(":memory:");
    writeSettings(database.db, { "concurrencyPolicy.defaultStreamLimit": 0 });
    const { client, policies } = makeEmby();
    expect(await syncEmbyStreamLimit(database.db, client, "u1", null)).toBe(true);
    expect(policies["u1"]).toMatchObject({ SimultaneousStreamLimit: 0 });
    database.close();
  });

  it("returns false when Emby is not configured", async () => {
    const database = createDatabase(":memory:");
    const client = { configured: false } as unknown as EmbyClient;
    expect(await syncEmbyStreamLimit(database.db, client, "u1", 2)).toBe(false);
    database.close();
  });

  it("keeps the existing policy when policy reading fails", async () => {
    const database = createDatabase(":memory:");
    try {
      const { client, policies } = makeEmby();
      client.listUsers = async () => {
        throw new Error("upstream unavailable");
      };
      expect(await syncEmbyStreamLimit(database.db, client, "u1", 3)).toBe(false);
      expect(policies.u1).toEqual({ IsDisabled: true });
    } finally {
      database.close();
    }
  });
});
