import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "@emby-task-center/database/client";
import type { EmbyClient } from "../integrations/emby-client";
import { StreamLimitResolver } from "./stream-limits";

afterEach(() => vi.useRealTimers());
describe("watchdog administrator cache", () => {
  it("reuses administrator data across ticks while applying changed default limits", async () => {
    vi.useFakeTimers();
    const handle = createDatabase(":memory:");
    try {
      const listUsers = vi.fn().mockResolvedValue([{ Id: "admin", Policy: { IsAdministrator: true } }]);
      const resolver = new StreamLimitResolver(handle.db, { listUsers } as unknown as EmbyClient);
      for (let tick = 0; tick < 10; tick++) {
        resolver.configure(1, "connection-a");
        expect(await resolver.limitFor("admin")).toBeNull();
        expect(await resolver.limitFor("member")).toBe(1);
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(listUsers).toHaveBeenCalledTimes(1);
      resolver.configure(3, "connection-a");
      expect(await resolver.limitFor("member")).toBe(3);
      expect(listUsers).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_001);
      await resolver.limitFor("member");
      expect(listUsers).toHaveBeenCalledTimes(2);
    } finally {
      handle.close();
    }
  });
  it("drops old administrator identities when switching the Emby connection", async () => {
    const handle = createDatabase(":memory:");
    try {
      const listUsers = vi
        .fn()
        .mockResolvedValueOnce([{ Id: "admin", Policy: { IsAdministrator: true } }])
        .mockResolvedValueOnce([]);
      const resolver = new StreamLimitResolver(handle.db, { listUsers } as unknown as EmbyClient);
      resolver.configure(1, "connection-a");
      expect(await resolver.limitFor("admin")).toBeNull();
      resolver.configure(1, "connection-b");
      expect(await resolver.limitFor("admin")).toBe(1);
      expect(listUsers).toHaveBeenCalledTimes(2);
    } finally {
      handle.close();
    }
  });
});
