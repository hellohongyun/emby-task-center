import { describe, expect, it } from "vitest";
import { createDatabase } from "@emby-task-center/database/client";
import { appSettings } from "@emby-task-center/database/schema";
import { createPrivateTokenIdentity, isPrivateAuthentication } from "./private-token-identity";
import { createPrivateIdentityStore } from "./private-identity-store";

const url = (query = "") => new URL(`http://proxy.test/Users/alice/Views${query}`);
const login = { AccessToken: "alice-token", User: { Id: "alice" }, SessionInfo: { UserId: "alice" } };

describe("upstream-proven private token identities", () => {
  it("does not infer identity from UserId, DeviceId or an unseen token", () => {
    const identity = createPrivateTokenIdentity();
    expect(identity.resolve("upstream", url("?UserId=alice&DeviceId=alice&api_key=alice-token"), {})).toBeUndefined();
    identity.observe("upstream", { Id: "alice", AccessToken: "alice-token" });
    expect(identity.resolve("upstream", url(), { "x-emby-token": "alice-token" })).toBeUndefined();
  });
  it.each([
    [{ "x-emby-token": "alice-token" }, ""],
    [{ "x-mediabrowser-token": "alice-token" }, ""],
    [{ authorization: 'Emby UserId="bob", DeviceId="forged", Token="alice-token"' }, ""],
    [{ "x-emby-authorization": "MediaBrowser Token='alice-token'" }, ""],
    [{ authorization: "Bearer alice-token" }, ""],
    [{ authorization: 'MediaBrowser Token="", UserId="bob"', "x-emby-token": "alice-token" }, ""],
    [{ "x-emby-token": "alice-token" }, "?api_key="],
    [{ authorization: 'MediaBrowser Token="alice-token"', "x-emby-token": "alice-token" }, ""],
    [{}, "?api_key=alice-token"],
    [{}, "?X-Emby-Token=alice-token"],
  ] as const)("resolves supported credential transport without trusting user labels", (headers, query) => {
    const identity = createPrivateTokenIdentity();
    identity.observe("upstream", login);
    expect(identity.resolve("upstream", url(query), headers)).toBe("alice");
    expect(identity.resolve("another-upstream", url(query), headers)).toBeUndefined();
  });
  it("rejects conflicting tokens and inconsistent upstream login results", () => {
    const identity = createPrivateTokenIdentity();
    identity.observe("upstream", login);
    expect(identity.resolve("upstream", url("?api_key=bob-token"), { "x-emby-token": "alice-token" })).toBeUndefined();
    expect(identity.resolve("upstream", url("?api_key=alice-token&API_KEY=bob-token"), {})).toBeUndefined();
    identity.observe("upstream", { ...login, AccessToken: "conflict", SessionInfo: { UserId: "bob" } });
    expect(identity.resolve("upstream", url("?api_key=conflict"), {})).toBeUndefined();
  });
  it.each([undefined, null, {}, { UserId: null }, { UserId: "" }])(
    "accepts absent optional session identity %j",
    (SessionInfo) => {
      const identity = createPrivateTokenIdentity();
      expect(identity.observe("upstream", { ...login, SessionInfo })).toBe("recorded");
      expect(identity.resolve("upstream", url(), { "x-emby-token": "alice-token" })).toBe("alice");
    },
  );
  it("reports persistence failure without publishing a memory-only proof", () => {
    const identity = createPrivateTokenIdentity({
      read: () => undefined,
      write: () => {
        throw new Error("private");
      },
    });
    expect(identity.observe("upstream", login)).toBe("persistence_error");
    expect(identity.resolve("upstream", url(), { "x-emby-token": "alice-token" })).toBeUndefined();
  });
  it("persists only a scoped token hash and proven user ID across process recreation", () => {
    const database = createDatabase(":memory:");
    try {
      const persistence = createPrivateIdentityStore(database.db);
      createPrivateTokenIdentity(persistence).observe("upstream", login);
      const stored = database.db.select().from(appSettings).all();
      expect(stored).toHaveLength(1);
      expect(stored[0].key).toMatch(/^virtualLibraryIdentity\.[a-f0-9]{64}$/);
      expect(JSON.stringify(stored)).not.toContain("alice-token");
      const restarted = createPrivateTokenIdentity(createPrivateIdentityStore(database.db));
      expect(restarted.resolve("upstream", url(), { "x-emby-token": "alice-token" })).toBe("alice");
      expect(restarted.resolve("other", url(), { "x-emby-token": "alice-token" })).toBeUndefined();
    } finally {
      database.close();
    }
  });
  it("expires proofs and only observes supported authentication routes", () => {
    const identity = createPrivateTokenIdentity({
      read: () => ({ userId: "alice", updatedAt: Date.now() - 91 * 86400000 }),
      write: () => {},
    });
    expect(identity.resolve("upstream", url(), { "x-emby-token": "alice-token" })).toBeUndefined();
    expect(isPrivateAuthentication("POST", new URL("http://proxy/Users/AuthenticateByName"))).toBe(true);
    expect(isPrivateAuthentication("POST", new URL("http://proxy/Users/alice/Authenticate"))).toBe(true);
    expect(isPrivateAuthentication("POST", new URL("http://proxy/emby/Users/AuthenticateByName.json"))).toBe(true);
    expect(isPrivateAuthentication("POST", new URL("http://proxy/emby/Users/alice/Authenticate.json"))).toBe(true);
    expect(isPrivateAuthentication("GET", new URL("http://proxy/Users/AuthenticateByName"))).toBe(false);
    expect(isPrivateAuthentication("POST", new URL("http://proxy/Users/alice/Configuration"))).toBe(false);
  });
});
