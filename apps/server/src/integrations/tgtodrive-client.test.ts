import { afterEach, describe, expect, it, vi } from "vitest";

import { createTgtoDriveClient, createTgtoDriveClientFromConfig } from "./tgtodrive-client";

function loginResponse(): Response {
  const headers = new Headers({ "content-type": "application/json" });
  headers.append("set-cookie", "acw_tc=abc; Path=/");
  headers.append("set-cookie", "session=xyz; Path=/");
  return new Response(JSON.stringify({ success: true }), { status: 200, headers });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** 与真实 /api/media/resources/search 一致的 snake_case 载荷。 */
function rawItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "肖申克的救赎.1994.BluRay.2160p",
    size: "8.63 GB",
    link_type: "magnet",
    provider: "offline",
    share_url: "magnet:?xt=urn:btih:AAA",
    resource_url: "",
    supported_targets: ["115", "123", "guangya"],
    item_key: "tg:123",
    quality: "BluRay",
    subtitle_languages: [],
    ...overrides,
  };
}

describe("tgtodrive client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is disabled when credentials are missing", () => {
    expect(createTgtoDriveClientFromConfig({ baseUrl: "", username: "", password: "" })).toBeUndefined();
  });

  it("constructs a configured client when baseUrl/account are present", () => {
    const client = createTgtoDriveClientFromConfig({
      baseUrl: "https://tgtodrive.test",
      username: "user",
      password: "pass",
    });
    expect(client?.configured).toBe(true);
  });

  describe("searchResources", () => {
    function stubSearch(payload: unknown): void {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce(loginResponse()).mockResolvedValueOnce(jsonResponse(payload)),
      );
    }

    it("maps the snake_case API payload onto camelCase hits", async () => {
      stubSearch({
        success: true,
        data: {
          items: [
            rawItem(),
            rawItem({
              title: "肖申克的救赎 4K 国语",
              size: "",
              link_type: "share",
              provider: "123",
              share_url: "https://1838584479.share.123pan.cn/s/1",
              resource_url: "https://1838584479.share.123pan.cn/s/1",
              supported_targets: ["123"],
              item_key: "seedhub:9",
              quality: "其他",
            }),
          ],
        },
      });
      const client = createTgtoDriveClient({ baseUrl: "https://tgtodrive.test", username: "u", password: "p" });

      const hits = await client.searchResources({ title: "肖申克的救赎", mediaType: "movie", year: 1994 });

      expect(hits).toHaveLength(2);
      // 回归防线：API 是 snake_case，按 camelCase 直读会全是 undefined，链接丢失后资源会被整条丢弃。
      expect(hits[0]?.shareUrl).toBe("magnet:?xt=urn:btih:AAA");
      expect(hits[0]?.linkType).toBe("magnet");
      expect(hits[0]?.provider).toBe("offline");
      expect(hits[0]?.supportedTargets).toEqual(["115", "123", "guangya"]);
      expect(hits[0]?.itemKey).toBe("tg:123");
      expect(hits[0]?.quality).toBe("BluRay");
      expect(hits[1]?.linkType).toBe("share");
      expect(hits[1]?.provider).toBe("123");
      expect(hits[1]?.supportedTargets).toEqual(["123"]);
    });

    it("accepts supported_targets as a comma-joined string", async () => {
      stubSearch({ success: true, data: { items: [rawItem({ supported_targets: "115,123,guangya" })] } });
      const client = createTgtoDriveClient({ baseUrl: "https://tgtodrive.test", username: "u", password: "p" });

      const hits = await client.searchResources({ title: "肖申克的救赎" });
      expect(hits[0]?.supportedTargets).toEqual(["115", "123", "guangya"]);
    });

    it("drops items without a title and tolerates an empty result", async () => {
      stubSearch({ success: true, data: { items: [rawItem({ title: "" })] } });
      const client = createTgtoDriveClient({ baseUrl: "https://tgtodrive.test", username: "u", password: "p" });

      await expect(client.searchResources({ title: "x" })).resolves.toEqual([]);

      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(loginResponse())
          .mockResolvedValueOnce(jsonResponse({ success: true, data: {} })),
      );
      await expect(client.searchResources({ title: "x" })).resolves.toEqual([]);
    });
  });
});
