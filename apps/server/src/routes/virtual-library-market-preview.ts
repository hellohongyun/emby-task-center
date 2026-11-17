import type { Express, Request, Response } from "express";
import type { AppDatabase } from "@emby-task-center/database/client";
import { z } from "zod";
import { createMarketPreview } from "../virtual-libraries/market-preview";
import type { MarketActor } from "../virtual-libraries/market-service";
import { marketAuthorAvatar } from "../virtual-libraries/market-author-avatar";
import { marketRouteError } from "./virtual-library-market";

const paging = z.strictObject({
  startIndex: z.coerce.number().int().min(0).max(1_000_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});
export function marketAvatarUrl<T extends { authorAvatarUrl?: string | null }>(value: T, base: string): T {
  return { ...value, authorAvatarUrl: value.authorAvatarUrl?.replace("/api/virtual-library-market", base) ?? null };
}
export function sendMarketImage(res: Response, image: { contentType: string; body: Buffer }) {
  res
    .set({
      "Content-Type": image.contentType,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    })
    .send(image.body);
}
export function registerMarketPreviewRoutes(
  app: Express,
  database: AppDatabase,
  base: string,
  actor: (req: Request) => MarketActor,
) {
  const preview = createMarketPreview(database);
  app.get(`${base}/:id/details`, async (req, res) => {
    const parsed = paging.safeParse(req.query);
    if (!parsed.success) return void res.status(400).json({ error: "invalid_request" });
    try {
      const result = await preview.details(
        actor(req),
        String(req.params.id),
        parsed.data.startIndex,
        parsed.data.limit,
      );
      res.set("Cache-Control", "private, no-store").json({ ...result, library: marketAvatarUrl(result.library, base) });
    } catch (error) {
      marketRouteError(res, error);
    }
  });
  for (const kind of ["author-avatar", "items/:itemId/poster"]) {
    app.get(`${base}/:id/${kind}`, async (req, res) => {
      const controller = new AbortController();
      const abort = () => {
        if (!res.writableEnded) controller.abort();
      };
      req.once("aborted", abort);
      res.once("close", abort);
      try {
        const image =
          kind === "author-avatar"
            ? await marketAuthorAvatar(database, String(req.params.id), false, controller.signal)
            : await preview.poster(
                actor(req),
                String(req.params.id),
                String((req.params as Record<string, string>).itemId),
                controller.signal,
              );
        if (!controller.signal.aborted) sendMarketImage(res, image);
      } catch (error) {
        if (!controller.signal.aborted) marketRouteError(res, error);
      } finally {
        req.off("aborted", abort);
        res.off("close", abort);
      }
    });
  }
}
