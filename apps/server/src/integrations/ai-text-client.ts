/**
 * OpenAI 兼容的文案生成客户端（卡密彩蛋的「AI 帮写」）。
 *
 * 为什么是"OpenAI 兼容"而不是直连某一家：DeepSeek、通义、one-api/new-api 中转、自建 vLLM
 * 全都暴露同一套 `POST {baseUrl}/chat/completions`，换厂商只需要改后台的 Base URL 与模型名，
 * 不用改代码。默认预设 DeepSeek（见 settings/registry.ts 的 ai.* 分组）。
 *
 * 三条设计约束：
 *  ① **密钥只在本模块出现**：调用方永远只传数据库句柄，Key 由这里现读现用，不下发前端。
 *  ② **失败必须给出可分辨的原因**：`ai_not_configured` / `ai_unauthorized` / `ai_timeout`
 *     / `ai_request_failed`。管理员的下一步动作完全不同（去配置 / 换 Key / 稍后重试），
 *     把它们揉成一句"生成失败"等于让人无从下手。
 *  ③ **超时是硬上限**：这是交互式请求，卡住 30 秒比失败更难受；用 AbortSignal.timeout 兜底。
 */
import type { AppDatabase } from "@emby-task-center/database/client";

import { readSetting } from "../settings/store";

export type AiFailureReason =
  "ai_not_configured" | "ai_unauthorized" | "ai_timeout" | "ai_request_failed" | "ai_empty_result";

/** 带机器可读原因的失败：路由据此回对应的错误码，前端据错误码给不同的下一步。 */
export class AiTextError extends Error {
  readonly reason: AiFailureReason;

  constructor(reason: AiFailureReason, message?: string) {
    super(message ?? reason);
    this.name = "AiTextError";
    this.reason = reason;
  }
}

export interface AiTextOptions {
  /** 场景提示，如「国庆节卡密」；会填进 system prompt 的 {{occasion}}。 */
  occasion?: string;
  /** 额外要求（管理员可以再补一句，如"押韵一点"）。 */
  hint?: string;
  /** 期望字数上限，默认 60。 */
  length?: number;
}

export interface AiTextClientOptions {
  database: AppDatabase;
  /** 便于测试注入。 */
  fetchImpl?: typeof fetch;
}

/** 把后台可配的系统提示词里的占位符填好；未知占位符原样保留（不静默吞掉）。 */
function renderPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => values[key] ?? whole);
}

/** 干掉模型爱加的包装：整段引号、``` 围栏、"祝福语："前缀。不清掉管理员还得手删，就不叫帮写了。 */
function cleanGeneratedText(raw: string): string {
  let text = raw.trim();
  const fence = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(text);
  if (fence?.[1]) text = fence[1].trim();
  text = text.replace(/^(祝福语|文案|寄语)\s*[:：]\s*/u, "");
  // 成对的引号（中英文都算）包住整段时脱掉一层
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["「", "」"],
  ];
  for (const [open, close] of pairs) {
    if (text.length > 1 && text.startsWith(open) && text.endsWith(close)) {
      const inner = text.slice(open.length, text.length - close.length);
      // 只有当引号不是文案本身的一部分时才脱（里面还有同名引号就保留）
      if (!inner.includes(close)) {
        text = inner.trim();
        break;
      }
    }
  }
  return text.trim();
}

/**
 * 生成一条祝福文案。
 *
 * 只做一件事：读设置 → 调一次 chat/completions → 清洗 → 返回。没有重试：
 * 管理员就在按钮后面等着，失败时立刻换一条/改提示词比后台偷偷重试三次更快。
 */
export async function generateAiText(options: AiTextClientOptions, input: AiTextOptions = {}): Promise<string> {
  const { database } = options;
  const enabled = readSetting(database, "ai.enabled");
  const baseUrl = readSetting(database, "ai.baseUrl").trim();
  const apiKey = readSetting(database, "ai.apiKey").trim();
  const model = readSetting(database, "ai.model").trim();
  if (!enabled || !baseUrl || !apiKey || !model) {
    throw new AiTextError(
      "ai_not_configured",
      "AI 文案尚未配置：请到 系统设置 → AI 文案 填写接口地址、API Key 与模型并启用。",
    );
  }

  const length = Math.min(200, Math.max(10, Math.floor(input.length ?? 60)));
  const system = renderPrompt(readSetting(database, "ai.systemPrompt"), {
    occasion: input.occasion?.trim() || "会员卡密兑换成功",
    length: String(length),
  });
  const user = input.hint?.trim() ? `额外要求：${input.hint.trim()}` : "请写一条卡密兑换成功的祝福文案。";

  const timeoutMs = readSetting(database, "ai.timeoutMs");
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: readSetting(database, "ai.temperature"),
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (caught) {
    // AbortSignal.timeout 抛的是 TimeoutError；其余网络错误一律归为请求失败
    const name = (caught as { name?: string }).name ?? "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new AiTextError("ai_timeout", `AI 接口 ${timeoutMs} 毫秒内没有响应，请稍后重试或调大超时。`);
    }
    throw new AiTextError("ai_request_failed", `无法连接 AI 接口：${(caught as Error).message}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new AiTextError("ai_unauthorized", "AI 接口拒绝了这个 API Key（401/403），请检查 Key 是否正确。");
  }
  if (!response.ok) {
    // 只截一小段响应体：既能让管理员看出问题，又不会把可能含密钥的报文整段写进日志/前端
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new AiTextError("ai_request_failed", `AI 接口返回 ${response.status}：${detail || "无正文"}`);
  }

  const payload = (await response.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  } | null;
  const raw = payload?.choices?.[0]?.message?.content ?? "";
  const text = cleanGeneratedText(raw);
  if (!text) throw new AiTextError("ai_empty_result", "AI 没有返回可用的文案，换一条提示词再试试。");
  return text.slice(0, 200);
}

/** 设置页「测试连接」用：只跑一次最小请求，确认地址/Key/模型都对得上。 */
export async function testAiConnection(options: AiTextClientOptions): Promise<{ model: string; sample: string }> {
  const model = readSetting(options.database, "ai.model").trim();
  const sample = await generateAiText(options, { occasion: "连接测试", length: 30 });
  return { model, sample };
}
