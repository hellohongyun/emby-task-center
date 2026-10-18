import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { replaceArticleAddressMatchingHash } from "./legacy-article-address";

const oldAddress = "https://legacy.example.invalid";
const oldHash = createHash("sha256").update(oldAddress).digest("hex");
const token = "{{embyServerAddress}}";
const replace = (content: string) => replaceArticleAddressMatchingHash(content, oldAddress.length, oldHash);

describe("legacy article address matching", () => {
  it("replaces every exact old address while preserving paths and the rest of the article", () => {
    expect(replace(`地址：${oldAddress}/web；备用 ${oldAddress} 提示`)).toBe(`地址：${token}/web；备用 ${token} 提示`);
  });

  it("keeps administrator addresses and other article content unchanged", () => {
    const content = "自定义地址 https://emby.example.invalid/web；请联系管理员。";
    expect(replace(content)).toBe(content);
    expect(replace("没有服务器链接")).toBe("没有服务器链接");
  });

  it("retains the existing exact and case-sensitive replacement boundary", () => {
    expect(replace(oldAddress.toUpperCase())).toBe(oldAddress.toUpperCase());
    expect(replace(oldAddress.replace("https:", "http:"))).toBe(oldAddress.replace("https:", "http:"));
    expect(replace(`${oldAddress}:8096`)).toBe(`${token}:8096`);
  });

  it("is idempotent and never changes already migrated placeholders", () => {
    const once = replace(`地址 ${oldAddress} 与 ${token}`);
    expect(replace(once)).toBe(once);
  });
});
