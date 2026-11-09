import type { AppDatabase } from "@emby-task-center/database/client";
import { share115Statuses } from "@emby-task-center/database/schema";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { Logger } from "../logging/logger";
import { parseShare115Batch } from "../share-115/input";
import { enqueueShare115Batch, listShare115, resolveShare115Job, type Share115SubmissionRow } from "../share-115/store";
import { readSetting } from "../settings/store";
import { getSubmissionUserByEmail } from "../subscriptions/membership";
import type { PublicSession } from "../subscriptions/public-session";

const pageSchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(share115Statuses).optional(),
  q: z.string().trim().max(200).optional(),
});
const submissionSchema = z.strictObject({
  shareText: z.string().trim().min(1).max(4_000),
  accessCode: z.string().trim().max(64).optional(),
  note: z.string().trim().max(500).default(""),
});
const resolutionSchema = z.strictObject({ status: z.enum(["saved", "failed"]) });
const jobIdSchema = z.coerce.number().int().positive();
const admission = { maxPerMember: 10, maxPending: 200 };

export interface Share115Availability {
  accepting(): boolean;
  wake(): void;
}

interface RouteOptions {
  database: AppDatabase;
  service?: Share115Availability;
  logger?: Pick<Logger, "info">;
}

function identifiedMedia(raw: string | null) {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function serialize(row: Share115SubmissionRow, administrator: boolean) {
  return {
    id: row.id,
    jobId: row.jobId,
    ...(administrator
      ? {
          memberId: row.adminUsername ? null : row.memberId,
          memberEmail: row.adminUsername ? null : row.memberEmail,
          adminUsername: row.adminUsername,
        }
      : {}),
    note: row.note,
    submittedAt: row.submittedAt,
    shareUrl: row.shareUrl,
    shareCode: row.shareCode,
    accessCode: row.accessCode,
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    targetFolderId: row.targetFolderId,
    resultCode: row.resultCode,
    resultMessage: row.resultMessage,
    shareTitle: row.shareTitle,
    identifiedMedia: identifiedMedia(row.identifiedMediaJson),
  };
}

function respondWithPage(options: RouteOptions, request: Request, response: Response, memberId?: number) {
  response.set("Cache-Control", "private, no-store");
  const parsed = pageSchema.safeParse(request.query);
  if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
  const { items, total } = listShare115(options.database, { ...parsed.data, memberId });
  response.json({
    items: items.map((row) => serialize(row, memberId === undefined)),
    total,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    accepting: options.service?.accepting() ?? false,
  });
}

function submitShare(
  options: RouteOptions,
  request: Request,
  response: Response,
  actor: { memberId: number; memberEmail: string; adminUsername?: string },
) {
  const { database, service, logger } = options;
  response.set("Cache-Control", "private, no-store");
  if (!service?.accepting()) return void response.status(503).json({ error: "share_115_unavailable" });
  const parsed = submissionSchema.safeParse(request.body);
  if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
  const batch = parseShare115Batch(parsed.data.shareText, parsed.data.accessCode);
  if ("error" in batch) return void response.status(400).json(batch);

  const now = new Date();
  const administrator = actor.adminUsername !== undefined;
  const timestamp = now.toISOString();
  const links = batch.entries.filter((entry) => "link" in entry);
  const outcomes = enqueueShare115Batch(
    database,
    links.map(({ link }) => ({ ...link, ...actor, note: parsed.data.note, now: timestamp })),
    { ...admission, since: new Date(now.getTime() - 60 * 60_000).toISOString() },
  );
  const rows = new Map<number, Share115SubmissionRow>();
  const rejected: Array<{ index: number; error: string; retryText: string }> = batch.entries.flatMap((entry) =>
    "error" in entry ? [entry] : [],
  );
  for (const [index, result] of outcomes.entries()) {
    const entry = links[index]!;
    if (result.row) rows.set(result.row.id, result.row);
    else rejected.push({ index: entry.index, error: result.error, retryText: entry.retryText });
  }
  if (!rows.size && batch.entries.length === 1) {
    const { error } = rejected[0]!;
    const status = error === "rate_limited" ? 429 : error === "queue_full" ? 503 : 400;
    return void response.status(status).json({ error });
  }
  for (const row of rows.values()) {
    logger?.info({
      module: "share_115",
      event: "share_115_submitted",
      message: administrator ? "管理员提交 115 分享" : "会员提交 115 分享",
      detail: JSON.stringify({
        ...(administrator ? { adminUsername: actor.adminUsername } : { memberId: actor.memberId }),
        submissionId: row.id,
        jobId: row.jobId,
      }),
    });
  }
  const items = [...rows.values()].map((row) => serialize(row, administrator));
  response.status(items.length ? 202 : 200).json({
    ...(items.length ? { item: items[0] } : {}),
    items,
    rejected: rejected.sort((left, right) => left.index - right.index),
  });
  if (items.length) service.wake();
}

export function registerPublicShare115Routes(app: Express, options: RouteOptions & { publicSession: PublicSession }) {
  const { database, publicSession } = options;
  function member(request: Request, response: Response) {
    const { email } = publicSession.read(request.headers.cookie);
    const user = email && getSubmissionUserByEmail(database, email);
    if (!user) {
      response.status(401).json({ error: "unauthorized" });
      return null;
    }
    return user;
  }

  app.get("/api/public/115-shares", (request, response) => {
    const user = member(request, response);
    if (user) respondWithPage(options, request, response, user.id);
  });
  app.post("/api/public/115-shares", (request, response) => {
    const user = member(request, response);
    if (user) submitShare(options, request, response, { memberId: user.id, memberEmail: user.email });
  });
}

export function registerAdminShare115Routes(app: Express, options: RouteOptions) {
  app.get("/api/115-shares", (request, response) => respondWithPage(options, request, response));
  app.post("/api/115-shares", (request, response) => {
    submitShare(options, request, response, {
      memberId: 0,
      memberEmail: "",
      adminUsername: readSetting(options.database, "admin.username"),
    });
  });
  app.patch("/api/115-shares/jobs/:jobId/resolve", (request, response) => {
    const jobId = jobIdSchema.safeParse(request.params.jobId);
    const parsed = resolutionSchema.safeParse(request.body);
    if (!jobId.success || !parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const { status } = parsed.data;
    const resultMessage = status === "saved" ? "管理员已核实保存成功" : "管理员已核实转存失败";
    if (
      !resolveShare115Job(options.database, { id: jobId.data, now: new Date().toISOString(), status, resultMessage })
    ) {
      return void response.status(409).json({ error: "share_115_not_unconfirmed" });
    }
    options.logger?.info({
      module: "share_115",
      event: "share_115_result_resolved",
      message: resultMessage,
      detail: JSON.stringify({ jobId: jobId.data, status }),
    });
    response.json({ ok: true });
  });
}
