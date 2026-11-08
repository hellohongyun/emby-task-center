import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDatabase } from "./client";
import { mediaRequests } from "./schema";
import { reconcileMediaRequests } from "./media-requests-reconcile";

describe("legacy media request retention timestamp upgrade", () => {
  it("backfills only once from valid historical available updatedAt, preserving every old row without cleanup", () => {
    const handle = createDatabase(":memory:");
    try {
      // Simulate the previous schema inside a throwaway fixture, never an actual user database.
      handle.db.run(sql`DROP INDEX media_requests_available_idx`);
      handle.db.run(sql`ALTER TABLE media_requests DROP COLUMN available_at`);
      const versions = [
        "2020-01-01T00:00:00.000Z",
        "2026-10-01T08:00:00+08:00",
        "2026-02-30T00:00:00.000Z",
        "invalid",
        "2020-01-01T00:00:00.000Z",
      ];
      versions.forEach((updated, index) => {
        const status = index === 4 ? "unavailable" : "available";
        handle.db
          .run(sql`INSERT INTO media_requests(member_id,member_email,kind,media_type,tmdb_id,title,original_title,status,created_at,updated_at)
          VALUES(1,'fixture@example.invalid','request','movie',${index + 1},'fixture','fixture',${status},'2000-01-01',${updated})`);
      });
      reconcileMediaRequests(handle.db);
      const rows = handle.db.select().from(mediaRequests).all();
      expect(rows).toHaveLength(5);
      expect(rows.map((row) => row.availableAt)).toEqual([
        "2020-01-01T00:00:00.000Z",
        "2026-10-01T00:00:00.000Z",
        null,
        null,
        null,
      ]);
      handle.db
        .update(mediaRequests)
        .set({ availableAt: null, updatedAt: "2030-01-01T00:00:00.000Z" })
        .where(eq(mediaRequests.id, rows[0]!.id))
        .run();
      reconcileMediaRequests(handle.db);
      expect(handle.db.select().from(mediaRequests).all()[0]!.availableAt).toBeNull();
      expect(handle.db.select().from(mediaRequests).all()).toHaveLength(5);
      expect(
        handle.db
          .all<{ name: string }>(sql`PRAGMA index_info(media_requests_available_idx)`)
          .map((column) => column.name),
      ).toEqual(["status", "available_at"]);
    } finally {
      handle.close();
    }
  });
});
