import { describe, expect, it } from "vitest";

import { calculateMissing } from "./gap-calculator";

describe("calculateMissing", () => {
  it("finds an episode missing below the highest stored episode", () => {
    expect(calculateMissing([147, 148, 149, 150], [147, 148, 150])).toEqual([149]);
  });

  it("uses a set difference regardless of input order or duplicates", () => {
    expect(calculateMissing([3, 1, 2, 2], [3, 1, 3])).toEqual([2]);
  });
});
