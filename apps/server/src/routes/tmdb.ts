import type { Express } from "express";
import { z } from "zod";

import type { TmdbClient } from "../tmdb/client";

const SearchSchema = z.object({ q: z.string().trim().min(1).max(100) });
const DetailsSchema = z.object({
  type: z.enum(["movie", "tv"]),
  id: z.coerce.number().int().positive(),
});
const SeasonSchema = z.object({
  id: z.coerce.number().int().positive(),
  season: z.coerce.number().int().min(0),
});

export function registerTmdbRoutes(app: Express, tmdb: TmdbClient): void {
  app.get("/api/tmdb/search", async (request, response, next) => {
    const parsed = SearchSchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ error: "invalid_request" });
      return;
    }
    try {
      response.json({ results: await tmdb.search(parsed.data.q) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/tmdb/tv/:id/season/:season", async (request, response, next) => {
    const parsed = SeasonSchema.safeParse(request.params);
    if (!parsed.success) {
      response.status(400).json({ error: "invalid_request" });
      return;
    }
    try {
      response.json({ result: await tmdb.seasonProgress(parsed.data.id, parsed.data.season) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/tmdb/:type/:id", async (request, response, next) => {
    const parsed = DetailsSchema.safeParse(request.params);
    if (!parsed.success) {
      response.status(400).json({ error: "invalid_request" });
      return;
    }
    try {
      response.json({ result: await tmdb.details(parsed.data.type, parsed.data.id) });
    } catch (error) {
      next(error);
    }
  });
}
