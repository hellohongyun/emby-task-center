import { describe, expect, it, vi } from "vitest";
import { createLibraryService } from "./service";
import type { ScannedMediaItem } from "./scan-types";

function deferred() {
  let resolve!: (items: readonly ScannedMediaItem[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<readonly ScannedMediaItem[]>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const roots = [
  { id: "first", name: "库一", mediaType: "tv" as const, path: "emby:first" },
  { id: "second", name: "库二", mediaType: "tv" as const, path: "emby:second" },
];

describe("library service concurrent scans", () => {
  it("returns the exact same promise to simultaneous callers for one root", async () => {
    const pending = deferred();
    const scan = vi.fn(() => pending.promise);
    const service = createLibraryService(roots, scan);
    const first = service.scanRoot("first");
    const second = service.scanRoot("first");
    expect(first).toBe(second);
    expect(scan).toHaveBeenCalledTimes(1);
    pending.resolve([]);
    await expect(first).resolves.toMatchObject({ root: { id: "first" }, items: [] });
    const next = service.scanRoot("first");
    expect(next).not.toBe(first);
    await next;
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("shares failures and allows another scan after failure", async () => {
    const pending = deferred();
    const scan = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue([]);
    const service = createLibraryService(roots, scan);
    const first = service.scanRoot("first");
    const second = service.scanRoot("first");
    const rejected = expect(first).rejects.toThrow("upstream unavailable");
    expect(second).toBe(first);
    pending.reject(new Error("upstream unavailable"));
    await rejected;
    await expect(service.scanRoot("first")).resolves.toMatchObject({ root: { id: "first" } });
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("does not coalesce different roots", async () => {
    const firstPending = deferred();
    const secondPending = deferred();
    const scan = vi.fn((path: string) => (path === roots[0]!.path ? firstPending.promise : secondPending.promise));
    const service = createLibraryService(roots, scan);
    const first = service.scanRoot("first");
    const second = service.scanRoot("second");
    expect(first).not.toBe(second);
    expect(scan).toHaveBeenCalledTimes(2);
    firstPending.resolve([]);
    secondPending.resolve([]);
    await Promise.all([first, second]);
  });
});
