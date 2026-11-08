import { and, count, desc, eq, inArray, like, or, sql, type SQL } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { mediaRequests } from "@emby-task-center/database/schema";
import type {
  AdminMediaRequest,
  MediaRequest,
  MediaRequestPage,
  MediaRequestStatus,
} from "@emby-task-center/contracts/media-request";
import { audit } from "../subscriptions/domain-utils";

type Row = typeof mediaRequests.$inferSelect;
export class MediaRequestError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
  }
}
export function publicRequest(row: Row): MediaRequest {
  const { memberId: _id, memberEmail: _email, ...item } = row;
  return item;
}
export function adminRequest(row: Row): AdminMediaRequest {
  return { ...publicRequest(row), memberEmail: row.memberEmail };
}
export function createMediaRequestStore(database: AppDatabase) {
  const get = (id: number) => database.select().from(mediaRequests).where(eq(mediaRequests.id, id)).get();
  function active(memberId: number, mediaType: string, tmdbId: number, seasonNumber: number | null) {
    return database
      .select()
      .from(mediaRequests)
      .where(
        and(
          eq(mediaRequests.memberId, memberId),
          eq(mediaRequests.mediaType, mediaType as "movie" | "tv"),
          eq(mediaRequests.tmdbId, tmdbId),
          sql`coalesce(${mediaRequests.seasonNumber}, -1) = ${seasonNumber ?? -1}`,
          inArray(mediaRequests.status, ["pending", "processing"]),
        ),
      )
      .get();
  }
  function list(options: {
    page: number;
    pageSize: number;
    memberId?: number;
    status?: MediaRequestStatus;
    q?: string;
  }) {
    const conditions: SQL[] = [];
    if (options.memberId !== undefined) conditions.push(eq(mediaRequests.memberId, options.memberId));
    if (options.status) conditions.push(eq(mediaRequests.status, options.status));
    if (options.q)
      conditions.push(
        or(
          like(mediaRequests.title, `%${options.q}%`),
          like(mediaRequests.originalTitle, `%${options.q}%`),
          like(mediaRequests.memberEmail, `%${options.q}%`),
        )!,
      );
    const where = and(...conditions);
    return database.transaction((tx) => ({
      items: tx
        .select()
        .from(mediaRequests)
        .where(where)
        .orderBy(desc(mediaRequests.id))
        .limit(options.pageSize)
        .offset((options.page - 1) * options.pageSize)
        .all(),
      total: tx.select({ total: count() }).from(mediaRequests).where(where).get()!.total,
      page: options.page,
      pageSize: options.pageSize,
    }));
  }
  function create(value: Omit<typeof mediaRequests.$inferInsert, "id">) {
    return database.transaction(
      (tx) => {
        const existing = active(value.memberId, value.mediaType, value.tmdbId, value.seasonNumber ?? null);
        if (existing) return { row: existing, duplicate: true };
        const availableAt =
          value.status === "available" && Number.isFinite(Date.parse(value.availableAt ?? value.updatedAt))
            ? new Date(value.availableAt ?? value.updatedAt).toISOString()
            : null;
        const row = tx
          .insert(mediaRequests)
          .values({ ...value, availableAt })
          .returning()
          .get();
        audit(tx, value.memberEmail, "media_request.created", "media_request", row.id, undefined, publicRequest(row));
        return { row, duplicate: false };
      },
      { behavior: "immediate" },
    );
  }
  function update(
    id: number,
    version: string,
    values: { status?: MediaRequestStatus; adminNote?: string; description?: string },
    operator: string,
    memberId?: number,
  ) {
    return database.transaction(
      (tx) => {
        const row = get(id);
        if (!row || (memberId !== undefined && row.memberId !== memberId))
          throw new MediaRequestError("request_not_found", 404);
        if (row.updatedAt !== version) throw new MediaRequestError("request_changed", 409);
        if (memberId !== undefined && !["pending", "processing"].includes(row.status))
          throw new MediaRequestError("request_closed", 409);
        if (values.status && ["pending", "processing"].includes(values.status)) {
          const duplicate = active(row.memberId, row.mediaType, row.tmdbId, row.seasonNumber);
          if (duplicate && duplicate.id !== row.id) throw new MediaRequestError("request_already_active", 409);
        }
        const previousTime = Date.parse(row.updatedAt);
        const now = Date.now();
        const updatedAt = new Date(Number.isFinite(previousTime) ? Math.max(now, previousTime + 1) : now).toISOString();
        const nextStatus = values.status ?? row.status;
        const availableAt =
          nextStatus !== "available" ? null : row.status === "available" ? row.availableAt : updatedAt;
        const changed = tx
          .update(mediaRequests)
          .set({ ...values, updatedAt, availableAt })
          .where(and(eq(mediaRequests.id, id), eq(mediaRequests.updatedAt, version)))
          .returning()
          .get();
        if (!changed) throw new MediaRequestError("request_changed", 409);
        audit(
          tx,
          operator,
          memberId === undefined ? "media_request.updated" : "media_request.description",
          "media_request",
          id,
          publicRequest(row),
          publicRequest(changed),
        );
        return changed;
      },
      { behavior: "immediate" },
    );
  }
  return { get, active, list, create, update };
}
export type MediaRequestStore = ReturnType<typeof createMediaRequestStore>;
export function publicPage(page: ReturnType<MediaRequestStore["list"]>): MediaRequestPage {
  return { ...page, items: page.items.map(publicRequest) };
}
