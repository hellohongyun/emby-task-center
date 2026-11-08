import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import type { AppDatabase } from "@emby-task-center/database/client";
import { submissionUsers } from "@emby-task-center/database/schema";
import type { EmbyClient } from "../integrations/emby-client";
import { workflowLog, type WorkflowLog, type WorkflowLogger } from "../logging/workflow-log";
import { fetchImage } from "../util/image-request";
import { type memberProfileSchema, qqAvatarUrl, toMemberProfile } from "./member-profile";
import { getSubmissionUser } from "./membership";

type SyncStatus = NonNullable<typeof submissionUsers.$inferSelect.qqAvatarSyncStatus>;
export type AvatarRefreshOutcome = "updated" | "unchanged" | "preserved" | "unavailable" | "failed" | "skipped";
interface AvatarRefreshOptions {
  replace?: boolean;
  managedOnly?: boolean;
  logger?: WorkflowLogger | undefined;
  log?: WorkflowLog;
  signal?: AbortSignal;
}
const queues = new WeakMap<AppDatabase, Map<number, Promise<unknown>>>();
const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");
const jpegSignature = Buffer.from("ffd8ff", "hex");
// q1.qlogo.cn fallback image returned for known invalid numbers 0 and 00000.
const defaultAvatarHash = "20005763993af7e0ed37add100182e29c804d48f439befe320c3b817e25b2afa";

async function inMemberOrder<T>(database: AppDatabase, id: number, action: () => Promise<T>): Promise<T> {
  let queue = queues.get(database);
  if (!queue) {
    queue = new Map();
    queues.set(database, queue);
  }
  const previous = queue.get(id) ?? Promise.resolve();
  const current = previous.then(action, action);
  queue.set(id, current);
  try {
    return await current;
  } finally {
    if (queue.get(id) === current) queue.delete(id);
  }
}

async function fetchQqAvatar(qqNumber: string, signal?: AbortSignal) {
  const url = qqAvatarUrl(qqNumber);
  const result = await fetchImage(url, {
    timeoutMs: 4000,
    maxBytes: 1024 * 1024,
    allowUrl: (target) => target === url,
    headers: { "Cache-Control": "no-cache" },
    signal,
  });
  const { body } = result;
  if (createHash("sha256").update(body).digest("hex") === defaultAvatarHash) return null;
  const contentType = result.contentType.split(";")[0]?.trim().toLowerCase();
  if (contentType === "image/png" && body.subarray(0, pngSignature.length).equals(pngSignature))
    return { contentType, body };
  if (contentType === "image/jpeg" && body.subarray(0, jpegSignature.length).equals(jpegSignature))
    return { contentType, body };
  throw new Error("qq_avatar_invalid_format");
}

async function syncAvatar(
  database: AppDatabase,
  emby: EmbyClient | undefined,
  id: number,
  options: AvatarRefreshOptions,
): Promise<AvatarRefreshOutcome> {
  const { replace, managedOnly, signal } = options;
  if (signal?.aborted) return "skipped";
  const member = getSubmissionUser(database, id);
  if (!member?.qqNumber || !member.embyUserId || !emby) return "skipped";
  const { qqNumber, embyUserId } = member;
  if (managedOnly && (!member.enabled || !member.qqAvatarSyncedTag || member.qqAvatarSyncedEmbyUserId !== embyUserId))
    return "skipped";
  const log = options.log ?? workflowLog(options.logger, "qq-avatar");
  const started = Date.now();
  const context = { memberId: id };
  let stage = "检查 Emby 头像";
  let writing = false;

  function storeStatus(status: SyncStatus, tag?: string) {
    database
      .update(submissionUsers)
      .set({
        qqAvatarSyncStatus: status,
        ...(tag ? { qqAvatarSyncedTag: tag, qqAvatarSyncedEmbyUserId: embyUserId } : {}),
      })
      .where(
        and(
          eq(submissionUsers.id, id),
          eq(submissionUsers.qqNumber, qqNumber),
          eq(submissionUsers.embyUserId, embyUserId),
        ),
      )
      .run();
  }

  try {
    if (!emby.configured) return "skipped";
    const session = emby.openUserAvatarSession?.();
    if (!session) return "skipped";
    if (!managedOnly) log.write("info", "avatar_check_started", `会员 #${id} 开始检查 Emby 头像`, context);
    const currentTag = await session.readTag(embyUserId, signal);
    const managed = currentTag === member.qqAvatarSyncedTag && member.qqAvatarSyncedEmbyUserId === embyUserId;
    function preserveAvatar() {
      storeStatus("preserved");
      if (!managedOnly || member?.qqAvatarSyncStatus !== "preserved")
        log.write("info", "avatar_preserved", `会员 #${id} 保留 Emby 自定义头像`, context, Date.now() - started);
      return "preserved" as const;
    }
    if (currentTag && !managed && !replace) return preserveAvatar();
    if (managedOnly && !managed) {
      storeStatus("pending");
      return "skipped";
    }

    stage = "获取 QQ 头像";
    if (!managedOnly) log.write("info", "avatar_qq_fetch_started", `会员 #${id} 正在获取 QQ 头像`, context);
    const image = await fetchQqAvatar(qqNumber, signal);
    if (!image) {
      storeStatus("unavailable");
      log.write(
        "warn",
        "avatar_unavailable",
        `会员 #${id} 的 QQ 头像返回默认图，已跳过`,
        context,
        Date.now() - started,
      );
      return "unavailable";
    }
    stage = "比较头像内容";
    if (currentTag && managed && (await session.readImage(embyUserId, currentTag, signal)).equals(image.body)) {
      storeStatus("synced", currentTag);
      if (!managedOnly)
        log.write("info", "avatar_unchanged", `会员 #${id} 的头像无变化`, context, Date.now() - started);
      return "unchanged";
    }

    stage = "复核 Emby 头像";
    if (!replace) {
      const confirmedTag = await session.readTag(embyUserId, signal);
      if (confirmedTag !== currentTag) {
        if (confirmedTag) return preserveAvatar();
        return "skipped";
      }
    }

    const fresh = getSubmissionUser(database, id);
    if (fresh?.qqNumber !== qqNumber || fresh.embyUserId !== embyUserId || (managedOnly && !fresh.enabled))
      return "skipped";
    signal?.throwIfAborted();
    stage = "上传至 Emby";
    log.write("info", "avatar_upload_started", `会员 #${id} 的 QQ 头像正在上传到 Emby`, context);
    // Once a write starts, finish its bounded readback before graceful shutdown.
    writing = true;
    await session.upload(embyUserId, image);
    stage = "回读 Emby 头像";
    const tag = await session.readTag(embyUserId);
    if (!tag || !(await session.readImage(embyUserId, tag)).equals(image.body)) throw new Error("avatar_unverified");
    storeStatus("synced", tag);
    log.write("info", "avatar_updated", `会员 #${id} 的 Emby 头像已更新`, context, Date.now() - started);
    return "updated";
  } catch (error) {
    if (signal?.aborted && !writing) return "skipped";
    storeStatus("failed");
    const message = error instanceof Error ? error.message : "";
    const reason =
      /^(?:(?:image|emby)_http_\d{3}|image_timeout|qq_avatar_invalid_format|avatar_unverified|emby_connection_changed)$/.test(
        message,
      )
        ? message
        : error instanceof Error && error.name === "TimeoutError"
          ? "timeout"
          : "request_failed";
    log.write("warn", "avatar_sync_failed", `会员 #${id} ${stage}失败`, { ...context, reason }, Date.now() - started);
    return "failed";
  }
}

export function syncMemberQqAvatar(
  database: AppDatabase,
  emby: EmbyClient | undefined,
  id: number,
  options: AvatarRefreshOptions = {},
): Promise<AvatarRefreshOutcome> {
  return inMemberOrder(database, id, () => syncAvatar(database, emby, id, options));
}

export async function drainQqAvatarSync(database: AppDatabase): Promise<void> {
  await Promise.allSettled(queues.get(database)?.values() ?? []);
}

export function updateMemberProfile(
  database: AppDatabase,
  emby: EmbyClient | undefined,
  id: number,
  input: z.infer<typeof memberProfileSchema>,
  options: { admin?: boolean; logger?: WorkflowLogger | undefined } = {},
) {
  return inMemberOrder(database, id, async () => {
    const member = getSubmissionUser(database, id);
    if (!member || (!options.admin && !member.enabled)) return null;
    const changed = input.qqNumber !== member.qqNumber;
    const updated = database
      .update(submissionUsers)
      .set({
        qqNumber: input.qqNumber,
        joinSource: input.joinSource || null,
        ...(changed ? { qqAvatarSyncStatus: input.qqNumber ? "pending" : null } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(submissionUsers.id, id))
      .returning()
      .get();
    if (!updated) return null;
    if (
      updated.qqNumber &&
      (changed || !updated.qqAvatarSyncStatus || ["pending", "failed"].includes(updated.qqAvatarSyncStatus))
    )
      await syncAvatar(database, emby, id, { logger: options.logger });
    const current = getSubmissionUser(database, id);
    return current && (current.enabled || options.admin) ? toMemberProfile(current) : null;
  });
}
