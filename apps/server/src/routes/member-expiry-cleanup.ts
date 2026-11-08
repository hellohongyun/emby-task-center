import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { z } from "zod";
import type { AppDatabase } from "@emby-task-center/database/client";
import type { EmbyClient } from "../integrations/emby-client";
import {
  cleanupDirectory,
  cleanupPolicy,
  MAX_EXPIRY_CLEANUP_DAYS,
  memberCleanupPlan,
  saveCleanupPolicy,
} from "../subscriptions/member-expiry-cleanup-plan";

const path = "/api/member-expiry-cleanup";
const daysField = z.number().int().min(1).max(MAX_EXPIRY_CLEANUP_DAYS);
const previewSchema = z.strictObject({ days: daysField });
const saveSchema = z.strictObject({
  days: daysField.nullable(),
  expectedDays: daysField.nullable(),
  previewToken: z.uuid().optional(),
});
const PREVIEW_MS = 300_000;
const PREVIEW_LIMIT = 16;

type Preview = { days: number; revision: string | null; fingerprint: string; validUntil: number };

function fingerprint(serverId: string | null, plan: ReturnType<typeof memberCleanupPlan>) {
  return JSON.stringify([serverId, plan]);
}

export function registerMemberExpiryCleanupRoutes(app: Express, database: AppDatabase, emby?: EmbyClient) {
  const previews = new Map<string, Preview>();
  app.use(path, (_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });
  app.get(path, (_request, response) => {
    response.json({ days: cleanupPolicy(database).days });
  });

  app.post(`${path}/preview`, async (request, response) => {
    const parsed = previewSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const directory = await cleanupDirectory(database, emby);
    const now = new Date();
    const plan = memberCleanupPlan(database, parsed.data.days, now, directory);
    const previewToken = randomUUID();
    for (const [token, entry] of previews) if (entry.validUntil <= now.getTime()) previews.delete(token);
    if (previews.size >= PREVIEW_LIMIT) previews.delete(previews.keys().next().value!);
    previews.set(previewToken, {
      days: parsed.data.days,
      revision: cleanupPolicy(database).revision,
      fingerprint: fingerprint(directory?.serverId ?? null, plan),
      validUntil: now.getTime() + PREVIEW_MS,
    });
    const candidates = plan.candidates.map(({ id, email, expiresAt, linked }) => ({ id, email, expiresAt, linked }));
    response.json({ previewToken, days: parsed.data.days, candidates, blocked: plan.blocked });
  });

  app.put(path, async (request, response) => {
    const parsed = saveSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const { days, expectedDays, previewToken } = parsed.data;
    const preview = previewToken ? previews.get(previewToken) : undefined;
    if (days !== null && (!preview || preview.days !== days || preview.validUntil <= Date.now())) {
      return void response.status(409).json({ error: "member_cleanup_preview_expired" });
    }
    const directory = days === null ? null : await cleanupDirectory(database, emby);
    const error = database.transaction(
      (tx) => {
        const current = cleanupPolicy(tx);
        if (current.days !== expectedDays || (days !== null && current.revision !== preview?.revision))
          return "member_cleanup_policy_changed";
        const serverId = directory?.serverId ?? null;
        if (days !== null) {
          if (preview!.validUntil <= Date.now()) return "member_cleanup_preview_expired";
          const currentPlan = memberCleanupPlan(tx, days, new Date(), directory);
          if (preview!.fingerprint !== fingerprint(serverId, currentPlan)) return "member_cleanup_preview_changed";
        }
        saveCleanupPolicy(tx, days, serverId);
        return null;
      },
      { behavior: "immediate" },
    );
    if (previewToken) previews.delete(previewToken);
    if (error) return void response.status(409).json({ error });
    response.json({ days });
  });
}
