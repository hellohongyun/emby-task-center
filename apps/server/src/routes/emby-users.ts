import { eq } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { submissionUsers } from "@emby-task-center/database/schema";
import { embyAccessAllowed, syncMemberEmbyAccess } from "../subscriptions/emby-access";
import type { Express, Request, RequestHandler, Response } from "express";
import { z } from "zod";

import type { EmbyClient } from "../integrations/emby-client";
import { createEmbyUserService, type EmbyUserService } from "../integrations/emby-user-service";

const createUserSchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  password: z.string().min(6).max(200).optional(),
  isAdmin: z.boolean().optional(),
});
const passwordSchema = z.strictObject({ password: z.string().min(6).max(200) });
const policySchema = z.object({ IsDisabled: z.boolean().optional() }).passthrough();

/** 统一捕获 EmbyUserError 并返回用户可读的 status + message。 */
function wrap(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response) => {
    void handler(request, response).catch((error) => {
      const status = (error as { status?: number }).status ?? 500;
      const message = error instanceof Error ? error.message : "Emby 请求失败";
      response.status(status).json({ error: message });
    });
  };
}

export function registerEmbyUserRoutes(app: Express, emby: EmbyClient | undefined, database?: AppDatabase): void {
  const service: EmbyUserService = createEmbyUserService(emby);
  const linkedMember = (id: string) =>
    database?.select().from(submissionUsers).where(eq(submissionUsers.embyUserId, id)).get();

  app.get(
    "/api/emby/users",
    wrap(async (_request, response) => {
      response.json({ users: await service.listUsers() });
    }),
  );

  app.post(
    "/api/emby/users",
    wrap(async (request, response) => {
      const parsed = createUserSchema.safeParse(request.body);
      if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
      const user = await service.createUser(parsed.data);
      response.status(201).json(user);
    }),
  );

  app.post(
    "/api/emby/users/:id/password",
    wrap(async (request, response) => {
      const parsed = passwordSchema.safeParse(request.body);
      if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
      await service.setPassword(String(request.params.id), parsed.data.password);
      response.json({ ok: true });
    }),
  );

  app.post(
    "/api/emby/users/:id/disable",
    wrap(async (request, response) => {
      await service.setDisabled(String(request.params.id), true);
      response.json({ ok: true, disabled: true });
    }),
  );

  app.post(
    "/api/emby/users/:id/enable",
    wrap(async (request, response) => {
      const member = linkedMember(String(request.params.id));
      if (member && database) {
        if (!embyAccessAllowed(database, member.id))
          return void response.status(403).json({ error: "member_restore_blocked" });
        if (!(await syncMemberEmbyAccess(database, emby, member.id)))
          return void response.status(502).json({ error: "member_restore_failed" });
      } else await service.setDisabled(String(request.params.id), false);
      response.json({ ok: true, disabled: false });
    }),
  );

  app.post(
    "/api/emby/users/:id/policy",
    wrap(async (request, response) => {
      const parsed = policySchema.safeParse(request.body);
      if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
      if (Object.keys(parsed.data).some((key) => key.toLowerCase() === "isdisabled" && key !== "IsDisabled"))
        return void response.status(400).json({ error: "invalid_request" });
      const member = linkedMember(String(request.params.id));
      const enabling = parsed.data.IsDisabled === false;
      if (enabling && member && database && !embyAccessAllowed(database, member.id))
        return void response.status(403).json({ error: "member_restore_blocked" });
      await service.applyPolicy(String(request.params.id), parsed.data as never);
      if (enabling && member && database && !(await syncMemberEmbyAccess(database, emby, member.id)))
        return void response.status(502).json({ error: "member_restore_failed" });
      response.json({ ok: true });
    }),
  );

  app.delete(
    "/api/emby/users/:id",
    wrap(async (request, response) => {
      await service.deleteUser(String(request.params.id));
      response.json({ ok: true });
    }),
  );

  app.get(
    "/api/emby/sessions",
    wrap(async (_request, response) => {
      response.json({ sessions: await service.listSessions() });
    }),
  );

  app.post(
    "/api/emby/sessions/:id/end",
    wrap(async (request, response) => {
      await service.endSession(String(request.params.id));
      response.json({ ok: true });
    }),
  );
}
