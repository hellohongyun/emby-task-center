import express from "express";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createDatabase } from "@emby-task-center/database/client";
import { mediaRoots } from "@emby-task-center/database/schema";
import type { MissingEpisodeScanner } from "../library/missing-episode-scan";
import { registerMissingEpisodeRoutes } from "./missing-episodes";

describe("missing episode inventory diagnostics", () => {
  it.each([
    ["failed", "2026-10-18T00:00:00Z", "scan_failed"],
    [null, null, "not_scanned"],
    ["completed", "2026-10-18T00:00:00Z", null],
  ] as const)("reports %s inventory independently of zero missing results", async (status, scannedAt, issue) => {
    const database = createDatabase(":memory:");
    const timestamp = "2026-10-18T00:00:00Z";
    database.db
      .insert(mediaRoots)
      .values({
        name: "库存状态测试",
        containerPath: "emby:public-root",
        mediaType: "tv",
        lastScanStatus: status,
        lastScannedAt: scannedAt,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    const app = express();
    registerMissingEpisodeRoutes(app, {
      database: database.db,
      scanner: {
        status: () => ({ running: false, processed: 0, total: 0, metadataIssues: [] }),
        run: vi.fn(),
      } as unknown as MissingEpisodeScanner,
    });
    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/missing-episodes`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        rootId: "public-root",
        inventoryIssue: issue,
        showCount: 0,
        episodeCount: 0,
        shows: [],
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      database.close();
    }
  });
});
