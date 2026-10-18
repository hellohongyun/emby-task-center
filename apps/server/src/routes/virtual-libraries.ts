import type { Express, Response } from "express";
import { z } from "zod";
import type { AppDatabase } from "@emby-task-center/database/client";
import {
  AddVirtualLibraryItemsSchema,
  CreateVirtualLibrarySchema,
  UpdateVirtualLibrarySchema,
} from "@emby-task-center/contracts/virtual-library";
import { createVirtualLibraryStore, VirtualLibraryNotFoundError } from "../virtual-libraries/store";
import { createVirtualLibrarySource, VirtualLibrarySourceError } from "../virtual-libraries/source";
import { VirtualLibraryTypeMismatchError } from "../virtual-libraries/type-validation";
import { repairVirtualMappings } from "../virtual-libraries/mapping-repair";

const sourceQuerySchema = z.object({
  searchTerm: z.string().optional(),
  parentId: z.string().optional(),
  types: z.enum(["Movie", "Series", "Movie,Series"]).optional(),
  startIndex: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).default(50),
});

/** 注册在管理员登录门后；此管理接口只维护虚拟库及关联，不修改原 Emby 媒体。 */
export function registerVirtualLibraryRoutes(
  app: Express,
  options: {
    database: AppDatabase;
    source?: ReturnType<typeof createVirtualLibrarySource>;
  },
): void {
  const store = createVirtualLibraryStore(options.database);
  const source = options.source ?? createVirtualLibrarySource(options.database);
  const base = "/api/virtual-libraries";
  function fail(response: Response, error: unknown) {
    if (error instanceof VirtualLibraryNotFoundError) {
      response.status(404).json({ error: "virtual_library_not_found", message: error.message });
    } else if (error instanceof VirtualLibraryTypeMismatchError) {
      response.status(400).json({ error: "virtual_library_type_mismatch", message: error.message });
    } else if (error instanceof VirtualLibrarySourceError) {
      response.status(error.status).json({ error: "emby_source_unavailable", message: error.message });
    } else throw error;
  }

  app.get(`${base}/source-libraries`, async (_request, response) => {
    try {
      response.json({ items: await source.libraries() });
    } catch (error) {
      fail(response, error);
    }
  });
  app.get(`${base}/source-items`, async (request, response) => {
    const parsed = sourceQuerySchema.safeParse(request.query);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    try {
      response.json(await source.search(parsed.data));
    } catch (error) {
      fail(response, error);
    }
  });
  app.get(base, (_request, response) => {
    response.json({ libraries: store.list() });
  });
  app.post(base, (request, response) => {
    const parsed = CreateVirtualLibrarySchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    response.status(201).json({ library: store.create(parsed.data) });
  });
  app.patch(`${base}/:id`, (request, response) => {
    const parsed = UpdateVirtualLibrarySchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    try {
      response.json({ library: store.update(String(request.params.id), parsed.data) });
    } catch (error) {
      fail(response, error);
    }
  });
  app.delete(`${base}/:id`, (request, response) => {
    if (!store.remove(String(request.params.id))) {
      return void response.status(404).json({ error: "virtual_library_not_found" });
    }
    response.status(204).end();
  });
  app.get(`${base}/:id/items`, async (request, response) => {
    const id = String(request.params.id);
    if (!store.get(id)) return void response.status(404).json({ error: "virtual_library_not_found" });
    try {
      const result = await repairVirtualMappings(store, id, source);
      response.json(result.issues.length ? result : { items: result.items });
    } catch (error) {
      fail(response, error);
    }
  });
  app.post(`${base}/:id/items`, async (request, response) => {
    const parsed = AddVirtualLibraryItemsSchema.safeParse(request.body);
    if (!parsed.success) return void response.status(400).json({ error: "invalid_request" });
    const id = String(request.params.id);
    if (!store.get(id)) return void response.status(404).json({ error: "virtual_library_not_found" });
    try {
      const items = await source.getItems(parsed.data.itemIds);
      if (items.some((item) => !["Movie", "Series"].includes(item.type))) {
        return void response.status(400).json({
          error: "virtual_library_work_required",
          message: "请选择电影或整部剧集，不支持单独加入季、分集或其他类型。",
        });
      }
      response.json({ items: store.addItems(id, items) });
    } catch (error) {
      fail(response, error);
    }
  });
  app.delete(`${base}/:id/items/:itemId`, (request, response) => {
    try {
      store.removeItem(String(request.params.id), String(request.params.itemId));
      response.status(204).end();
    } catch (error) {
      fail(response, error);
    }
  });
}
