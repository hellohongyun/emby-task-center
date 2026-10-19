import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { appSettings } from "@emby-task-center/database/schema";
import { createVirtualLibraryStore } from "./store";
import { createOwnedViewPreferences } from "./owned-view-preferences";

describe("owned view preference observation", () => {
  let database: DatabaseHandle;
  let owned: string;
  let preferences: ReturnType<typeof createOwnedViewPreferences>;
  const upstream = "http://upstream.test/emby";

  beforeEach(() => {
    database = createDatabase(":memory:");
    const store = createVirtualLibraryStore(database.db);
    owned = store.create({ name: "Owned" }).id;
    preferences = createOwnedViewPreferences(database.db, store);
  });
  afterEach(() => database.close());

  function observe(body: string, status = 204, path = "/Users/alice/Configuration/Partial", ended = true) {
    const request = Object.assign(new EventEmitter(), { method: "POST", headers: { "x-emby-token": "secret-token" } });
    const response = Object.assign(new EventEmitter(), { statusCode: status });
    preferences.observe(
      request as unknown as IncomingMessage,
      response as ServerResponse,
      new URL(path, upstream),
      upstream,
    );
    request.emit("data", Buffer.from(body));
    if (ended) request.emit("end");
    response.emit("finish");
  }

  it("persists only owned anchors, without credentials or unrelated configuration", () => {
    observe(JSON.stringify({ OrderedViews: ["ttd", owned, "native"], Password: "must-not-store" }));
    expect(preferences.read(upstream, "alice")).toEqual([{ id: owned, previous: ["ttd"], next: ["native"] }]);
    const rows = database.db.select().from(appSettings).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toMatch(/^virtualLibraryOrder\.[a-f\d]{64}$/);
    expect(JSON.stringify(rows)).not.toMatch(/secret-token|must-not-store|upstream\.test|alice/);
    expect(preferences.read(upstream, "bob")).toEqual([]);
    expect(preferences.read("http://another.test/emby", "alice")).toEqual([]);
    preferences = createOwnedViewPreferences(database.db, createVirtualLibraryStore(database.db));
    expect(preferences.read(upstream, "alice")).toHaveLength(1);
  });

  it.each([
    ["not-json", 204, true],
    ['{"OrderedViews":[123]}', 204, true],
    ['{"AudioLanguagePreference":"zho"}', 204, true],
    ["ORDER", 403, true],
    ["ORDER", 204, false],
    [JSON.stringify({ OrderedViews: ["x".repeat(256 * 1024)] }), 204, true],
  ])("ignores invalid, denied, incomplete and oversized bodies", (body, status, ended) => {
    observe(body === "ORDER" ? JSON.stringify({ OrderedViews: [owned] }) : body, status, undefined, ended);
    expect(preferences.read(upstream, "alice")).toEqual([]);
    expect(database.db.select().from(appSettings).all()).toHaveLength(0);
  });

  it("ignores unrelated endpoint bodies and observes full configuration too", () => {
    observe(JSON.stringify({ OrderedViews: [owned] }), 204, "/Users/alice/Password");
    expect(preferences.read(upstream, "alice")).toEqual([]);
    observe(JSON.stringify({ OrderedViews: [owned, "ttd"] }), 204, "/Users/alice/Configuration");
    expect(preferences.read(upstream, "alice")).toEqual([{ id: owned, previous: [], next: ["ttd"] }]);
  });

  it("resets a previously observed position when a later valid order omits it", () => {
    observe(JSON.stringify({ OrderedViews: [owned, "ttd"] }));
    observe(JSON.stringify({ OrderedViews: ["ttd"] }));
    expect(preferences.read(upstream, "alice")).toEqual([]);
  });
});
