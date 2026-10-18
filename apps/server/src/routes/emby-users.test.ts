import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import { createLibraryService } from "../library/service";
import type { TmdbClient } from "../tmdb/client";
import type { EmbyClient, EmbyUserPolicy } from "../integrations/emby-client";

const sharedPassword = "family-password";
const sessionSecret = "session-signing-secret";

describe("emby user management API", () => {
  let directory: string;
  let database: DatabaseHandle;
  let server: Server;
  let baseUrl: string;
  let emby: EmbyClient & {
    __users: Array<{ Id: string; Name: string; Policy: EmbyUserPolicy }>;
    __sessions: unknown[];
  };
  let deleted: string[];

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "emby-users-"));
    database = createDatabase(join(directory, "app.sqlite"));
    deleted = [];
    emby = {
      configured: true,
      __users: [{ Id: "1", Name: "alice", Policy: { IsDisabled: false } }],
      __sessions: [{ Id: "s1", UserId: "1", DeviceName: "TV" }],
      systemInfo: async () => ({ serverName: "Emby", version: "1" }),
      verify: async () => true,
      listUsers: async () => emby.__users,
      createUser: async (name: string) => {
        const user = { Id: "2", Name: name, Policy: {} };
        emby.__users.push(user);
        return user;
      },
      setUserPassword: async () => undefined,
      updateUserPolicy: async (id: string, policy: EmbyUserPolicy) => {
        const user = emby.__users.find((u) => u.Id === id);
        if (user) user.Policy = policy;
      },
      deleteUser: async (id: string) => {
        emby.__users = emby.__users.filter((u) => u.Id !== id);
        deleted.push(id);
      },
      listSessions: async () => emby.__sessions,
      endSession: async (id: string) => {
        emby.__sessions = emby.__sessions.filter((s) => (s as { Id: string }).Id !== id);
      },
    } as never;
    const tmdb: TmdbClient = {
      search: async () => [],
      details: async () => {
        throw new Error("unused");
      },
      seasonProgress: async () => ({
        seasonNumber: 1,
        airedEpisodes: 1,
        totalEpisodes: 1,
        lastAirDate: null,
        nextAirDate: null,
      }),
      airedEpisodeCount: async () => 1,
      seasonEpisodes: async () => [],
    };
    const app = createApp({
      database: database.db,
      auth: { sessionSecret, verifyCredentials: staticCredentialVerifier(sharedPassword) },
      tmdb,
      library: createLibraryService([]),
      integrationServices: { emby, email: {} as never },
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function login(): Promise<string> {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: sharedPassword }),
    });
    expect(response.status).toBe(200);
    return (response.headers.get("set-cookie") ?? "").split(";")[0];
  }

  it("lists users with their active session count", async () => {
    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/emby/users`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: Array<{ id: string; name: string; activeSessions: number }> };
    expect(body.users).toHaveLength(1);
    expect(body.users[0]).toMatchObject({ id: "1", name: "alice", activeSessions: 1 });
  });

  it("reports an Emby-side credential failure as 502, never 401", async () => {
    // 回归：Emby 密钥失效时必须回 502 —— 前端把 401 一律当成"管理端登录失效"，
    // 回 401 会让管理员在会话完全有效的情况下被弹回登录页（真实发生过）。
    const cookie = await login();
    emby.listUsers = async () => {
      throw new Error("emby_http_401");
    };
    const res = await fetch(`${baseUrl}/api/emby/users`, { headers: { cookie } });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("EMBY_API_KEY");

    // 会话仍然有效：同一个 cookie 再问一次受保护接口，不该被判成未登录
    emby.listUsers = async () => emby.__users;
    const again = await fetch(`${baseUrl}/api/emby/users`, { headers: { cookie } });
    expect(again.status).toBe(200);
  });

  it("creates a user, then disables and re-enables it", async () => {
    const cookie = await login();
    const created = await fetch(`${baseUrl}/api/emby/users`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "bob", password: "password123" }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { id: string; name: string };
    expect(createdBody.name).toBe("bob");

    const disable = await fetch(`${baseUrl}/api/emby/users/${createdBody.id}/disable`, {
      method: "POST",
      headers: { cookie },
    });
    expect(disable.status).toBe(200);
    const afterDisable = await fetch(`${baseUrl}/api/emby/users`, { headers: { cookie } });
    const disabledUser = (
      (await afterDisable.json()) as { users: Array<{ id: string; isDisabled: boolean }> }
    ).users.find((u) => u.id === createdBody.id);
    expect(disabledUser?.isDisabled).toBe(true);

    const enable = await fetch(`${baseUrl}/api/emby/users/${createdBody.id}/enable`, {
      method: "POST",
      headers: { cookie },
    });
    expect(enable.status).toBe(200);
    const afterEnable = await fetch(`${baseUrl}/api/emby/users`, { headers: { cookie } });
    const enabledUser = (
      (await afterEnable.json()) as { users: Array<{ id: string; isDisabled: boolean }> }
    ).users.find((u) => u.id === createdBody.id);
    expect(enabledUser?.isDisabled).toBe(false);
  });

  it("removing a member also removes their Emby account", async () => {
    // 回归：原先「移除会员」只删会员行，Emby 号还在、还能继续看 —— 等于没断服；
    // 「删除」（Emby 号）又是另一个按钮。两者现在合并成一个动作。
    const cookie = await login();
    const created = await fetch(`${baseUrl}/api/submission-users`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.com" }),
    });
    expect(created.status).toBe(201);
    const { user } = (await created.json()) as { user: { id: number; embyUserId: string | null } };
    expect(user.embyUserId).toBe("2"); // 自动开通出来的 Emby 号

    const removed = await fetch(`${baseUrl}/api/submission-users/${user.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(removed.status).toBe(204);
    expect(deleted).toEqual(["2"]);

    const list = (await (await fetch(`${baseUrl}/api/submission-users`, { headers: { cookie } })).json()) as {
      users: unknown[];
    };
    expect(list.users).toHaveLength(0);
    const embyUsers = (await (await fetch(`${baseUrl}/api/emby/users`, { headers: { cookie } })).json()) as {
      users: Array<{ id: string }>;
    };
    expect(embyUsers.users.map((u) => u.id)).not.toContain("2");
  });

  it("lists active sessions and ends one", async () => {
    const cookie = await login();
    const sessions = await fetch(`${baseUrl}/api/emby/sessions`, { headers: { cookie } });
    expect(sessions.status).toBe(200);
    const body = (await sessions.json()) as { sessions: Array<{ id: string; userName: string | null }> };
    expect(body.sessions).toHaveLength(1);
    await fetch(`${baseUrl}/api/emby/sessions/s1/end`, { method: "POST", headers: { cookie } });
    const after = await fetch(`${baseUrl}/api/emby/sessions`, { headers: { cookie } });
    expect(((await after.json()) as { sessions: unknown[] }).sessions).toHaveLength(0);
  });
});
