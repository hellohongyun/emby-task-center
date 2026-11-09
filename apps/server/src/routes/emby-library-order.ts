import { randomUUID } from "node:crypto";
import type { Express, Response } from "express";
import { z } from "zod";
import type { AppDatabase } from "@emby-task-center/database/client";
import type { EmbyClient } from "../integrations/emby-client";
import { aliasMap, publicLibraries, readCatalog, resolveOrder } from "../integrations/emby-library-order-catalog";
import { sameOrder, viewIdentity } from "../integrations/emby-library-order-plan";
import { createEmbyLibraryOrderStore, expandLibraryOrder } from "../integrations/emby-library-order-store";
import { audit } from "../subscriptions/domain-utils";
import { createOwnedViewPreferences } from "../virtual-libraries/owned-view-preferences";
import { readVirtualProxyConfig } from "../virtual-libraries/proxy-settings";
import { createVirtualLibraryStore } from "../virtual-libraries/store";
import type { VirtualLibraryProxy } from "../virtual-libraries/proxy";
import { applyLibraryOrder, type LibraryOrderPreview } from "./emby-library-order-apply";
import { previewTarget } from "./emby-library-order-targets";

const path = "/api/emby/library-order";
const saveSchema = z.strictObject({ order: z.array(z.string().min(1).max(128)).min(1).max(500) });
const previewSchema = z.strictObject({
  userIds: z.array(z.string().min(1).max(128)).min(1).max(200).optional(),
});
const applySchema = z.strictObject({ previewToken: z.uuid() });
const previewLifetimeMs = 5 * 60 * 1000;
const previewLimit = 12;

function fail(response: Response, status: number, error: string) {
  response.status(status).json({ error });
}

function catalogCanSave(
  catalog: Awaited<ReturnType<typeof readCatalog>>,
  proxyRequired: boolean,
  ...previousOrders: (string[] | undefined)[]
) {
  if (proxyRequired && catalog.proxyUnavailable) return false;
  if (!catalog.incomplete) return true;
  const known = aliasMap(catalog.entries);
  return !previousOrders.some((order) => order?.some((id) => !known.has(viewIdentity(id))));
}

export function registerEmbyLibraryOrderRoutes(
  app: Express,
  emby: EmbyClient | undefined,
  database: AppDatabase,
  virtualProxy?: VirtualLibraryProxy,
): void {
  const open = () => emby?.openLibraryOrderSession?.();
  const store = createEmbyLibraryOrderStore(database);
  const virtualLibraries = createVirtualLibraryStore(database);
  const preferences = createOwnedViewPreferences(database, virtualLibraries);
  const ownedLibraries = () => virtualLibraries.list().map(({ id, name }) => ({ id, name }));
  const proxyConfig = () => readVirtualProxyConfig(database);
  const proxyUpstream = (baseUrl: string) => proxyConfig().upstream.replace(/\/+$/, "") || baseUrl;
  const openProxy = (session: NonNullable<ReturnType<typeof open>>, upstream: string) =>
    upstream === session.baseUrl ? session : (emby?.openLibraryOrderSession?.(upstream) ?? null);
  const isCurrent = (session: NonNullable<ReturnType<typeof open>>, upstream?: string) =>
    open()?.identity === session.identity && (upstream === undefined || proxyUpstream(session.baseUrl) === upstream);
  const proxyState = () => {
    const config = proxyConfig();
    const status = virtualProxy?.status();
    return {
      configured: Boolean(config.upstream),
      enabled: config.enabled,
      running: Boolean(status?.running),
      port: status?.port ?? null,
      upstream: config.upstream || null,
    };
  };
  const previews = new Map<string, LibraryOrderPreview>();
  let applying = false;

  app.use(path, (_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  app.get(path, async (_request, response) => {
    const session = open();
    if (!session) return fail(response, 503, "library_order_not_configured");
    try {
      const proxy = proxyState();
      const upstream = proxyUpstream(session.baseUrl);
      const catalog = await readCatalog(session, ownedLibraries(), openProxy(session, upstream));
      if (!isCurrent(session, upstream)) return fail(response, 409, "library_order_connection_changed");
      const saved = store.read(session.baseUrl);
      const active = store.readActive(session.baseUrl, upstream);
      const order = resolveOrder(saved?.order ?? catalog.suggestedOrder, catalog.entries, catalog.suggestedOrder);
      response.json({
        configured: true,
        libraries: publicLibraries(catalog.entries, order),
        order,
        savedOrder: saved?.order ?? [],
        saved: Boolean(saved),
        updatedAt: saved?.updatedAt ?? null,
        active: Boolean(active),
        activeOrder: active?.order ?? [],
        users: catalog.users,
        warnings: catalog.warnings,
        proxy,
      });
    } catch {
      fail(response, 502, "library_order_read_failed");
    }
  });

  app.put(path, async (request, response) => {
    const parsed = saveSchema.safeParse(request.body);
    if (!parsed.success) return fail(response, 400, "invalid_request");
    if (applying) return fail(response, 409, "library_order_busy");
    const session = open();
    if (!session) return fail(response, 503, "library_order_not_configured");
    try {
      const previous = store.read(session.baseUrl);
      const proxy = proxyState();
      const upstream = proxyUpstream(session.baseUrl);
      const catalog = await readCatalog(session, ownedLibraries(), openProxy(session, upstream));
      if (!isCurrent(session, upstream)) return fail(response, 409, "library_order_connection_changed");
      if (applying) return fail(response, 409, "library_order_busy");
      if (store.read(session.baseUrl)?.revision !== previous?.revision) {
        return fail(response, 409, "library_order_order_changed");
      }
      if (!catalogCanSave(catalog, proxy.configured || proxy.enabled, previous?.order)) {
        return fail(response, 502, "library_order_proxy_read_failed");
      }
      const aliases = aliasMap(catalog.entries);
      const seen = new Set<string>();
      for (const token of parsed.data.order) {
        const entry = aliases.get(viewIdentity(token));
        if (!entry) return fail(response, 400, "library_order_unknown_library");
        if (seen.has(entry.id)) return fail(response, 400, "library_order_duplicate_library");
        seen.add(entry.id);
      }
      const order = resolveOrder([...seen], catalog.entries, catalog.suggestedOrder);
      const names = Object.fromEntries(catalog.entries.map(({ id, name }) => [id, name]));
      const saved = database.transaction(() => {
        const result = store.save(session.baseUrl, order, names);
        audit(
          database,
          "admin",
          "emby_library_order.saved",
          "emby_library_order",
          undefined,
          previous ? { order: previous.order } : null,
          { order, names },
          "保存媒体库顺序草稿",
        );
        return result;
      });
      response.json({ order, updatedAt: saved.updatedAt, libraries: publicLibraries(catalog.entries, order) });
    } catch {
      fail(response, 502, "library_order_read_failed");
    }
  });

  app.post(`${path}/preview`, async (request, response) => {
    const parsed = previewSchema.safeParse(request.body);
    if (!parsed.success) return fail(response, 400, "invalid_request");
    if (applying) return fail(response, 409, "library_order_busy");
    const session = open();
    if (!session) return fail(response, 503, "library_order_not_configured");
    try {
      const draft = store.read(session.baseUrl);
      if (!draft) return fail(response, 409, "library_order_not_saved");
      const owned = ownedLibraries();
      const ownedIds = owned.map(({ id }) => viewIdentity(id)).sort();
      const proxy = proxyState();
      const upstream = proxyUpstream(session.baseUrl);
      const catalog = await readCatalog(session, owned, openProxy(session, upstream));
      if (!isCurrent(session, upstream)) return fail(response, 409, "library_order_connection_changed");
      if (applying) return fail(response, 409, "library_order_busy");
      if (store.read(session.baseUrl)?.revision !== draft.revision) {
        return fail(response, 409, "library_order_order_changed");
      }
      const requested = parsed.data.userIds ? new Set(parsed.data.userIds) : undefined;
      const active = requested ? null : store.readActive(session.baseUrl, upstream);
      if (!requested && !catalogCanSave(catalog, proxy.configured || proxy.enabled, draft.order, active?.order)) {
        return fail(response, 502, "library_order_proxy_read_failed");
      }
      const order = resolveOrder(draft.order, catalog.entries, catalog.suggestedOrder);
      if (!order.length) return fail(response, 409, "library_order_order_changed");
      const accounts = requested ? catalog.users.filter(({ id }) => requested.has(id)) : catalog.users;
      if (requested && accounts.length !== requested.size) return fail(response, 400, "library_order_unknown_user");

      const names = Object.fromEntries(catalog.entries.map(({ id, name }) => [id, name]));
      const aliases = Object.fromEntries(catalog.entries.map((entry) => [entry.id, [...entry.aliases]]));
      const expanded = expandLibraryOrder(order, aliases);
      const proxyOnlyIds = new Set(
        catalog.entries.filter((entry) => !entry.direct).flatMap((entry) => [...entry.aliases]),
      );
      const proxyPreview = requested ? undefined : upstream;
      const before = active ? expandLibraryOrder(active.order, active.aliases) : undefined;
      const proxyChanged = Boolean(proxyPreview && (!before || !sameOrder(before, expanded)));
      const targets = accounts.map((account) =>
        previewTarget(
          account,
          catalog.snapshots.get(account.id),
          expanded,
          proxyOnlyIds,
          proxyPreview
            ? {
                before,
                after: expanded,
                owned,
                readAnchors: () => preferences.read(upstream, account.id),
                snapshot: catalog.proxySnapshots.get(account.id),
              }
            : undefined,
        ),
      );
      const now = Date.now();
      for (const [token, preview] of previews) if (preview.expires <= now) previews.delete(token);
      if (previews.size >= previewLimit) previews.delete(previews.keys().next().value!);
      const previewToken = randomUUID();
      previews.set(previewToken, {
        expires: now + previewLifetimeMs,
        connection: session.identity,
        draftRevision: draft.revision,
        activeRevision: active?.revision,
        proxyUpstream: proxyPreview,
        proxyChanged,
        order,
        names,
        aliases,
        ownedIds,
        proxyOnlyIds,
        targets,
      });
      response.json({
        previewToken,
        libraries: order.map((id) => names[id]),
        users: targets.map((target) => target.row),
        warnings: catalog.warnings,
        proxyChanged,
        proxyConfigured: proxy.configured,
        proxyEnabled: proxy.enabled,
        proxyRunning: proxy.running,
      });
    } catch {
      fail(response, 502, "library_order_read_failed");
    }
  });

  app.post(`${path}/apply`, async (request, response) => {
    const parsed = applySchema.safeParse(request.body);
    if (!parsed.success) return fail(response, 400, "invalid_request");
    if (applying) return fail(response, 409, "library_order_busy");
    const { previewToken } = parsed.data;
    const preview = previews.get(previewToken);
    previews.delete(previewToken);
    if (!preview || preview.expires <= Date.now()) return fail(response, 409, "library_order_preview_expired");
    const session = open();
    if (!session || session.identity !== preview.connection) {
      return fail(response, 409, "library_order_connection_changed");
    }
    const { proxyUpstream: upstream, ownedIds } = preview;
    if (!isCurrent(session, upstream)) {
      return fail(response, 409, "library_order_connection_changed");
    }
    const saved = store.read(session.baseUrl);
    if (
      !saved ||
      saved.revision !== preview.draftRevision ||
      (upstream && store.readActive(session.baseUrl, upstream)?.revision !== preview.activeRevision) ||
      !sameOrder(
        ownedIds,
        ownedLibraries()
          .map(({ id }) => viewIdentity(id))
          .sort(),
      )
    ) {
      return fail(response, 409, "library_order_order_changed");
    }

    applying = true;
    try {
      response.json(
        await applyLibraryOrder({
          database,
          store,
          session,
          saved,
          preview,
          isCurrent: (target) => isCurrent(session, target),
          readProxyState: proxyState,
        }),
      );
    } catch {
      fail(response, 502, "library_order_read_failed");
    } finally {
      applying = false;
    }
  });
}
