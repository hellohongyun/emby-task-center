import type { Express, Request, Response } from "express";
import { z } from "zod";

import type { AppDatabase } from "@emby-task-center/database/client";
import { getConcurrencyPolicy, saveConcurrencyPolicy } from "../integrations/concurrency-policy-config";

const policySchema = z.object({
  enabled: z.boolean(),
  /** 0 = 不提醒，超限满 disableAfterMinutes 直接冻结。 */
  remindAfterMinutes: z.number().int().min(0).max(120),
  /** 超限多少分钟后冻结账号（停用 + 断掉全部会话/设备）。 */
  disableAfterMinutes: z.number().int().min(1).max(720),
  /** 冻结时长（小时），到期自动恢复，期间管理员可手动恢复。 */
  disableForHours: z.number().int().min(1).max(720),
  adminEmail: z.string().trim().email().max(254).nullable().optional(),
  /** 超限是否直接中断多出来的播放（先到先得）。 */
  interruptStreams: z.boolean().optional(),
  /** 未登记会员的默认并发路数（0 = 不限）。 */
  defaultStreamLimit: z.number().int().min(0).max(20).optional(),
  /** 允许会员自助解冻（冻结邮件给出入口 + 门户显示解冻按钮）。 */
  unfreezeEnabled: z.boolean().optional(),
  /** 每月自助解冻次数上限（0 = 不允许），按自然月统计。 */
  unfreezeMonthlyLimit: z.number().int().min(0).max(10).optional(),
  /** 自助解冻强制等待秒数（服务端同样校验）。 */
  unfreezeWaitSeconds: z.number().int().min(0).max(600).optional(),
  /** 自助解冻弹窗标题/正文（后台文案，留空回落默认文案）。 */
  unfreezeTitle: z.string().trim().max(120).optional(),
  unfreezeNotice: z.string().trim().max(4_000).optional(),
  /** 平台地址：冻结邮件里的登录链接。 */
  portalUrl: z.string().trim().max(300).optional(),
});

/** 并发超限升级策略（后台界面可读写）。挂在 /api 鉴权之后。 */
export function registerConcurrencyPolicyRoutes(app: Express, database: AppDatabase): void {
  app.get("/api/concurrency-policy", (_request: Request, response: Response) => {
    response.json({ policy: getConcurrencyPolicy(database) });
  });

  app.put("/api/concurrency-policy", (request: Request, response: Response) => {
    const parsed = policySchema.safeParse(request.body ?? {});
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    // 未传的字段沿用当前值（面板只改其中几项时不会把其它项清零）。
    const current = getConcurrencyPolicy(database);
    response.json({
      policy: saveConcurrencyPolicy(database, {
        ...current,
        ...parsed.data,
        adminEmail: parsed.data.adminEmail ?? null,
      }),
    });
  });
}
