import { describe, expect, it, vi } from "vitest";
import { createDatabase } from "@emby-task-center/database/client";
import type { EmbyClient } from "../integrations/emby-client";
import { linkOrphanEmbyUsers } from "../subscriptions/emby-member-sync";
import { syncEmbyActivityLog } from "../usage/activity-log";

function deferred() {
  let resolve!: (value: []) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<[]>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("manual and scheduled service calls share a database round", () => {
  for (const name of ["activity", "link"] as const) {
    it(`${name} keeps independent database rounds separate`, async () => {
      const firstDatabase = createDatabase(":memory:");
      const secondDatabase = createDatabase(":memory:");
      try {
        const pending = deferred();
        const upstream = vi.fn().mockReturnValue(pending.promise);
        const emby = { configured: true, listUsers: upstream, listActivityLog: upstream } as unknown as EmbyClient;
        const run = (database: typeof firstDatabase.db) =>
          name === "activity" ? syncEmbyActivityLog(database, emby) : linkOrphanEmbyUsers(database, emby);
        const first = run(firstDatabase.db);
        const second = run(secondDatabase.db);
        expect(first).not.toBe(second);
        expect(upstream).toHaveBeenCalledTimes(2);
        pending.resolve([]);
        await Promise.all([first, second]);
      } finally {
        firstDatabase.close();
        secondDatabase.close();
      }
    });

    it.each(["resolve", "reject"])(`${name} joins concurrent calls and releases after %s`, async (outcome) => {
      const database = createDatabase(":memory:");
      try {
        const pending = deferred();
        const upstream = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue([]);
        const emby = { configured: true, listUsers: upstream, listActivityLog: upstream } as unknown as EmbyClient;
        const run = () =>
          name === "activity" ? syncEmbyActivityLog(database.db, emby) : linkOrphanEmbyUsers(database.db, emby);
        const first = run();
        const second = run();
        expect(first).toBe(second);
        expect(upstream).toHaveBeenCalledTimes(1);
        const completion = Promise.allSettled([first, second]);
        if (outcome === "resolve") pending.resolve([]);
        else pending.reject(new Error("upstream unavailable"));
        const results = await completion;
        // Member linking intentionally treats an unreachable Emby as an empty result.
        expect(
          results.every(
            (item) => item.status === (name === "activity" && outcome === "reject" ? "rejected" : "fulfilled"),
          ),
        ).toBe(true);
        await run();
        expect(upstream).toHaveBeenCalledTimes(2);
      } finally {
        database.close();
      }
    });
  }
});
