import { describe, expect, it } from "vitest";
import { CreateTaskSchema } from "./task";

describe("CreateTaskSchema", () => {
  // 追更已整体下线（2026-09）：follow 不再是合法任务类型，历史调用方也必须被拒。
  it("rejects the retired follow task type", () => {
    const result = CreateTaskSchema.safeParse({
      mediaType: "tv",
      taskType: "follow",
      title: "Arrival",
      tmdbId: 329865,
    });

    expect(result.success).toBe(false);
  });

  it("rejects blank titles", () => {
    const result = CreateTaskSchema.safeParse({
      mediaType: "tv",
      taskType: "ingest",
      title: "   ",
      tmdbId: 1396,
    });

    expect(result.success).toBe(false);
  });
});
