import type { Express } from "express";
import { z } from "zod";
import type { AppDatabase } from "@emby-task-center/database/client";
import { createVirtualLibraryStore } from "../virtual-libraries/store";
import { createVirtualLibraryMarketService } from "../virtual-libraries/market-service";
import { marketRouteError } from "./virtual-library-market";
import { libraryPoster } from "../virtual-libraries/library-poster";
import { registerUpstreamMarketRoutes } from "./virtual-library-market-upstream";
import { createEmbyClient } from "../integrations/emby-client";
import { readSettings } from "../settings/store";
import { and, eq } from "drizzle-orm";
import { virtualLibraries, virtualLibraryItems } from "@emby-task-center/database/schema";

const defaultsSchema = z.strictObject({
  libraryIds: z.array(z.string().min(1)).max(10000),
  adminEmbyUserId: z.string().trim().min(1).nullable(),
});
const defaultsPatchSchema = defaultsSchema
  .partial()
  .refine((value) => value.libraryIds !== undefined || value.adminEmbyUserId !== undefined);
/** Register only after the administrator authentication gate. No author-write route here. */
export function registerMarketAdminRoutes(app: Express, database: AppDatabase, base: string) {
  registerUpstreamMarketRoutes(app, database, base);
  const service = createVirtualLibraryMarketService(database),
    store = createVirtualLibraryStore(database, { all: true });
  const images = createEmbyClient({
    resolve: () => {
      const { values } = readSettings(database);
      return { baseUrl: values["emby.baseUrl"], apiKey: values["emby.apiKey"] };
    },
  });
  app.get(`${base}/defaults`, (_req, res) => res.json(service.readDefaults()));
  app.put(`${base}/defaults`, (req, res) => {
    const parsed = defaultsSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "invalid_request" });
    try {
      res.json(service.saveDefaults(parsed.data));
    } catch (error) {
      marketRouteError(res, error);
    }
  });
  app.patch(`${base}/defaults`, (req, res) => {
    const parsed = defaultsPatchSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "invalid_request" });
    try {
      res.json(service.patchDefaults(parsed.data));
    } catch (error) {
      marketRouteError(res, error);
    }
  });
  app.get(`${base}/user-libraries`, (_req, res) => res.json({ libraries: service.userLibraries() }));
  app.get(`${base}/user-libraries/:id/items`, (req, res) => {
    const id = String(req.params.id),
      library = store.get(id);
    if (!library || library.ownerMemberId == null)
      return void res.status(404).json({ error: "virtual_library_not_found" });
    // Read stored associations only: inspection must not run mapping repair or mutate authors' libraries.
    res.json({ items: store.listItems(id) });
  });
  app.get(`${base}/user-libraries/:id/items/:itemId/poster`, async (req, res) => {
    const libraryId = String(req.params.id),
      itemId = String(req.params.itemId);
    const library = database
      .select({ ownerMemberId: virtualLibraries.ownerMemberId })
      .from(virtualLibraries)
      .where(eq(virtualLibraries.id, libraryId))
      .get();
    if (
      !library ||
      library.ownerMemberId == null ||
      !database
        .select({ itemId: virtualLibraryItems.itemId })
        .from(virtualLibraryItems)
        .where(and(eq(virtualLibraryItems.libraryId, libraryId), eq(virtualLibraryItems.itemId, itemId)))
        .get()
    )
      return void res.status(404).json({ error: "virtual_library_item_not_found" });
    // Inspection never repairs mappings or changes the author's content.
    const controller = new AbortController();
    const abort = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once("aborted", abort);
    res.once("close", abort);
    try {
      const image = await images.image?.(itemId, "Primary", controller.signal);
      if (controller.signal.aborted || res.destroyed) return;
      if (
        !image ||
        !["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/bmp"].includes(
          image.contentType.split(";")[0].trim().toLowerCase(),
        )
      )
        return void res.status(404).json({ error: "poster_not_found" });
      res
        .set({
          "Content-Type": image.contentType,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        })
        .send(image.body);
    } finally {
      req.off("aborted", abort);
      res.off("close", abort);
    }
  });
  app.get(`${base}/user-libraries/:id/poster`, (req, res) => {
    const id = String(req.params.id),
      library = store.get(id);
    if (!library || library.ownerMemberId == null)
      return void res.status(404).json({ error: "virtual_library_not_found" });
    const poster = libraryPoster(store, id);
    res
      .set({
        "Content-Type": poster.contentType,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      })
      .send(poster.content);
  });
}
