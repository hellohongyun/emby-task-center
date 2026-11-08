import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { AppDatabase } from "@emby-task-center/database/client";
import { mediaRequestCreateSchema, mediaRequestStatuses } from "@emby-task-center/contracts/media-request";
import type { PublicSession } from "../subscriptions/public-session";
import { memberAccessError } from "../subscriptions/member-access";
import { getSubmissionUserByEmail } from "../subscriptions/membership";
import type { TmdbClient } from "../tmdb/client";
import { createRateLimiter } from "../subscriptions/rate-limit";
import {
  adminRequest,
  createMediaRequestStore,
  MediaRequestError,
  publicPage,
  publicRequest,
} from "../media-requests/store";

const pageSchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(mediaRequestStatuses).optional(),
  q: z.string().trim().max(200).optional(),
});
// Match the stored version verbatim, including legacy values from before ISO normalization.
const version = z.string().min(1).max(128);
const descriptionSchema = z.object({ description: z.string().trim().max(2000), updatedAt: version }).strict();
const adminSchema = z
  .object({ status: z.enum(mediaRequestStatuses), adminNote: z.string().trim().max(2000), updatedAt: version })
  .strict();
const idSchema = z.coerce.number().int().positive();
function failure(response: Response, error: unknown) {
  if (error instanceof MediaRequestError) return response.status(error.status).json({ error: error.code });
  throw error;
}

export function registerPublicMediaRequestRoutes(
  app: Express,
  options: { database: AppDatabase; publicSession: PublicSession; tmdb: TmdbClient },
) {
  const { database, publicSession, tmdb } = options;
  const store = createMediaRequestStore(database);
  const createLimiter = createRateLimiter(30, 60_000);
  const member = (request: Request, response: Response) => {
    const { email } = publicSession.read(request.headers.cookie);
    if (!email) {
      response.status(401).json({ error: "unauthorized" });
      return null;
    }
    const error = memberAccessError(database, email, true);
    if (error) {
      response.status(403).json({ error });
      return null;
    }
    return getSubmissionUserByEmail(database, email)!;
  };
  app.get("/api/public/media-requests", (request, response) => {
    const user = member(request, response);
    if (!user) return;
    const parsed = pageSchema.safeParse(request.query);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    response.json(publicPage(store.list({ ...parsed.data, memberId: user.id })));
  });
  app.post("/api/public/media-requests", async (request, response) => {
    const user = member(request, response);
    if (!user) return;
    const parsed = mediaRequestCreateSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const input = parsed.data;
    const existing = store.active(user.id, input.mediaType, input.tmdbId, input.seasonNumber ?? null);
    if (existing) return void response.json({ request: publicRequest(existing), duplicate: true });
    if (!createLimiter.check(`member:${user.id}`)) return void response.status(429).json({ error: "rate_limited" });
    let detail;
    try {
      detail = await tmdb.details(input.mediaType, input.tmdbId);
    } catch {
      return void response.status(502).json({ error: "tmdb_lookup_failed" });
    }
    // An external lookup must not allow a member disabled during the wait to submit.
    const current = member(request, response);
    if (!current) return;
    if (current.id !== user.id) return void response.status(409).json({ error: "member_changed" });
    if (detail.id !== input.tmdbId || detail.mediaType !== input.mediaType || !detail.title.trim())
      return void response.status(502).json({ error: "tmdb_lookup_failed" });
    if (
      input.mediaType === "tv" &&
      (input.seasonNumber == null || !detail.seasons?.some((season) => season.seasonNumber === input.seasonNumber))
    )
      return void response.status(400).json({ error: "season_required" });
    const timestamp = new Date().toISOString();
    const created = store.create({
      memberId: user.id,
      memberEmail: user.email,
      kind: input.kind,
      mediaType: input.mediaType,
      tmdbId: detail.id,
      seasonNumber: input.seasonNumber ?? null,
      title: detail.title,
      originalTitle: detail.originalTitle,
      releaseYear: detail.releaseYear,
      posterUrl: detail.posterUrl,
      description: input.description,
      status: "pending",
      adminNote: "",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    response
      .status(created.duplicate ? 200 : 201)
      .json({ request: publicRequest(created.row), duplicate: created.duplicate });
  });
  app.patch("/api/public/media-requests/:id", (request, response) => {
    const user = member(request, response);
    if (!user) return;
    const parsed = descriptionSchema.safeParse(request.body);
    const id = idSchema.safeParse(request.params.id);
    if (!parsed.success || !id.success) return void response.status(400).json({ error: "invalid_request" });
    try {
      const row = store.get(id.data);
      if (row?.memberId === user.id && row.kind === "supplement" && !parsed.data.description)
        return void response.status(400).json({ error: "description_required" });
      response.json({
        request: publicRequest(
          store.update(id.data, parsed.data.updatedAt, { description: parsed.data.description }, user.email, user.id),
        ),
      });
    } catch (error) {
      failure(response, error);
    }
  });
}

/** Register after the central administrator session guard. */
export function registerAdminMediaRequestRoutes(app: Express, options: { database: AppDatabase }) {
  const store = createMediaRequestStore(options.database);
  app.get("/api/media-requests", (request, response) => {
    const parsed = pageSchema.safeParse(request.query);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const page = store.list(parsed.data);
    response.json({ ...page, items: page.items.map(adminRequest) });
  });
  app.patch("/api/media-requests/:id", (request, response) => {
    const parsed = adminSchema.safeParse(request.body);
    const id = idSchema.safeParse(request.params.id);
    if (!parsed.success || !id.success) return void response.status(400).json({ error: "invalid_request" });
    try {
      response.json({
        request: adminRequest(
          store.update(
            id.data,
            parsed.data.updatedAt,
            { status: parsed.data.status, adminNote: parsed.data.adminNote },
            "admin",
          ),
        ),
      });
    } catch (error) {
      failure(response, error);
    }
  });
}
