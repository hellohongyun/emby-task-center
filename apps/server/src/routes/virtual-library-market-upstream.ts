import type { Express, Response } from "express";
import { z } from "zod";
import type { AppDatabase } from "@emby-task-center/database/client";
import { createUpstreamLibraryMarketService } from "../virtual-libraries/upstream-market-service";
import { UpstreamLibraryError } from "../virtual-libraries/upstream-library-catalog";

export function registerUpstreamMarketRoutes(app: Express, database: AppDatabase, base: string) {
  const external = createUpstreamLibraryMarketService(database);
  const respond = async (res: Response, work: () => unknown) => {
    try {
      res.json(await work());
    } catch (error) {
      if (error instanceof UpstreamLibraryError) res.status(error.status).json({ error: error.code });
      else throw error;
    }
  };
  app.get(`${base}/upstream`, (_req, res) => res.json(external.status()));
  app.post(`${base}/upstream/sync`, (_req, res) => respond(res, () => external.sync()));
  app.post(`${base}/upstream/import`, (req, res) => {
    const parsed = z
      .strictObject({ sourceIds: z.array(z.string().min(1).max(256)).min(1).max(10000) })
      .safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "invalid_request" });
    return respond(res, () => external.import(parsed.data.sourceIds));
  });
  app.put(`${base}/upstream/:id/publication`, (req, res) => {
    const parsed = z.strictObject({ published: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "invalid_request" });
    return respond(res, () => ({ library: external.publication(String(req.params.id), parsed.data.published) }));
  });
}
