import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { AiTextError, generateAiText, testAiConnection } from "./ai-text-client";
import { readSetting, writeSettings } from "../settings/store";

/** 造一个可配置的库：默认 ai 是关的，用例自己按需要打开。 */
function configure(database: DatabaseHandle, patch: Record<string, unknown>) {
  const result = writeSettings(database.db, patch);
  if (result.rejected.length) throw new Error(`设置写入被拒：${JSON.stringify(result.rejected)}`);
}

function openAiSuccess(content: string, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status }));
}

describe("AI 文案客户端（OpenAI 兼容）", () => {
  let directory: string;
  let database: DatabaseHandle;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "emby-ai-text-"));
    database = createDatabase(join(directory, "app.sqlite"));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("没启用/没填 Key 时直接报 ai_not_configured，且不发任何请求", async () => {
    const fetchImpl = vi.fn();
    // 默认 ai.enabled = false
    await expect(
      generateAiText({ database: database.db, fetchImpl }, { occasion: "国庆节卡密" }),
    ).rejects.toMatchObject({
      reason: "ai_not_configured",
    });

    // 启用了但 Key 是空的：同样不发请求
    configure(database, { "ai.enabled": true });
    await expect(generateAiText({ database: database.db, fetchImpl })).rejects.toMatchObject({
      reason: "ai_not_configured",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("请求体与鉴权头符合 OpenAI 兼容协议，默认打 DeepSeek 地址", async () => {
    configure(database, {
      "ai.enabled": true,
      "ai.apiKey": "sk-test-123",
      "ai.temperature": 1.1,
      "ai.timeoutMs": 5_000,
    });
    const fetchImpl = openAiSuccess("国庆快乐！");
    await generateAiText({ database: database.db, fetchImpl }, { occasion: "国庆节卡密", hint: "押韵一点" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test-123");
    const body = JSON.parse(String(init.body)) as {
      model: string;
      temperature: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("deepseek-chat");
    expect(body.temperature).toBe(1.1);
    // 场景与额外要求都要进提示词，否则"AI 帮写"写出来的东西和卡密无关
    expect(body.messages[0]!.content).toContain("国庆节卡密");
    expect(body.messages[1]!.content).toContain("押韵一点");
  });

  it("地址带不带结尾斜杠都能拼对，自建/中转地址可用", async () => {
    configure(database, {
      "ai.enabled": true,
      "ai.apiKey": "sk-test",
      "ai.baseUrl": "http://192.168.1.9:3000/v1/",
    });
    const fetchImpl = openAiSuccess("好");
    await generateAiText({ database: database.db, fetchImpl });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("http://192.168.1.9:3000/v1/chat/completions");
  });

  it("模型爱加的包装（引号/围栏/前缀）会被清掉，管理员拿到的就是能直接用的文案", async () => {
    configure(database, { "ai.enabled": true, "ai.apiKey": "sk-test" });
    const cases: Array<[string, string]> = [
      ['"国庆快乐，追剧愉快！"', "国庆快乐，追剧愉快！"],
      ["“生日快乐，愿好片常伴。”", "生日快乐，愿好片常伴。"],
      ["「春节快乐」", "春节快乐"],
      ["祝福语：新年快乐，阖家幸福！", "新年快乐，阖家幸福！"],
      ["```\n愿你天天有好片可看！\n```", "愿你天天有好片可看！"],
    ];
    for (const [raw, expected] of cases) {
      const fetchImpl = openAiSuccess(raw);
      await expect(generateAiText({ database: database.db, fetchImpl })).resolves.toBe(expected);
    }
  });

  it("401/403 报 ai_unauthorized（管理员该去换 Key，而不是重试）", async () => {
    configure(database, { "ai.enabled": true, "ai.apiKey": "sk-bad" });
    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    await expect(generateAiText({ database: database.db, fetchImpl })).rejects.toMatchObject({
      reason: "ai_unauthorized",
    });
  });

  it("其它非 2xx 报 ai_request_failed，并带上截断过的上游正文", async () => {
    configure(database, { "ai.enabled": true, "ai.apiKey": "sk-test" });
    const fetchImpl = vi.fn(async () => new Response("model not found", { status: 404 }));
    await expect(generateAiText({ database: database.db, fetchImpl })).rejects.toMatchObject({
      reason: "ai_request_failed",
    });
    await generateAiText({ database: database.db, fetchImpl }).catch((error: AiTextError) => {
      expect(error.message).toContain("404");
      expect(error.message).toContain("model not found");
    });
  });

  it("超时报 ai_timeout（而不是含糊的请求失败）", async () => {
    configure(database, { "ai.enabled": true, "ai.apiKey": "sk-test" });
    const fetchImpl = vi.fn(async () => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    });
    await expect(generateAiText({ database: database.db, fetchImpl })).rejects.toMatchObject({ reason: "ai_timeout" });
  });

  it("网络异常报 ai_request_failed", async () => {
    configure(database, { "ai.enabled": true, "ai.apiKey": "sk-test" });
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(generateAiText({ database: database.db, fetchImpl })).rejects.toMatchObject({
      reason: "ai_request_failed",
    });
  });

  it("模型返回空内容时报 ai_empty_result，不让空文案悄悄存进卡密", async () => {
    configure(database, { "ai.enabled": true, "ai.apiKey": "sk-test" });
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ choices: [{ message: { content: "   " } }] }), { status: 200 }),
    );
    await expect(generateAiText({ database: database.db, fetchImpl })).rejects.toMatchObject({
      reason: "ai_empty_result",
    });
  });

  it("系统提示词可在后台整段替换，占位符按场景与字数渲染", async () => {
    configure(database, {
      "ai.enabled": true,
      "ai.apiKey": "sk-test",
      "ai.systemPrompt": "场景={{occasion}} 字数={{length}} 原样保留={{unknown}}",
    });
    const fetchImpl = openAiSuccess("好");
    await generateAiText({ database: database.db, fetchImpl }, { occasion: "生日快乐卡密", length: 20 });
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0]!.content).toBe("场景=生日快乐卡密 字数=20 原样保留={{unknown}}");
  });

  it("长度上限被夹在 10-200 之间，防止有人把模型输出撑爆卡密字段", async () => {
    configure(database, { "ai.enabled": true, "ai.apiKey": "sk-test" });
    const fetchImpl = openAiSuccess("x".repeat(500));
    const text = await generateAiText({ database: database.db, fetchImpl }, { length: 9_999 });
    expect(text.length).toBe(200);
  });

  it("测试连接复用同一条链路（设置页「测试」按钮）", async () => {
    configure(database, { "ai.enabled": true, "ai.apiKey": "sk-test", "ai.model": "deepseek-chat" });
    const fetchImpl = openAiSuccess("连接正常");
    await expect(testAiConnection({ database: database.db, fetchImpl })).resolves.toEqual({
      model: "deepseek-chat",
      sample: "连接正常",
    });
  });

  it("密钥不会出现在默认系统提示词里（防手滑把 Key 抄进文案模板）", () => {
    const prompt = readSetting(database.db, "ai.systemPrompt");
    expect(prompt).toContain("{{occasion}}");
    expect(prompt).not.toContain("sk-");
  });
});
