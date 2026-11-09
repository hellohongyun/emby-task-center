import { afterEach, describe, expect, it, vi } from "vitest";

import { transfer115Share } from "./tgtodrive-share115";

const options = {
  baseUrl: "https://tgtodrive.test/app/",
  token: "tgto_example_token",
  shareUrl: "https://115.com/s/example?password=0123",
};

const completed = {
  provider: "115",
  mode: "share",
  success: true,
  target: { folder_id: "9999999999999999999" },
  transfer: { selected_count: 1 },
};

describe("TgtoDrive 115 transfer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the verified no-points request and recognizes the observed already-owned result", async () => {
    const fetchTransfer = vi.fn().mockResolvedValue(
      Response.json({
        success: true,
        data: { ...completed, already_owned: true },
      }),
    );
    vi.stubGlobal("fetch", fetchTransfer);

    await expect(transfer115Share(options)).resolves.toMatchObject({
      status: "already_exists",
      targetFolderId: "9999999999999999999",
    });
    expect(fetchTransfer).toHaveBeenCalledExactlyOnceWith(
      "https://tgtodrive.test/app/api/media/resources/transfer",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer tgto_example_token" }),
        redirect: "manual",
        body: JSON.stringify({
          provider: "115",
          source: "guanying",
          share_url: options.shareUrl,
          enforce_points_limit: true,
          max_points: 0,
        }),
      }),
    );
  });

  it("reports a completed transfer with a title when the upstream explicitly returns one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ success: true, data: { ...completed, share_title: "影片目录" } })),
    );
    await expect(transfer115Share(options)).resolves.toMatchObject({ status: "saved", shareTitle: "影片目录" });
  });

  it.each([
    ["queued", Response.json({ success: true, data: completed }, { status: 202 })],
    ["generic success", Response.json({ success: true })],
    ["server error", Response.json({ success: false }, { status: 502 })],
    ["invalid JSON", new Response("<html>Gateway response</html>")],
    ["redirect", Response.redirect("https://elsewhere.test", 307)],
  ])("does not report a final outcome for %s", async (_scenario, response) => {
    const fetchTransfer = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchTransfer);

    await expect(transfer115Share(options)).resolves.toMatchObject({ status: "unconfirmed" });
    expect(fetchTransfer).toHaveBeenCalledTimes(1);
  });

  it("uses curated failure messages without echoing upstream secrets", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ success: false, code: options.token, error: options.shareUrl }, { status: 401 }),
        ),
    );
    const result = await transfer115Share(options);
    expect(result).toMatchObject({ status: "failed", resultCode: "TGTO_ACCESS_DENIED" });
    expect(JSON.stringify(result)).not.toContain(options.token);
    expect(JSON.stringify(result)).not.toContain(options.shareUrl);
  });
});
