import BetterSqlite3 from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { libraryItems, libraryScanRuns, logs, mediaRoots } from "@emby-task-center/database/schema";
import { compileScanFixture, createDeepScanFixture } from "../test-support/deep-scan-fixture";

describe("compiled HTTP / SQLite / scan and portal worker linkage", () => {
  let compiled: Awaited<ReturnType<typeof compileScanFixture>>;
  let fixture: Awaited<ReturnType<typeof createDeepScanFixture>>;
  beforeAll(async () => {
    compiled = await compileScanFixture();
  });
  beforeEach(async () => {
    fixture = await createDeepScanFixture(compiled);
  });
  afterEach(async () => {
    await fixture.close();
  });
  afterAll(() => compiled.remove());
  const scanPath = "/api/library/roots/fixture/scan";
  const listPath = "/api/public/library/list?limit=1&sort=title&offset=500";

  it("serves parallel reads during held upstream pagination, shares scans and refreshes cached inventory", async () => {
    expect(await fixture.request(scanPath, "POST")).toMatchObject({ status: 200, body: { discoveredCount: 501 } });
    const before = await fixture.request(listPath);
    expect(before.body).toMatchObject({ total: 501, items: [{ title: "Work 500" }] });
    const oldId = before.body.items[0].id as string;
    expect((await fixture.request(`/api/public/library/detail?id=${encodeURIComponent(oldId)}`)).status).toBe(200);
    await fixture.request("/api/library/roots/fixture/inventory"); // Prime serialized admin inventory.
    fixture.change();
    const held = fixture.holdSecondPage();
    let completed = false;
    const first = fixture.request(scanPath, "POST").then((result) => {
      completed = true;
      return result;
    });
    await held.entered;
    const second = fixture.request(scanPath, "POST");
    const started = performance.now();
    const reads = await Promise.all([
      fixture.request("/api/tasks"),
      fixture.request("/api/library/roots/fixture/works?pageSize=1"),
      fixture.request(listPath),
      fixture.request("/health"),
    ]);
    expect(reads.map((result) => result.status)).toEqual([200, 200, 200, 200]);
    expect(reads[2]!.body.items[0].title).toBe("Work 500");
    expect(completed).toBe(false); // Causal evidence: responses arrived before releasing the upstream.
    console.info(`deep_scan_held_read_batch_ms=${Math.round(performance.now() - started)}`);
    held.release();
    expect((await Promise.all([first, second])).map((result) => result.status)).toEqual([200, 200]);
    expect(fixture.offsets).toEqual([0, 500, 0, 500]);
    expect(fixture.handle.db.select().from(libraryScanRuns).all()).toHaveLength(2);
    await expect
      .poll(async () => (await fixture.request(listPath)).body.items[0]?.title, { timeout: 4000 })
      .toBe("Work 501");
    expect((await fixture.request(`/api/public/library/detail?id=${encodeURIComponent(oldId)}`)).status).toBe(404);
    const after = await fixture.request(listPath);
    expect(
      (await fixture.request(`/api/public/library/detail?id=${encodeURIComponent(after.body.items[0].id)}`)).body.title,
    ).toBe("Work 501");
    const inventory = (await fixture.request("/api/library/roots/fixture/inventory")).body.items;
    expect(inventory.some((item: { sourceTitle: string }) => item.sourceTitle === "Work 500")).toBe(false);
    expect(inventory.some((item: { sourceTitle: string }) => item.sourceTitle === "Work 501")).toBe(true);
  });

  it.each(["truncated", "failure", "empty"] as const)(
    "retains exact inventory after %s upstream and hides disabled roots without deletion",
    async (mode) => {
      await fixture.request(scanPath, "POST");
      const original = fixture.handle.db.select().from(libraryItems).all();
      fixture.mode(mode);
      // A certified empty upstream is reported successfully but cannot clear a nonempty inventory.
      expect((await fixture.request(scanPath, "POST")).status).toBe(mode === "empty" ? 200 : 500);
      expect(fixture.handle.db.select().from(libraryItems).all()).toEqual(original);
      expect((await fixture.request(listPath)).body.total).toBe(501);
      const root = fixture.handle.db.select().from(mediaRoots).get()!;
      fixture.handle.db.update(mediaRoots).set({ enabled: false }).where(eq(mediaRoots.id, root.id)).run();
      expect((await fixture.request(listPath)).body).toMatchObject({ total: 0, items: [] });
      expect((await fixture.request("/api/library/roots/fixture/inventory")).status).toBe(404);
      expect((await fixture.request("/api/library/roots")).body.roots).toEqual([]);
      expect(fixture.handle.db.select().from(libraryItems).all()).toEqual(original);
      fixture.handle.db.update(mediaRoots).set({ enabled: true }).where(eq(mediaRoots.id, root.id)).run();
      expect((await fixture.request(listPath)).body.total).toBe(501);
    },
  );

  it("serves reads while another connection holds the write lock and drains deferred request logs afterwards", async () => {
    await fixture.request(scanPath, "POST");
    await fixture.request(listPath);
    const lock = new BetterSqlite3(fixture.databasePath, { timeout: 0 });
    lock.exec("BEGIN IMMEDIATE");
    const before = fixture.handle.db.select().from(logs).all().length;
    try {
      const started = performance.now();
      const results = await Promise.all([
        fixture.request("/api/tasks"),
        fixture.request(listPath),
        fixture.request("/api/library/roots"),
      ]);
      expect(results.map((result) => result.status)).toEqual([200, 200, 200]);
      expect(fixture.handle.db.select().from(logs).all()).toHaveLength(before);
      console.info(`deep_scan_locked_read_batch_ms=${Math.round(performance.now() - started)}`);
    } finally {
      lock.exec("COMMIT");
      lock.close();
    }
    await expect
      .poll(() => fixture.handle.db.select().from(logs).all().length, { timeout: 3000 })
      .toBeGreaterThanOrEqual(before + 3);
  });
});
