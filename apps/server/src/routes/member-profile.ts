import type { Express, Request } from "express";
import { z } from "zod";
import type { AppDatabase } from "@emby-task-center/database/client";
import type { EmbyClient } from "../integrations/emby-client";
import type { WorkflowLogger } from "../logging/workflow-log";
import { audit } from "../subscriptions/domain-utils";
import { memberProfileSchema, toMemberProfile } from "../subscriptions/member-profile";
import { syncMemberQqAvatar, updateMemberProfile } from "../subscriptions/member-qq-avatar";
import { getSubmissionUser, getSubmissionUserByEmail } from "../subscriptions/membership";
import { readId } from "./route-utils";

interface ProfileRouteOptions {
  database: AppDatabase;
  emby?: EmbyClient | undefined;
  logger?: WorkflowLogger | undefined;
}

const avatarSyncSchema = z.strictObject({ replace: z.boolean() });

export function registerPublicMemberProfileRoutes(
  app: Express,
  { database, emby, logger }: ProfileRouteOptions,
  sessionEmail: (request: Request) => string | null,
): void {
  const path = "/api/public/subscriptions/member/profile";
  function memberFor(request: Request) {
    const email = sessionEmail(request);
    const member = email && getSubmissionUserByEmail(database, email);
    return member && member.enabled ? member : null;
  }

  app.get(path, (request, response) => {
    const member = memberFor(request);
    if (!member) return void response.status(401).json({ error: "unauthorized" });
    response.json({ profile: toMemberProfile(member) });
  });

  app.put(path, async (request, response) => {
    const member = memberFor(request);
    if (!member) return void response.status(401).json({ error: "unauthorized" });
    const parsed = memberProfileSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const profile = await updateMemberProfile(database, emby, member.id, parsed.data, { logger });
    if (!profile) return void response.status(401).json({ error: "unauthorized" });
    response.json({ profile });
  });
}

export function registerAdminMemberProfileRoutes(app: Express, { database, emby, logger }: ProfileRouteOptions): void {
  const path = "/api/submission-users/:id/profile";
  app.put(path, async (request, response) => {
    const id = readId(request.params.id);
    const parsed = memberProfileSchema.safeParse(request.body);
    if (!id || !parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const profile = await updateMemberProfile(database, emby, id, parsed.data, { admin: true, logger });
    if (!profile) return void response.status(404).json({ error: "user_not_found" });
    audit(database, "admin", "member.updated", "submission_user", id, undefined, { profile: true });
    response.json({ profile });
  });

  app.post(`${path}/avatar`, async (request, response) => {
    const id = readId(request.params.id);
    const parsed = avatarSyncSchema.safeParse(request.body);
    if (!id || !parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const outcome = await syncMemberQqAvatar(database, emby, id, { ...parsed.data, logger });
    const member = getSubmissionUser(database, id);
    if (!member) return void response.status(404).json({ error: "user_not_found" });
    const profile = toMemberProfile(member);
    if (outcome === "updated")
      audit(database, "admin", "member.updated", "submission_user", id, undefined, { avatar: true });
    response.json({ profile });
  });
}
