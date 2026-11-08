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
  openCleanupSession,
  saveCleanupPolicy,
  type CleanupDirectory,
  type CleanupKind,
} from "../subscriptions/member-expiry-cleanup-plan";
import { loadCleanupPlayback, memberInactivityCleanupPlan } from "../subscriptions/member-inactivity-cleanup-plan";

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

type Plan = ReturnType<typeof memberCleanupPlan> | ReturnType<typeof memberInactivityCleanupPlan>;

function fingerprint(serverId: string | null, plan: Plan) {
  return JSON.stringify([serverId, plan]);
}

async function preparePlan(
  database: AppDatabase,
  emby: EmbyClient | undefined,
  kind: CleanupKind,
  days: number,
  directory: CleanupDirectory | null,
): Promise<((current: AppDatabase, now: Date) => Plan) | null> {
  if (kind === "expiry") return (current, now) => memberCleanupPlan(current, days, now, directory);
  if (!directory) return null;
  const isConnected = () => openCleanupSession(database, emby)?.identity === directory.session.identity;
  const playback = await loadCleanupPlayback(database, directory, days, new Date(), isConnected);
  return playback && isConnected()
    ? (current, now) => memberInactivityCleanupPlan(current, days, now, directory, playback)
    : null;
}

export function registerMemberCleanupRoutes(app: Express, database: AppDatabase, emby?: EmbyClient) {
  registerCleanupRuleRoutes(app, database, emby, "expiry");
  registerCleanupRuleRoutes(app, database, emby, "inactivity");
}

function registerCleanupRuleRoutes(
  app: Express,
  database: AppDatabase,
  emby: EmbyClient | undefined,
  kind: CleanupKind,
) {
  const path = `/api/member-${kind}-cleanup`;
  const previews = new Map<string, Preview>();
  app.use(path, (_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });
  app.get(path, (_request, response) => {
    response.json({ days: cleanupPolicy(database, kind).days });
  });

  app.post(`${path}/preview`, async (request, response) => {
    const parsed = previewSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const directory = await cleanupDirectory(database, emby);
    const makePlan = await preparePlan(database, emby, kind, parsed.data.days, directory);
    if (!makePlan) return void response.status(503).json({ error: "member_cleanup_activity_unavailable" });
    const now = new Date();
    const plan = makePlan(database, now);
    const previewToken = randomUUID();
    for (const [token, entry] of previews) if (entry.validUntil <= now.getTime()) previews.delete(token);
    if (previews.size >= PREVIEW_LIMIT) previews.delete(previews.keys().next().value!);
    previews.set(previewToken, {
      days: parsed.data.days,
      revision: cleanupPolicy(database, kind).revision,
      fingerprint: fingerprint(directory?.serverId ?? null, plan),
      validUntil: now.getTime() + PREVIEW_MS,
    });
    const candidates = plan.candidates.map((entry) =>
      "expiresAt" in entry
        ? { id: entry.id, email: entry.email, expiresAt: entry.expiresAt, linked: entry.linked }
        : { id: entry.id, email: entry.email, lastPlayedAt: entry.lastPlayedAt, createdAt: entry.createdAt },
    );
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
    const makePlan = days === null ? null : await preparePlan(database, emby, kind, days, directory);
    if (days !== null && !makePlan)
      return void response.status(503).json({ error: "member_cleanup_activity_unavailable" });
    const error = database.transaction(
      (tx) => {
        const current = cleanupPolicy(tx, kind);
        if (current.days !== expectedDays || (days !== null && current.revision !== preview?.revision))
          return "member_cleanup_policy_changed";
        const serverId = directory?.serverId ?? null;
        if (makePlan) {
          if (preview!.validUntil <= Date.now()) return "member_cleanup_preview_expired";
          const currentPlan = makePlan(tx, new Date());
          if (preview!.fingerprint !== fingerprint(serverId, currentPlan)) return "member_cleanup_preview_changed";
        }
        saveCleanupPolicy(tx, days, serverId, kind);
        return null;
      },
      { behavior: "immediate" },
    );
    if (previewToken) previews.delete(previewToken);
    if (error) return void response.status(409).json({ error });
    response.json({ days });
  });
}
