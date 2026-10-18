import { describe, expect, it } from "vitest";

import { createRateLimiter } from "./rate-limit";

describe("createRateLimiter", () => {
  it("allows up to the limit per window and blocks afterwards", () => {
    const limiter = createRateLimiter(3, 60_000);
    const key = "ip:1";
    expect(limiter.check(key, 1_000)).toBe(true);
    expect(limiter.check(key, 2_000)).toBe(true);
    expect(limiter.check(key, 3_000)).toBe(true);
    expect(limiter.check(key, 4_000)).toBe(false);
  });

  it("reopens the window after it expires", () => {
    const limiter = createRateLimiter(2, 60_000);
    const key = "ip:2";
    expect(limiter.check(key, 1_000)).toBe(true);
    expect(limiter.check(key, 2_000)).toBe(true);
    expect(limiter.check(key, 3_000)).toBe(false);
    expect(limiter.check(key, 70_000)).toBe(true);
  });

  it("keeps independent counters per key", () => {
    const limiter = createRateLimiter(1, 60_000);
    expect(limiter.check("a", 1_000)).toBe(true);
    expect(limiter.check("a", 2_000)).toBe(false);
    expect(limiter.check("b", 3_000)).toBe(true);
  });
});
