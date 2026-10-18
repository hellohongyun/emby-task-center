import type { Express, Request, Response } from "express";
import { z } from "zod";

import type { AppDatabase } from "@emby-task-center/database/client";
import { AiTextError, generateAiText, testAiConnection } from "../integrations/ai-text-client";
import {
  cardDisplayName,
  cardKindLabel,
  cardStatusLabel,
  createCardKeys,
  deleteCardKeys,
  expiryDisplay,
  formatExpiryDate,
  listCardKeys,
  updateCardKeys,
} from "../subscriptions/cards";

/** 名称/到期名称/文案都是"可清空"的：前端清空输入框会送空串，这里按 null 处理（见 cleanText）。 */
const createSchema = z.strictObject({
  kind: z.enum(["trial", "month", "year", "custom"]),
  days: z.number().int().min(1).max(3650).optional(),
  /** 固定到期日：`YYYY-MM-DD`（日历选出来的）或 ISO。给了就走"固定到期日"语义。 */
  expiresAt: z.string().trim().min(4).max(40).optional(),
  name: z.string().trim().max(40).optional(),
  expiryLabel: z.string().trim().max(60).optional(),
  blessing: z.string().trim().max(200).optional(),
  count: z.number().int().min(1).max(200),
});

const updateSchema = z.strictObject({
  ids: z.array(z.number().int().positive()).min(1).max(200),
  name: z.string().trim().max(40).optional(),
  expiryLabel: z.string().trim().max(60).optional(),
  blessing: z.string().trim().max(200).optional(),
});

const deleteSchema = z.object({ ids: z.array(z.number().int().positive()) });

/** AI 帮写：场景（卡密名/节日）与额外要求都由管理员当场填，服务端只做长度兜底。 */
const draftSchema = z.strictObject({
  occasion: z.string().trim().max(60).optional(),
  hint: z.string().trim().max(200).optional(),
  length: z.number().int().min(10).max(200).optional(),
});

export function registerCardRoutes(app: Express, database: AppDatabase): void {
  app.get("/api/cards", (_request: Request, response: Response) => {
    const cards = listCardKeys(database);
    const now = new Date();
    response.json({
      cards: cards.map((card) => {
        const display = expiryDisplay(card, now);
        return {
          id: card.id,
          code: card.code,
          kind: card.kind,
          kindLabel: cardKindLabel(card.kind),
          /** 管理员起的名字，没起时回落类型标签——列表里不出现空白单元格。 */
          name: card.name ?? null,
          displayName: cardDisplayName(card),
          days: card.days,
          /** 固定到期日（ISO）；老卡为 null，表示"兑换后 N 天"。 */
          expiresAt: card.expiresAt ?? null,
          expiryLabel: card.expiryLabel ?? null,
          /** 到期时间的展示主文案（名称优先）与真实日期，列表直接照抄，不再前端拼。 */
          expiryText: display.text,
          expiryDate: card.expiresAt ? formatExpiryDate(card.expiresAt) : null,
          /** 固定到期日卡是否已经过期（过期卡不能被兑换，见 inspectCard）。 */
          expired: card.expiresAt ? Date.parse(card.expiresAt) <= now.getTime() : false,
          blessing: card.blessing ?? null,
          status: card.status,
          statusLabel: cardStatusLabel(card.status),
          usedByEmail: card.usedByEmail ?? null,
          usedAt: card.usedAt ?? null,
          createdAt: card.createdAt,
          updatedAt: card.updatedAt,
        };
      }),
      total: cards.length,
      unused: cards.filter((card) => card.status === "unused").length,
      used: cards.filter((card) => card.status === "used").length,
    });
  });

  app.post("/api/cards", (request: Request, response: Response) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    try {
      const codes = createCardKeys(database, {
        kind: parsed.data.kind,
        days: parsed.data.days,
        expiresAt: parsed.data.expiresAt,
        name: parsed.data.name,
        expiryLabel: parsed.data.expiryLabel,
        blessing: parsed.data.blessing,
        count: parsed.data.count,
      });
      response.status(201).json({ codes, count: codes.length });
    } catch (error) {
      const reason = (error as Error).message;
      const known = ["invalid_days", "invalid_expires_at"];
      return void response.status(400).json({ error: known.includes(reason) ? reason : "invalid_request" });
    }
  });

  /**
   * AI 帮写祝福文案（卡密彩蛋）。
   *
   * 挂在管理端鉴权之后（app.ts 里 `/api` 已 requireSession），因为这条会真的花管理员自己的
   * API 额度并带出密钥——不能放在任何公开路径上。失败一律返回可分辨的错误码，
   * 前端据此把"去配置 / 换 Key / 稍后重试"分开提示，而不是笼统一句"生成失败"。
   */
  app.post("/api/cards/blessing/draft", async (request: Request, response: Response) => {
    const parsed = draftSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    try {
      const text = await generateAiText(
        { database },
        { occasion: parsed.data.occasion, hint: parsed.data.hint, length: parsed.data.length },
      );
      response.json({ text });
    } catch (caught) {
      if (caught instanceof AiTextError) {
        // 未配置/未授权是"管理员要去改设置"，用 409 与 502 区分开"上游挂了"
        const status = caught.reason === "ai_not_configured" ? 409 : caught.reason === "ai_unauthorized" ? 502 : 502;
        return void response.status(status).json({ error: caught.reason, message: caught.message });
      }
      response.status(502).json({ error: "ai_request_failed", message: (caught as Error).message });
    }
  });

  /**
   * AI 连接测试：管理员刚填完 Base URL / Key / 模型时，用最小的请求确认这套配置真的能用。
   *
   * 存在的理由：AI 配置是本项目**唯一**的出站第三方依赖，填错了只会在"点了帮写却没反应"时
   * 才发现。这里让管理员当场把地址、Key、模型名验一遍，而不是等生成失败再猜是哪一项错了。
   */
  app.post("/api/cards/blessing/test", async (_request: Request, response: Response) => {
    try {
      const result = await testAiConnection({ database });
      response.json({ ok: true, ...result });
    } catch (caught) {
      if (caught instanceof AiTextError) {
        return void response
          .status(caught.reason === "ai_not_configured" ? 409 : 502)
          .json({ error: caught.reason, message: caught.message });
      }
      response.status(502).json({ error: "ai_request_failed", message: (caught as Error).message });
    }
  });

  /** 改文案类字段（名称/到期时间名称/彩蛋文案）。到期时间与天数故意不在此列，见 updateCardKeys。 */
  app.patch("/api/cards", (request: Request, response: Response) => {
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const changed = updateCardKeys(database, {
      ids: parsed.data.ids,
      name: parsed.data.name,
      expiryLabel: parsed.data.expiryLabel,
      blessing: parsed.data.blessing,
    });
    response.json({ ok: true, updated: changed });
  });

  app.delete("/api/cards", (request: Request, response: Response) => {
    const parsed = deleteSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const changed = deleteCardKeys(database, parsed.data.ids);
    response.json({ ok: true, deleted: changed });
  });
}
