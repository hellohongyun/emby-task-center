import { describe, expect, it, vi } from "vitest";

import { runProgressScanCycle } from "./progress-scan-cycle";

function step(events: string[], name: string) {
  return vi.fn(async () => {
    events.push(name);
  });
}

describe("progress scan cycle", () => {
  it("confirms inventory before notification", async () => {
    const events: string[] = [];
    await runProgressScanCycle({
      scanEnabled: true,
      refreshProgress: step(events, "refresh"),
      scanIfDue: step(events, "scan"),
      notifyPending: step(events, "notify"),
    });
    expect(events).toEqual(["refresh", "scan", "notify"]);
  });

  it("does not trigger a scan when the library interval is disabled", async () => {
    const events: string[] = [];
    const scanIfDue = step(events, "scan");
    await runProgressScanCycle({
      scanEnabled: false,
      refreshProgress: step(events, "refresh"),
      scanIfDue,
      notifyPending: step(events, "notify"),
    });
    expect(scanIfDue).not.toHaveBeenCalled();
    expect(events).toEqual(["refresh", "notify"]);
  });

  it("does not notify from stale inventory when the confirming scan fails", async () => {
    const notifyPending = vi.fn(async () => undefined);
    await expect(
      runProgressScanCycle({
        scanEnabled: true,
        refreshProgress: async () => undefined,
        scanIfDue: async () => {
          throw new Error("scan failed");
        },
        notifyPending,
      }),
    ).rejects.toThrow("scan failed");
    expect(notifyPending).not.toHaveBeenCalled();
  });
});
