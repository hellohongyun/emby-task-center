import { describe, expect, it } from "vitest";
import { createScanRetryGate } from "./scan-retry";

describe("scan retry gate", () => {
  it("backs off repeated failures up to 30 minutes and resets after success", () => {
    let now = 1_000;
    const gate = createScanRetryGate(() => now);
    expect(gate.canAttempt()).toBe(true);
    for (const minutes of [1, 2, 4, 8, 16, 30, 30]) {
      gate.failed();
      expect(gate.canAttempt()).toBe(false);
      now += minutes * 60_000 - 1;
      expect(gate.canAttempt()).toBe(false);
      now += 1;
      expect(gate.canAttempt()).toBe(true);
    }
    gate.succeeded();
    expect(gate.canAttempt()).toBe(true);
    gate.failed();
    now += 60_000;
    expect(gate.canAttempt()).toBe(true);
  });
});
