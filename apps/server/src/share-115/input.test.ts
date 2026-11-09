import { describe, expect, it } from "vitest";
import { MAX_SHARE_115_BATCH, parseShare115Batch } from "./input";

describe("115 share paste parser", () => {
  it("reads each link's code from the URL or an adjacent code label, ignoring other sites", () => {
    const text = [
      "作品 A：<https://115.com/s/alpha?password=A123>，https://115.com/s/beta 提取码：B234",
      "其他链接 https://example.test/s/nope 提取码：X999 和 115 帮助 https://115.com/help",
      "作品 C：[分享](https://115cdn.com/s/gamma)",
      "访问码：C345. 请在网盘中打开",
      "访问码：D456 https://115.com/s/delta",
      "https://115.com/s/epsilon",
    ].join("\n");
    const result = parseShare115Batch(text);
    expect(result).toMatchObject({
      entries: [
        { index: 1, link: { shareCode: "alpha", accessCode: "A123" } },
        { index: 2, link: { shareCode: "beta", accessCode: "B234" } },
        { index: 3, link: { shareUrl: "https://115.com/s/gamma?password=C345", accessCode: "C345" } },
        { index: 4, link: { shareCode: "delta", accessCode: "D456" } },
        { index: 5, link: { shareCode: "epsilon", accessCode: "" } },
      ],
    });
  });

  it("returns separate errors and retry text for a conflict and an invalid share path", () => {
    const result = parseShare115Batch(
      "https://115.com/s/first?password=A123 访问码：B234\nhttps://115.com/s/\nhttps://115.com/s/third",
    );
    expect(result).toMatchObject({
      entries: [
        {
          index: 1,
          error: "conflicting_access_code",
          retryText: "https://115.com/s/first?password=A123\n访问码：B234",
        },
        { index: 2, error: "invalid_share_link", retryText: "https://115.com/s/" },
        { index: 3, link: { shareCode: "third", accessCode: "" } },
      ],
    });
  });

  it("collapses a duplicated Markdown label and accepts the separate code field for one link", () => {
    const url = "https://115.com/s/alpha";
    expect(parseShare115Batch(`[${url}](${url})`, "A123")).toMatchObject({
      entries: [{ index: 1, link: { shareUrl: url + "?password=A123", accessCode: "A123" } }],
    });
    expect(parseShare115Batch("提取码：A123\n" + url)).toMatchObject({
      entries: [{ index: 1, link: { accessCode: "A123" } }],
    });
    expect(parseShare115Batch(url + "\n分享说明\n\n访问码：A123")).toMatchObject({
      entries: [{ index: 1, link: { accessCode: "A123" } }],
    });
  });

  it("requires per-link codes for batches and caps the number of links", () => {
    const links = Array.from({ length: MAX_SHARE_115_BATCH + 1 }, (_, index) => "https://115.com/s/alpha" + index);
    expect(parseShare115Batch(links.join("\n"))).toEqual({ error: "too_many_share_links" });
    expect(parseShare115Batch(links.slice(0, 2).join("\n"), "A123")).toEqual({
      error: "access_code_requires_single_link",
    });
    expect(parseShare115Batch("https://115.com.example.test/s/alpha")).toEqual({ error: "invalid_share_link" });
  });

  it("handles numbered paste, Markdown destinations, invisible separators and a code before a new paragraph", () => {
    expect(
      parseShare115Batch(
        [
          "1. 链接：[https://115.com/s/alpha](https://115.com/s/alpha?password=A123)",
          "2. 链接：https://115.com/s/beta\u200b",
          "   - 访问码：B234",
          "https://115.com/s/gamma",
          "",
          "访问码：D456",
          "https://115.com/s/delta｜https://115.com/s/epsilon?password=E567",
        ].join("\n"),
      ),
    ).toMatchObject({
      entries: [
        { link: { shareCode: "alpha", accessCode: "A123" } },
        { link: { shareCode: "beta", accessCode: "B234" } },
        { link: { shareCode: "gamma", accessCode: "" } },
        { link: { shareCode: "delta", accessCode: "D456" } },
        { link: { shareCode: "epsilon", accessCode: "E567" } },
      ],
    });
  });

  it("keeps conflicting retry text compact when pasted access codes are repeated", () => {
    const result = parseShare115Batch(
      "https://115.com/s/alpha " + "密码 A123 ".repeat(480) + "密码 B234\nhttps://115.com/s/beta?password=B234",
    );
    expect(result).toMatchObject({
      entries: [
        { error: "conflicting_access_code", retryText: "https://115.com/s/alpha\n访问码：A123\n访问码：B234" },
        { link: { accessCode: "B234" } },
      ],
    });
    if (!("entries" in result)) throw new Error("expected parsed batch");
    expect(parseShare115Batch(result.entries.map(({ retryText }) => retryText).join("\n\n"))).toMatchObject({
      entries: [{ error: "conflicting_access_code" }, { link: { shareCode: "beta", accessCode: "B234" } }],
    });
  });
});
