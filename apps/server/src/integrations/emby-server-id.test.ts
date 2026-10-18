import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmbyClient } from "./emby-client";
import { createCachedEmbyServerId } from "./emby-server-id";

const settled = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());
describe("nonblocking Emby server ID", () => {
  it("returns immediately and shares the cold request", async () => {
    let resolve!: (value: { id: string }) => void;
    const systemInfo = vi.fn(
      () =>
        new Promise<{ id: string }>((done) => {
          resolve = done;
        }),
    );
    const read = createCachedEmbyServerId({ configured: true, systemInfo } as unknown as EmbyClient, () => "a");
    expect(read()).toBeNull();
    expect(read()).toBeNull();
    await settled();
    expect(systemInfo).toHaveBeenCalledTimes(1);
    resolve({ id: "server-a" });
    await settled();
    expect(read()).toBe("server-a");
  });
  it("keeps a stale ID on failure and backs off its refresh", async () => {
    vi.useFakeTimers();
    const systemInfo = vi.fn().mockResolvedValueOnce({ id: "server-a" }).mockRejectedValue(new Error("offline"));
    const read = createCachedEmbyServerId({ configured: true, systemInfo } as unknown as EmbyClient, () => "a");
    read();
    await settled();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(read()).toBe("server-a");
    await settled();
    expect(read()).toBe("server-a");
    expect(systemInfo).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(read()).toBe("server-a");
    await settled();
    expect(systemInfo).toHaveBeenCalledTimes(3);
  });
  it("ignores the old server response after a connection change", async () => {
    let key = "a";
    let resolve!: (value: { id: string }) => void;
    const systemInfo = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValueOnce({ id: "server-b" });
    const read = createCachedEmbyServerId({ configured: true, systemInfo } as unknown as EmbyClient, () => key);
    read();
    await settled();
    key = "b";
    read();
    await settled();
    expect(read()).toBe("server-b");
    resolve({ id: "server-a" });
    await settled();
    expect(read()).toBe("server-b");
  });
});
