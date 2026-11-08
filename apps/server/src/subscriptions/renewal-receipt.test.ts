import { describe, expect, it } from "vitest";
import { buildRenewalReceipt } from "./renewal-receipt";

describe("renewal transaction receipt", () => {
  const data = {
    email: "member@example.invalid",
    method: "管理员增加 30 天",
    previousExpiresAt: "2026-11-01T00:00:00.000Z",
    subscriptionExpiresAt: "2026-12-01T00:00:00.000Z",
    expiryLabel: "劳动节后到期",
  };
  it("describes the method, previous date, named expiry and actual date without promising access restoration", () => {
    const receipt = buildRenewalReceipt(data);
    expect(receipt.subject).toContain("会员续期");
    expect(receipt.text).toContain("管理员增加 30 天");
    expect(receipt.text).toContain("本次续期后有效期：劳动节后到期");
    expect(receipt.text).toContain(`续期前有效期：${new Date(data.previousExpiresAt).toLocaleString()}`);
    expect(receipt.text).toContain(`实际到期时间：${new Date(data.subscriptionExpiresAt).toLocaleString()}`);
    expect(receipt.text).not.toMatch(/已启用|已解冻|密码|卡密编号/);
    expect(buildRenewalReceipt({ ...data, expiryLabel: null }).text).not.toContain("实际到期时间：");
  });
  it("escapes arbitrary expiry names, including quote-bearing links, in HTML", () => {
    const receipt = buildRenewalReceipt({
      ...data,
      expiryLabel: '<img src=x onerror="bad"> https://test.invalid/" onmouseover="bad',
    });
    expect(receipt.html).toContain("&lt;img");
    expect(receipt.html).not.toContain("<img");
    expect(receipt.html).not.toContain('onerror="');
    expect(receipt.html).not.toContain('onmouseover="');
    expect(receipt.text).toContain('<img src=x onerror="bad">');
  });
});
