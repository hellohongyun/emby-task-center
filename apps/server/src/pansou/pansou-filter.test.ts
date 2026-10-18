import { describe, expect, it } from "vitest";

import type { PansouRawItem } from "./pansou-client";
import {
  DEFAULT_ENABLED_PLATFORMS,
  filterAndRankResources,
  isUsableResource,
  maskNote,
  scoreNote,
  type PansouPlatformKey,
} from "./pansou-filter";

function item(url: string, note: string, source = "plugin:lingjisp", _platform?: PansouPlatformKey): PansouRawItem {
  return { url, note, source, password: "" };
}

function dataGroup(entries: Array<[PansouPlatformKey, PansouRawItem[]]>): Record<string, PansouRawItem[]> {
  const out: Record<string, PansouRawItem[]> = {};
  for (const [key, items] of entries) out[key] = items;
  return out;
}

describe("pansou filter", () => {
  it("masks netdisk names in notes", () => {
    expect(maskNote("光鸭云盘资源，123云盘备用，夸克网盘也有一份")).toBe("xxx资源，xxx备用，xxx也有一份");
  });

  it("scores spec-clarity, higher for rich specs", () => {
    const rich =
      "肖申克的救赎[HDR+杜比视界双版本][国英多音轨+特效中文字幕].1994.EUR.BluRay.2160p.DTS-HDMA5.1.DoVi.HDR10.x265.10bit-DreamHD";
    const poor = "肖申克的救赎";
    expect(scoreNote(rich)).toBeGreaterThan(scoreNote(poor));
    expect(scoreNote(poor)).toBeLessThan(20);
  });

  it("flags unusable resources (dead note / bad link)", () => {
    expect(isUsableResource("other", item("https://www.guangyapan.com/s/1", "肖申克的救赎"))).toBe(true);
    expect(isUsableResource("magnet", item("magnet:?xt=urn:btih:ABC", "肖申克的救赎"))).toBe(true);
    expect(isUsableResource("magnet", item("https://example.com", "肖申克的救赎"))).toBe(false);
    expect(isUsableResource("123", item("https://www.123pan.com/s/1", "链接已失效"))).toBe(false);
  });

  it("shows only enabled platforms (115 + 磁力 by default), with netdisk before magnet", () => {
    const data = dataGroup([
      ["115", [item("https://115.com/s/1", "115资源A")]],
      ["magnet", [item("magnet:?xt=urn:btih:1", "磁力B")]],
      ["123", [item("https://www.123pan.com/s/2", "123资源C")]],
      ["other", [item("https://www.guangyapan.com/s/1", "光鸭资源D")]],
    ]);
    const resources = filterAndRankResources(data, { enabledPlatforms: DEFAULT_ENABLED_PLATFORMS });
    const platforms = new Set(resources.map((r) => r.platformKey));
    // 默认启用：115 网盘 + 磁力。
    expect(platforms.has("115")).toBe(true);
    expect(platforms.has("magnet")).toBe(true);
    // 默认关闭的平台（123 / 光鸭）不参与返回，即便原始数据里有资源。
    expect(platforms.has("123")).toBe(false);
    expect(platforms.has("other")).toBe(false);
    // 网盘排到磁力前（无观影时）。
    expect(
      resources.every((r, i) => i === 0 || resources[i - 1]!.displayType !== "磁力" || r.displayType === "磁力"),
    ).toBe(true);
    const firstNetdisk = resources.findIndex((r) => r.displayType === "网盘");
    const firstMagnet = resources.findIndex((r) => r.displayType === "磁力");
    expect(firstNetdisk).toBeGreaterThanOrEqual(0);
    if (firstMagnet >= 0) expect(firstNetdisk).toBeLessThan(firstMagnet);
  });

  it("extracts video size from the note", () => {
    const data = dataGroup([["magnet", [item("magnet:?xt=urn:btih:1", "流浪地球2 [4K] [59.8GB] 国语配音")]]]);
    const resources = filterAndRankResources(data);
    expect(resources[0]?.size).toBe("59.8GB");
  });

  it("extracts exact size from a magnet xl parameter when note has none", async () => {
    const data = dataGroup([
      [
        "magnet",
        [
          {
            url: "magnet:?xt=urn:btih:1&dn=title&xl=6422528000",
            note: "流浪地球2",
            source: "plugin:lingjisp",
            password: "",
          },
        ],
      ],
    ]);
    const resources = filterAndRankResources(data);
    expect(resources[0]?.size).toBe("6.0GB");
  });

  it("puts 观影 (gying) resources first, then by score", () => {
    const data = dataGroup([
      [
        "magnet",
        [
          item("magnet:?xt=urn:btih:2", "低质磁力"),
          item("magnet:?xt=urn:btih:1", "观影磁力 4K HDR10 国英双语 特种字幕", "plugin:gying"),
        ],
      ],
    ]);
    const resources = filterAndRankResources(data);
    expect(resources[0]?.isGying).toBe(true);
  });
});
