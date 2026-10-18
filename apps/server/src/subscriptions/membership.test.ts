import { describe, expect, it } from "vitest";

import { memberConcurrencyStatus } from "./membership";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");

function state(data: { overshootSince?: string | null; notifiedAt?: string | null; disabledUntil?: string | null }) {
  return { ...data } as never;
}

describe("memberConcurrencyStatus", () => {
  it("未设上限时视为正常（不参与并发管控）", () => {
    expect(memberConcurrencyStatus({ embyMaxStreams: null }, undefined, new Date(NOW))).toEqual({
      overshooting: false,
      notified: false,
      disabled: false,
      disabledUntil: null,
      remainingMs: null,
    });
    expect(memberConcurrencyStatus({ embyMaxStreams: 0 }, undefined, new Date(NOW))).toEqual({
      overshooting: false,
      notified: false,
      disabled: false,
      disabledUntil: null,
      remainingMs: null,
    });
  });

  it("无记录：正常", () => {
    expect(memberConcurrencyStatus({ embyMaxStreams: 2 }, undefined, new Date(NOW))).toEqual({
      overshooting: false,
      notified: false,
      disabled: false,
      disabledUntil: null,
      remainingMs: null,
    });
  });

  it("已超限但未提醒", () => {
    expect(
      memberConcurrencyStatus(
        { embyMaxStreams: 2 },
        state({ overshootSince: new Date(NOW - 1000).toISOString() }),
        new Date(NOW),
      ),
    ).toEqual({
      overshooting: true,
      notified: false,
      disabled: false,
      disabledUntil: null,
      remainingMs: null,
    });
  });

  it("已超限且已提醒", () => {
    expect(
      memberConcurrencyStatus(
        { embyMaxStreams: 2 },
        state({ overshootSince: new Date(NOW - 1000).toISOString(), notifiedAt: new Date(NOW - 500).toISOString() }),
        new Date(NOW),
      ),
    ).toEqual({
      overshooting: true,
      notified: true,
      disabled: false,
      disabledUntil: null,
      remainingMs: null,
    });
  });

  it("因超限暂停（含剩余时间）", () => {
    const until = new Date(NOW + 3 * 3_600_000).toISOString();
    const result = memberConcurrencyStatus({ embyMaxStreams: 2 }, state({ disabledUntil: until }), new Date(NOW));
    expect(result.disabled).toBe(true);
    expect(result.disabledUntil).toBe(until);
    expect(result.remainingMs).toBe(3 * 3_600_000);
  });
});
