import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { AppDatabase } from "@emby-task-center/database/client";
import type { PublicSession } from "../subscriptions/public-session";
import { getSubmissionUserByEmail } from "../subscriptions/membership";
import { memberAccessError } from "../subscriptions/member-access";
import { createVirtualLibraryStore } from "../virtual-libraries/store";
import { createVirtualLibraryMarketService, MarketError, type MarketActor } from "../virtual-libraries/market-service";
import { registerMarketAdminRoutes } from "./virtual-library-market-admin";
import { prepareMarketSubscriptionOrder } from "../virtual-libraries/personal-library-order-catalog";
import { libraryPoster } from "../virtual-libraries/library-poster";
import { createUpstreamLibraryMarketService } from "../virtual-libraries/upstream-market-service";
import { UpstreamLibraryError } from "../virtual-libraries/upstream-library-catalog";
import { upstreamMarketPoster } from "../virtual-libraries/upstream-market-poster";
import { marketAvatarUrl, registerMarketPreviewRoutes } from "./virtual-library-market-preview";

const publicationSchema = z.strictObject({ published: z.boolean() });
const subscriptionSchema = z.strictObject({ enabled: z.boolean() });
export function marketRouteError(response: Response, error: unknown) {
  if (error instanceof MarketError || error instanceof UpstreamLibraryError)
    return void response.status(error.status).json({ error: error.code });
  throw error;
}
export function registerVirtualLibraryMarketRoutes(
  app: Express,
  options: { database: AppDatabase; publicSession?: PublicSession },
) {
  const { database, publicSession } = options;
  const service = createVirtualLibraryMarketService(database);
  const external = createUpstreamLibraryMarketService(database);
  const store = createVirtualLibraryStore(database, { all: true });
  const base = publicSession ? "/api/public/virtual-library-market" : "/api/virtual-library-market";
  function memberFor(req: Request) {
    const email = publicSession?.read(req.headers.cookie).email;
    return email ? getSubmissionUserByEmail(database, email) : null;
  }
  function actor(req: Request): MarketActor {
    return publicSession ? { memberId: memberFor(req)!.id } : { adminId: "primary-admin" };
  }
  if (publicSession)
    app.use(base, (req, res, next) => {
      const member = memberFor(req);
      if (!member) return void res.status(401).json({ error: "unauthorized" });
      const error = memberAccessError(database, member.email, true);
      if (error) return void res.status(403).json({ error });
      if (!member.embyUserId) return void res.status(403).json({ error: "emby_account_required" });
      next();
    });
  else registerMarketAdminRoutes(app, database, base);
  registerMarketPreviewRoutes(app, database, base, actor);
  app.get(base, (req, res) =>
    res.json({ libraries: service.list(actor(req)).map((value) => marketAvatarUrl(value, base)) }),
  );
  app.put(`${base}/owned/:id/publication`, (req, res) => {
    const parsed = publicationSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "invalid_request" });
    try {
      res.json({ library: service.publication(actor(req), String(req.params.id), parsed.data.published) });
    } catch (error) {
      marketRouteError(res, error);
    }
  });
  app.put(`${base}/:id/subscription`, async (req, res) => {
    const parsed = subscriptionSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "invalid_request" });
    try {
      const subscriberId = service.subscriberFor(actor(req));
      const id = String(req.params.id);
      const library = store.get(id),
        upstream = external.get(id);
      if (
        upstream
          ? parsed.data.enabled && (!upstream.available || !upstream.published)
          : !library || (parsed.data.enabled && !service.available(library))
      )
        throw new MarketError(404, "virtual_library_not_found");
      if (!service.canSubscribe(actor(req), id)) throw new MarketError(409, "own_library_always_visible");
      const userId = publicSession ? memberFor(req)!.embyUserId : service.readDefaults().adminEmbyUserId;
      const order =
        parsed.data.enabled && !service.isEnabled(subscriberId, id) && userId
          ? await prepareMarketSubscriptionOrder(database, userId)
          : undefined;
      const enabled = database.transaction(() => {
        const value = service.subscribe(subscriberId, id, parsed.data.enabled);
        order?.append(upstream?.sourceId ?? id);
        return value;
      });
      res.json({ enabled });
    } catch (error) {
      marketRouteError(res, error);
    }
  });
  app.get(`${base}/:id/poster`, async (req, res) => {
    const id = String(req.params.id),
      library = store.get(id);
    const upstream = external.get(id);
    if (upstream) {
      if (!upstream.available || !upstream.published)
        return void res.status(404).json({ error: "virtual_library_not_found" });
      const poster = await upstreamMarketPoster(database, upstream.sourceId);
      return void res
        .set({
          "Content-Type": poster.contentType,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        })
        .send(poster.content);
    }
    if (!library || !service.available(library))
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
