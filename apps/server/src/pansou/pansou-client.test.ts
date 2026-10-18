import { afterEach, describe, expect, it, vi } from "vitest";

import { createPansouClient } from "./pansou-client";

afterEach(() => vi.unstubAllGlobals());

describe("PanSou explicit upstream configuration", () => {
  it.each([undefined, "", "   "])("does not send a request when the upstream is %j", async (baseUrl) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(createPansouClient({ baseUrl }).search("示例影片")).rejects.toThrow("pansou_not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses only the explicitly configured upstream and encodes search terms", async () => {
    const body = { code: 0, message: "success", data: { total: 0, merged_by_type: {} } };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(body));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createPansouClient({ baseUrl: "https://pansou.example.invalid/", src: "plugin" }).search("a & b"),
    ).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://pansou.example.invalid/api/search?kw=a%20%26%20b&src=plugin");
  });
});
