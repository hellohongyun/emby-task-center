import { describe, expect, it } from "vitest";

import { buildHtml, sendMembershipEmail } from "./send-notifications";
import type { EmailNotifier } from "../notifications/email-service";

// 开通邮件（Emby 账号 + 登录教程）已改成后台可编辑的模板，覆盖见 member-notices.test.ts。

describe("buildHtml", () => {
  it("统一品牌模板包裹正文，并转义 HTML", () => {
    const html = buildHtml("主题", "正文 <b>加粗</b>");
    expect(html).toContain("天鸿影院");
    expect(html).toContain("正文 &lt;b&gt;加粗&lt;/b&gt;");
    expect(html).toContain("本邮件由 天鸿影院 自动发送");
  });
});

/** 临期提醒只关心"正文里怎么称呼到期时间"，所以只记下最后发出的正文。 */
function captureEmail() {
  const sent: Array<{ subject: string; text: string }> = [];
  const notifier = {
    configured: true,
    sendNotification: async (_to: string, subject: string, text: string) => {
      sent.push({ subject, text });
    },
  } as unknown as EmailNotifier;
  return { notifier, sent };
}

describe("会员临期/到期提醒邮件的到期口径", () => {
  const soon = () => new Date(Date.now() + 2 * 86_400_000).toISOString();

  it("带「到期时间名称」的会员：邮件里写名称，并附小字真实日期", async () => {
    const { notifier, sent } = captureEmail();
    await sendMembershipEmail(
      notifier,
      { email: "a@example.com", subscriptionExpiresAt: soon(), membershipExpiryLabel: "2027 年春节结束到期" },
      new Date(),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("2027 年春节结束到期");
    expect(sent[0]!.subject).toContain("会员即将到期");
    expect(sent[0]!.text).toContain("会员服务");
    expect(sent[0]!.text).not.toContain("投稿");
    // 小字日期也在，用户不必为了"到底哪天"再来问管理员
    expect(sent[0]!.text).toContain(new Date(soon()).toLocaleDateString());
  });

  it("没有名称的会员：仍然照旧显示真实日期（老行为不变）", async () => {
    const { notifier, sent } = captureEmail();
    const expiresAt = soon();
    await sendMembershipEmail(
      notifier,
      { email: "b@example.com", subscriptionExpiresAt: expiresAt, membershipExpiryLabel: null },
      new Date(),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain(new Date(expiresAt).toLocaleString());
  });

  it("只有空白名称时按没有名称处理，不会发出一句空话", async () => {
    const { notifier, sent } = captureEmail();
    const expiresAt = soon();
    await sendMembershipEmail(
      notifier,
      { email: "c@example.com", subscriptionExpiresAt: expiresAt, membershipExpiryLabel: "   " },
      new Date(),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain(new Date(expiresAt).toLocaleString());
  });

  it("有效期内不发提醒（口径改动没有放宽触发条件）", async () => {
    const { notifier, sent } = captureEmail();
    const ok = await sendMembershipEmail(
      notifier,
      { email: "d@example.com", subscriptionExpiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString() },
      new Date(),
    );
    expect(ok).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
