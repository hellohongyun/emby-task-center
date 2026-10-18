import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { saveConcurrencyPolicy } from "../integrations/concurrency-policy-config";
import { writeSettings } from "../settings/store";
import { buildEmbyOnboardNotice, buildEmbyWelcomeEmail } from "./member-notices";

/**
 * 注册/开通后会员看到的两处文案（开通邮件 + 门户「我的」提示）。
 *
 * 为什么值得测：这两处以前是**写死在代码里**的，管理员改不了；现在都走注册表设置。
 * 要钉住三件事：
 *  ① 默认文案照样完整可用（没配过的部署升级后行为不变）；
 *  ② 后台改完立刻生效，占位符渲染成真实信息（不留 {{...}} 原文给会员看）；
 *  ③ 邮件与页面提示共用同一套占位符与口径，不会各说各话。
 */

describe("会员开通文案（邮件 + 门户提示）", () => {
  let directory: string;
  let database: DatabaseHandle;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "member-notices-"));
    database = createDatabase(join(directory, "app.sqlite"));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("默认开通邮件：含登录信息、登录教程与并发上限", () => {
    saveConcurrencyPolicy(database.db, {
      enabled: true,
      remindAfterMinutes: 2,
      disableAfterMinutes: 5,
      disableForHours: 1,
      portalUrl: "https://movie.example.com",
    });
    const { subject, text } = buildEmbyWelcomeEmail(database.db, {
      email: "new@example.com",
      username: "new@example.com",
      password: "abc123",
      maxStreams: 2,
      serverAddress: "http://emby.example.com:38096",
    });

    expect(subject).toContain("Emby 账号已开通");
    expect(text).toContain("服务器地址：http://emby.example.com:38096");
    expect(text).toContain("用户名：new@example.com");
    expect(text).toContain("初始密码：abc123");
    expect(text).toContain("如何登录与观看");
    expect(text).toContain("同时最多允许 2 路播放");
    expect(text).toContain("天鸿影院");
    // 占位符必须全部渲染掉：会员不能收到带 {{...}} 的邮件
    expect(text).not.toContain("{{");
  });

  it("后台改主题与正文立刻生效（占位符按当前配置渲染）", () => {
    saveConcurrencyPolicy(database.db, {
      enabled: true,
      remindAfterMinutes: 2,
      disableAfterMinutes: 5,
      disableForHours: 1,
      portalUrl: "https://movie.example.com",
    });
    writeSettings(database.db, {
      "member.welcomeEmailSubject": "[观影站] 你的账号好了",
      "member.welcomeEmailBody":
        "地址 {{serverAddress}}｜账号 {{username}}｜密码 {{password}}｜路数 {{maxStreams}}｜兜底 {{streamLimitNote}}｜平台 {{platformUrl}}｜收件人 {{email}}",
    });
    writeSettings(database.db, { "emby.baseUrl": "https://emby.example.test" });

    const { subject, text } = buildEmbyWelcomeEmail(database.db, {
      email: "new@example.com",
      username: "new@example.com",
      password: "p@ss",
      maxStreams: null,
    });

    expect(subject).toBe("[观影站] 你的账号好了");
    // 没传 serverAddress → 取「系统设置 → Emby 地址」；没登记上限 → 取全局默认路数（默认 1）
    expect(text).toBe(
      "地址 https://emby.example.test｜账号 new@example.com｜密码 p@ss｜路数 1｜兜底 同时最多允许 1 路播放。｜平台 https://movie.example.com｜收件人 new@example.com",
    );
  });

  it("文案留空回落默认（清空输入框不该发出空白邮件）", () => {
    writeSettings(database.db, { "member.welcomeEmailSubject": "   ", "member.welcomeEmailBody": "  " });

    const { subject, text } = buildEmbyWelcomeEmail(database.db, {
      email: "new@example.com",
      username: "new@example.com",
      password: "abc123",
      maxStreams: 1,
    });

    expect(subject).toContain("Emby 账号已开通");
    expect(text).toContain("【登录信息】");
  });

  it("续费/已有关联账号：拿不到旧密码时如实写「沿用原密码」，不留空白", () => {
    const { text } = buildEmbyWelcomeEmail(database.db, {
      email: "old@example.com",
      username: "old@example.com",
      password: "",
      maxStreams: 1,
    });
    expect(text).toContain("初始密码：（沿用原密码）");
  });

  it("门户「我的」提示：标题与正文都来自后台模板，且与邮件同一套占位符", () => {
    const fallback = buildEmbyOnboardNotice(database.db, {
      email: "new@example.com",
      username: "new@example.com",
      password: "abc123",
      maxStreams: 3,
      serverAddress: "https://emby.example.test",
    });
    expect(fallback.title).toContain("Emby 账号已开通");
    expect(fallback.notice).toContain("服务器地址：https://emby.example.test");
    expect(fallback.notice).toContain("同时最多允许 3 路播放");
    expect(fallback.notice).not.toContain("{{");

    writeSettings(database.db, {
      "member.embyOnboardTitle": "🎉 开通成功",
      "member.embyOnboardNotice": "用 {{username}} / {{password}} 登录 {{serverAddress}}（{{maxStreams}} 路）",
    });
    const custom = buildEmbyOnboardNotice(database.db, {
      email: "new@example.com",
      username: "new@example.com",
      password: "abc123",
      maxStreams: 3,
    });
    expect(custom.title).toBe("🎉 开通成功");
    expect(custom.notice).toContain("用 new@example.com / abc123 登录");
  });
});
