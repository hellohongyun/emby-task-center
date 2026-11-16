import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { AppDatabase } from "@emby-task-center/database/client";
import type { PublicSession } from "../subscriptions/public-session";
import { getSubmissionUserByEmail } from "../subscriptions/membership";
import { memberAccessError } from "../subscriptions/member-access";
import { createVirtualLibraryMarketService } from "../virtual-libraries/market-service";
import { createVirtualLibrarySource, VirtualLibrarySourceError } from "../virtual-libraries/source";
import { createPersonalLibraryOrderService } from "../virtual-libraries/personal-library-order";
import {
  personalLibraryOrderCatalog,
  personalOrderUpstream,
} from "../virtual-libraries/personal-library-order-catalog";
import { createEmbyLibraryOrderStore } from "../integrations/emby-library-order-store";
import { readSettings } from "../settings/store";
import { viewIdentity } from "../virtual-libraries/owned-view-preferences";
import { createVirtualLibraryStore } from "../virtual-libraries/store";
import { libraryPoster } from "../virtual-libraries/library-poster";
import { createUpstreamLibraryMarketService } from "../virtual-libraries/upstream-market-service";

const orderSchema = z.strictObject({ order: z.array(z.string().min(1).max(256)).max(5000) });

export function registerPersonalLibraryOrderRoutes(
  app: Express,
  options: {
    database: AppDatabase;
    publicSession?: PublicSession;
    sourceForUser?: (userId: string) => ReturnType<typeof createVirtualLibrarySource>;
  },
) {
  const { database } = options;
  const market = createVirtualLibraryMarketService(database);
  const store = createVirtualLibraryStore(database, { all: true });
  const orders = createPersonalLibraryOrderService(database);
  const source = (id: string) =>
    options.sourceForUser?.(id) ?? createVirtualLibrarySource(database, fetch, id, personalOrderUpstream(database));
  function identity(request: Request, response: Response, admin: boolean) {
    if (admin) {
      const id = market.readDefaults().adminEmbyUserId;
      if (!id) response.status(403).json({ error: "admin_emby_account_required" });
      return id ?? undefined;
    }
    const { email } = options.publicSession!.read(request.headers.cookie);
    const member = email ? getSubmissionUserByEmail(database, email) : null;
    if (!member) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    const error = memberAccessError(database, member.email, true);
    if (error) {
      response.status(403).json({ error });
      return;
    }
    if (!member.embyUserId) {
      response.status(403).json({ error: "emby_account_required" });
      return;
    }
    return member.embyUserId;
  }
  function fail(response: Response, error: unknown) {
    if (error instanceof VirtualLibrarySourceError)
      response.status(error.status).json({ error: "emby_source_unavailable", message: error.message });
    else response.status(503).json({ error: "library_order_unavailable" });
  }
  function validateOrder(body: unknown, visible: readonly { id: string }[]) {
    const parsed = orderSchema.safeParse(body);
    if (!parsed.success) return;
    const allowed = new Set(visible.map((item) => viewIdentity(item.id)));
    const ids = parsed.data.order.map(viewIdentity);
    if (new Set(ids).size !== ids.length || ids.some((id) => !allowed.has(id))) return;
    return ids;
  }
  function sendPoster(response: Response, id: string) {
    const poster = libraryPoster(store, id);
    response
      .set({
        "Content-Type": poster.contentType,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      })
      .send(poster.content);
  }
  for (const admin of [!options.publicSession]) {
    const base = admin ? "/api/virtual-library-order" : "/api/public/virtual-library-order";
    app.get(`${base}/:id/poster`, (request, response) => {
      const userId = identity(request, response, admin);
      if (!userId) return;
      const id = String(request.params.id);
      const allowed = market.resolveAccess(userId)?.visibleLibraryIds.includes(id);
      if (!allowed || !store.get(id)) return void response.status(404).json({ error: "virtual_library_not_found" });
      sendPoster(response, id);
    });
    app.get(base, async (request, response) => {
      const id = identity(request, response, admin);
      if (!id) return;
      try {
        response.json(await personalLibraryOrderCatalog(database, id, source(id)));
      } catch (error) {
        fail(response, error);
      }
    });
    app.put(base, async (request, response) => {
      const id = identity(request, response, admin);
      if (!id) return;
      try {
        const current = await personalLibraryOrderCatalog(database, id, source(id));
        const order = validateOrder(request.body, current.items);
        if (!order) return void response.status(400).json({ error: "invalid_library_order" });
        const sent = new Set(order);
        const complete = [...order, ...current.order.filter((value) => !sent.has(viewIdentity(value)))];
        orders.write(personalOrderUpstream(database), id, complete);
        response.json(await personalLibraryOrderCatalog(database, id, source(id)));
      } catch (error) {
        fail(response, error);
      }
    });
    app.delete(base, async (request, response) => {
      const id = identity(request, response, admin);
      if (!id) return;
      try {
        orders.reset(personalOrderUpstream(database), id);
        response.json(await personalLibraryOrderCatalog(database, id, source(id)));
      } catch (error) {
        fail(response, error);
      }
    });
  }
  if (options.publicSession) return;
  async function defaultCatalog(id: string) {
    const listed = market.list({ adminId: "primary-admin" });
    const externalRows = createUpstreamLibraryMarketService(database).rows();
    const externalByMarket = new Map(externalRows.map((library) => [library.id, library]));
    const externalIds = new Set(
      externalRows.flatMap((library) =>
        [library.sourceId, library.sourceGuid].filter((id): id is string => !!id).map(viewIdentity),
      ),
    );
    const virtualIds = new Set(
      createVirtualLibraryStore(database, { all: true })
        .list()
        .map((library) => viewIdentity(library.id)),
    );
    const items = [
      ...(await source(id).libraries({ includeGuid: true }))
        .filter(
          (item) =>
            !virtualIds.has(viewIdentity(item.id)) &&
            !externalIds.has(viewIdentity(item.id)) &&
            !(item.guid && externalIds.has(viewIdentity(item.guid))),
        )
        .map((item) => ({ ...item, kind: "native" as const })),
      ...listed.map((library) => ({
        id: library.playbackId ?? library.id,
        name: library.name,
        kind: "subscribed" as const,
        ...(library.posterImageTag ? { posterImageTag: library.posterImageTag } : {}),
        ...(library.source === "tgtodrive" ? { marketId: library.id, source: library.source } : {}),
        ...(externalByMarket.get(library.id)?.sourceGuid
          ? { guid: externalByMarket.get(library.id)!.sourceGuid! }
          : {}),
      })),
    ];
    const upstream = personalOrderUpstream(database);
    const base = readSettings(database).values["emby.baseUrl"] || upstream;
    const template = createEmbyLibraryOrderStore(database).readActive(base, upstream);
    const aliases = new Map(
      items.flatMap((item) =>
        [item.id, ...("guid" in item && item.guid ? [item.guid] : [])].map(
          (id) => [viewIdentity(id), item.id] as const,
        ),
      ),
    );
    const configured = [...new Set((template?.order ?? []).flatMap((id) => aliases.get(viewIdentity(id)) ?? []))];
    return {
      items: items.map((item) => ({
        id: item.id,
        name: item.name,
        kind: item.kind,
        ...("posterImageTag" in item ? { posterImageTag: item.posterImageTag } : {}),
        ...("marketId" in item ? { marketId: item.marketId, source: item.source } : {}),
      })),
      order: [...configured, ...items.map((item) => item.id).filter((id) => !configured.includes(id))],
      hasPersonalOrder: false,
    };
  }
  app.get("/api/virtual-library-market/order/:id/poster", (request, response) => {
    if (!identity(request, response, true)) return;
    const id = String(request.params.id);
    if (!market.list({ adminId: "primary-admin" }).some((library) => library.id === id))
      return void response.status(404).json({ error: "virtual_library_not_found" });
    sendPoster(response, id);
  });
  app.get("/api/virtual-library-market/order", async (request, response) => {
    const id = identity(request, response, true);
    if (!id) return;
    try {
      response.json(await defaultCatalog(id));
    } catch (error) {
      fail(response, error);
    }
  });
  app.put("/api/virtual-library-market/order", async (request, response) => {
    const id = identity(request, response, true);
    if (!id) return;
    try {
      const catalog = await defaultCatalog(id);
      const order = validateOrder(request.body, catalog.items);
      if (!order) return void response.status(400).json({ error: "invalid_library_order" });
      const upstream = personalOrderUpstream(database);
      const base = readSettings(database).values["emby.baseUrl"] || upstream;
      const names = Object.fromEntries(catalog.items.map((item) => [item.id, item.name]));
      const templates = createEmbyLibraryOrderStore(database);
      database.transaction(() => {
        templates.save(base, order, names);
        templates.activate(base, upstream, order, names);
      });
      response.json({ items: catalog.items, order });
    } catch (error) {
      fail(response, error);
    }
  });
}
