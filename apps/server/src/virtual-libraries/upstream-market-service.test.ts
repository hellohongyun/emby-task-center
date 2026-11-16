import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { submissionUsers, virtualLibraries } from "@emby-task-center/database/schema";
import { count } from "drizzle-orm";
import { writeSettings } from "../settings/store";
import { createUpstreamLibraryMarketService } from "./upstream-market-service";
import { createVirtualLibraryMarketService } from "./market-service";
import { upstreamMarketSettings } from "./upstream-market-initialize";

describe("upstream virtual library market", () => {
  let database: DatabaseHandle;
  let service: ReturnType<typeof createUpstreamLibraryMarketService>;
  let alice: number, bob: number;
  let missing: boolean, failed: boolean, mismatch: boolean, failBob: boolean;
  let paging: boolean, late: boolean, hideSecond: boolean;
  const native = { Id: "10", Guid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", Name: "Native", Type: "CollectionFolder" };
  const virtual = {
    Id: "ttd-one",
    Guid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    Name: "TTD one",
    Type: "CollectionFolder",
    CollectionType: "movies",
    ImageTags: { Primary: "tag-one" },
  };
  const second = { ...virtual, Id: "ttd-two", Guid: "cccccccc-cccc-cccc-cccc-cccccccccccc", Name: "TTD two" };
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  beforeEach(() => {
    database = createDatabase(":memory:");
    missing = failed = mismatch = failBob = false;
    paging = late = false;
    hideSecond = true;
    const now = new Date().toISOString();
    [alice, bob] = ["alice", "bob"].map(
      (name) =>
        database.db
          .insert(submissionUsers)
          .values({ email: `${name}@example.test`, embyUserId: name, createdAt: now, updatedAt: now })
          .returning()
          .get().id,
    );
    writeSettings(database.db, {
      "emby.baseUrl": "http://native.test",
      "emby.apiKey": "fixture-key",
      "virtualLibraryProxy.upstream": "http://proxy.test",
    });
    upstreamMarketSettings(database.db).write("virtualLibraryMarket.defaults", {
      libraryIds: [],
      adminEmbyUserId: "alice",
    });
    fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(new Headers(init?.headers).get("X-Emby-Token")).toBe("fixture-key");
      expect(init?.method ?? "GET").toBe("GET");
      if (failed) return new Response("{}", { status: 503 });
      let body: unknown;
      if (url.pathname === "/System/Info/Public")
        body = { Id: mismatch && url.host === "proxy.test" ? "another-server" : "same-server" };
      else if (url.pathname === "/Library/VirtualFolders")
        body = [{ ItemId: native.Id, Guid: native.Guid, Name: native.Name }];
      else if (url.pathname.endsWith("/Items")) body = { Items: [native], TotalRecordCount: 1 };
      else if (url.pathname.endsWith("/Views")) {
        if (failBob && url.pathname.includes("/bob/")) return new Response("{}", { status: 503 });
        const collections = {
          Id: "collections",
          Name: "Emby collections",
          Type: "CollectionFolder",
          CollectionType: "boxsets",
        };
        const entries =
          url.host === "native.test"
            ? [native, collections]
            : [
                native,
                collections,
                ...(!missing ? [virtual, second] : []),
                ...(late ? [{ ...virtual, Id: "ttd-later", Guid: "dddddddd-dddd-dddd-dddd-dddddddddddd" }] : []),
              ];
        const start = Number(url.searchParams.get("StartIndex") ?? 0);
        body = { Items: paging ? entries.slice(start, start + 2) : entries, TotalRecordCount: entries.length };
      } else
        body = {
          Id: url.pathname.split("/").at(-1),
          Configuration: { MyMediaExcludes: hideSecond ? [second.Guid.replaceAll("-", "")] : [] },
        };
      return Response.json(body);
    });
    service = createUpstreamLibraryMarketService(database.db, fetcher);
  });
  afterEach(() => database.close());
  it("discovers only proxy-added folders and requires an explicit import without creating local libraries", async () => {
    expect(service.list()).toEqual([]);
    const result = await service.sync();
    expect(result.candidates.map((candidate) => candidate.sourceId)).toEqual([virtual.Id, second.Id]);
    expect(result.libraries).toEqual([]);
    const imported = await service.import([virtual.Id, second.Id]);
    expect(imported.libraries).toHaveLength(2);
    expect(service.rows().map((row) => row.sourceId)).toEqual([virtual.Id, second.Id]);
    const row = service.rows()[0];
    expect(row.id).toMatch(/^ttd-[a-f0-9]{32}$/);
    expect(service.list(`member:${alice}`)[0]).toMatchObject({
      id: row.id,
      source: "tgtodrive",
      playbackId: virtual.Id,
      owned: false,
      enabled: true,
    });
    expect(database.db.select({ n: count() }).from(virtualLibraries).get()).toEqual({ n: 0 });
    await service.import([virtual.Id]);
    expect(service.rows()).toHaveLength(2);
  });
  it("preserves initial visibility, excludes hidden libraries and never restores an explicit off switch", async () => {
    failBob = true;
    await service.sync();
    await service.import([virtual.Id, second.Id]);
    const [one, two] = service.rows();
    expect(service.isEnabled(`member:${alice}`, one.id)).toBe(true);
    expect(service.isEnabled(`member:${alice}`, two.id)).toBe(false);
    expect(service.isEnabled(`member:${bob}`, one.id)).toBe(false);
    service.subscribe(`member:${alice}`, one.id, false);
    // A previous failed user's read is retried; already initialized users retain explicit choices.
    failBob = false;
    await service.sync();
    expect(service.isEnabled(`member:${bob}`, one.id)).toBe(true);
    expect(service.isEnabled(`member:${alice}`, one.id)).toBe(false);
    service.publication(one.id, false);
    service.publication(one.id, true);
    expect(service.isEnabled(`member:${bob}`, one.id)).toBe(false);
  });
  it("preserves initial visibility across separate import batches without auto-enabling later source additions", async () => {
    hideSecond = false;
    await service.sync();
    await service.import([virtual.Id]);
    const one = service.rows()[0];
    service.subscribe(`member:${alice}`, one.id, false);
    await service.import([second.Id]);
    const two = service.rows().find((row) => row.sourceId === second.Id)!;
    expect(service.isEnabled(`member:${alice}`, two.id)).toBe(true);
    expect(service.isEnabled(`member:${bob}`, two.id)).toBe(true);
    expect(service.isEnabled(`member:${alice}`, one.id)).toBe(false);
    late = true;
    await service.sync();
    await service.import(["ttd-later"]);
    const later = service.rows().find((row) => row.sourceId === "ttd-later")!;
    expect(service.isEnabled(`member:${alice}`, later.id)).toBe(false);
  });
  it("reads complete paged catalogs and revalidates candidates at import time", async () => {
    paging = true;
    expect((await service.sync()).candidates.map((item) => item.sourceId)).toEqual([virtual.Id, second.Id]);
    missing = true;
    await expect(service.import([virtual.Id])).rejects.toThrow("upstream_catalog_changed");
    expect(service.rows()).toEqual([]);
    missing = false;
    await service.import([virtual.Id, second.Id]);
    expect(service.rows()).toHaveLength(2);
    expect(service.list(`member:${alice}`)[0].enabled).toBe(true);
  });
  it("supports using the TgtoDrive proxy for both source addresses without including physical or built-in libraries", async () => {
    writeSettings(database.db, { "emby.baseUrl": "http://proxy.test" });
    const result = await service.sync();
    expect(result.candidates.map((item) => item.sourceId)).toEqual([virtual.Id, second.Id]);
    await service.import([virtual.Id, second.Id]);
    expect(service.rows()).toHaveLength(2);
    expect(service.list(`member:${alice}`)[0].enabled).toBe(true);
  });
  it("does not treat failed discovery as deletion and requires enabling after removal and reappearance", async () => {
    await service.sync();
    await service.import([virtual.Id]);
    const row = service.rows()[0];
    failed = true;
    await expect(service.sync()).rejects.toThrow("upstream_catalog_unavailable");
    expect(service.get(row.id)?.available).toBe(true);
    failed = false;
    missing = true;
    await service.sync();
    expect(service.get(row.id)?.available).toBe(false);
    missing = false;
    await service.sync();
    expect(service.get(row.id)?.available).toBe(true);
    expect(service.isEnabled(`member:${alice}`, row.id)).toBe(false);
  });
  it("rejects different backends and unknown or native import IDs", async () => {
    mismatch = true;
    await expect(service.sync()).rejects.toThrow("upstream_server_mismatch");
    mismatch = false;
    await service.sync();
    await expect(service.import([native.Id])).rejects.toThrow("invalid_upstream_library_selection");
    await expect(service.import(["guessed"])).rejects.toThrow("invalid_upstream_library_selection");
    writeSettings(database.db, { "virtualLibraryProxy.upstream": "http://new-proxy.test" });
    expect(service.status().candidates).toEqual([]);
    expect(service.rows()).toEqual([]);
  });
  it("uses normal market subscriptions and applies explicit defaults only to new members", async () => {
    await service.sync();
    await service.import([virtual.Id]);
    const row = service.rows()[0];
    const market = createVirtualLibraryMarketService(database.db);
    market.patchDefaults({ libraryIds: [row.id] });
    const now = new Date().toISOString();
    const fresh = database.db
      .insert(submissionUsers)
      .values({ email: "fresh@example.test", embyUserId: "fresh", createdAt: now, updatedAt: now })
      .returning()
      .get();
    market.initializeMember(fresh.id);
    expect(market.list({ memberId: fresh.id }).find((library) => library.id === row.id)?.enabled).toBe(true);
    market.subscribe(`member:${fresh.id}`, row.id, false);
    market.initializeMember(fresh.id);
    expect(market.isEnabled(`member:${fresh.id}`, row.id)).toBe(false);
    market.patchDefaults({ adminEmbyUserId: "fresh" });
    expect(market.list({ adminId: "primary-admin" }).find((library) => library.id === row.id)?.enabled).toBe(false);
  });
});
