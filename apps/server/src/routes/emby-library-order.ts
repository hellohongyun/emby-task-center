import { randomUUID } from "node:crypto";
import type { Express, Response } from "express";
import { z } from "zod";
import type { AppDatabase } from "@emby-task-center/database/client";
import type { EmbyClient } from "../integrations/emby-client";
import {
  aliasMap,
  inBatches,
  publicLibraries,
  readCatalog,
  resolveOrder,
} from "../integrations/emby-library-order-catalog";
import { sameOrder, viewIdentity } from "../integrations/emby-library-order-plan";
import { createEmbyLibraryOrderStore, expandLibraryOrder } from "../integrations/emby-library-order-store";
import { audit } from "../subscriptions/domain-utils";
import { createOwnedViewPreferences } from "../virtual-libraries/owned-view-preferences";
import { readVirtualProxyConfig } from "../virtual-libraries/proxy-settings";
import { createVirtualLibraryStore } from "../virtual-libraries/store";
import { applyTarget, previewTarget, type Target } from "./emby-library-order-targets";

const path = "/api/emby/library-order";
const saveSchema = z.strictObject({ order: z.array(z.string().min(1).max(128)).min(1).max(500) });
const previewSchema = z.strictObject({
  userIds: z.array(z.string().min(1).max(128)).min(1).max(200).optional(),
});
const applySchema = z.strictObject({ previewToken: z.uuid() });
const previewLifetimeMs = 5 * 60 * 1000;
const previewLimit = 12;

type Preview = {
  expires: number;
  connection: object;
  draftRevision: string;
  activeRevision?: string;
  proxyUpstream?: string;
  proxyChanged: boolean;
  order: string[];
  names: Record<string, string>;
  aliases: Record<string, string[]>;
  ownedIds: string[];
  targets: Target[];
};

function fail(response: Response, status: number, error: string) {
  response.status(status).json({ error });
}

export function registerEmbyLibraryOrderRoutes(
  app: Express,
  emby: EmbyClient | undefined,
  database: AppDatabase,
): void {
  const open = () => emby?.openLibraryOrderSession?.();
  const store = createEmbyLibraryOrderStore(database);
  const virtualLibraries = createVirtualLibraryStore(database);
  const preferences = createOwnedViewPreferences(database, virtualLibraries);
  const ownedLibraries = () => virtualLibraries.list().map(({ id, name }) => ({ id, name }));
  const proxyUpstream = (baseUrl: string) => readVirtualProxyConfig(database).upstream || baseUrl;
  const previews = new Map<string, Preview>();
  let applying = false;

  app.use(path, (_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  app.get(path, async (_request, response) => {
    const session = open();
    if (!session) return fail(response, 503, "library_order_not_configured");
    try {
      const catalog = await readCatalog(session, ownedLibraries());
      if (open()?.identity !== session.identity) return fail(response, 409, "library_order_connection_changed");
      const saved = store.read(session.baseUrl);
      const active = store.readActive(session.baseUrl, proxyUpstream(session.baseUrl));
      const order = resolveOrder(saved?.order ?? catalog.suggestedOrder, catalog.entries);
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
      const catalog = await readCatalog(session, ownedLibraries());
      if (open()?.identity !== session.identity) return fail(response, 409, "library_order_connection_changed");
      if (applying) return fail(response, 409, "library_order_busy");
      if (store.read(session.baseUrl)?.revision !== previous?.revision) {
        return fail(response, 409, "library_order_order_changed");
      }
      const aliases = aliasMap(catalog.entries);
      const seen = new Set<string>();
      for (const token of parsed.data.order) {
        const entry = aliases.get(viewIdentity(token));
        if (!entry) return fail(response, 400, "library_order_unknown_library");
        if (seen.has(entry.id)) return fail(response, 400, "library_order_duplicate_library");
        seen.add(entry.id);
      }
      const order = resolveOrder([...seen], catalog.entries);
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
      const catalog = await readCatalog(session, owned);
      if (open()?.identity !== session.identity) return fail(response, 409, "library_order_connection_changed");
      if (applying) return fail(response, 409, "library_order_busy");
      if (store.read(session.baseUrl)?.revision !== draft.revision) {
        return fail(response, 409, "library_order_order_changed");
      }
      const order = resolveOrder(draft.order, catalog.entries);
      if (!order.length) return fail(response, 409, "library_order_order_changed");
      const requested = parsed.data.userIds ? new Set(parsed.data.userIds) : undefined;
      const accounts = requested ? catalog.users.filter(({ id }) => requested.has(id)) : catalog.users;
      if (requested && accounts.length !== requested.size) return fail(response, 400, "library_order_unknown_user");

      const names = Object.fromEntries(catalog.entries.map(({ id, name }) => [id, name]));
      const aliases = Object.fromEntries(catalog.entries.map((entry) => [entry.id, [...entry.aliases]]));
      const expanded = expandLibraryOrder(order, aliases);
      const nativeOrder = expandLibraryOrder(
        order.filter((id) => !ownedIds.includes(id)),
        aliases,
      );
      const upstream = requested ? undefined : proxyUpstream(session.baseUrl);
      const active = upstream ? store.readActive(session.baseUrl, upstream) : null;
      const before = active ? expandLibraryOrder(active.order, active.aliases) : undefined;
      const proxyChanged = Boolean(upstream && (!before || !sameOrder(before, expanded)));
      const targets = accounts.map((account) =>
        previewTarget(
          account,
          catalog.snapshots.get(account.id),
          nativeOrder,
          upstream
            ? {
                before,
                after: expanded,
                owned,
                readAnchors: () => preferences.read(upstream, account.id),
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
        proxyUpstream: upstream,
        proxyChanged,
        order,
        names,
        aliases,
        ownedIds,
        targets,
      });
      response.json({
        previewToken,
        libraries: order.map((id) => names[id]),
        users: targets.map((target) => target.row),
        warnings: catalog.warnings,
        proxyChanged,
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
    const isCurrent = () => open()?.identity === preview.connection;
    if (!session || !isCurrent()) return fail(response, 409, "library_order_connection_changed");
    const { proxyUpstream: upstream, order, names, aliases, ownedIds, targets } = preview;
    if (upstream && upstream !== proxyUpstream(session.baseUrl)) {
      return fail(response, 409, "library_order_connection_changed");
    }
    const saved = store.read(session.baseUrl);
    if (
      saved?.revision !== preview.draftRevision ||
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
      audit(
        database,
        "admin",
        "emby_library_order.apply_started",
        "emby_library_order",
        undefined,
        { order, accounts: targets.length, includeProxy: Boolean(upstream) },
        null,
        "开始同步媒体库顺序",
      );
      const excluded = new Set(ownedIds);
      const users = await inBatches(targets, (target) => applyTarget(session, target, excluded, isCurrent));
      let proxyActivated = false;
      let proxyReason: string | undefined;
      if (upstream) {
        if (!isCurrent() || upstream !== proxyUpstream(session.baseUrl)) {
          proxyReason = "library_order_connection_changed";
        } else {
          try {
            database.transaction(() => {
              if (!sameOrder(saved.order, order)) store.save(session.baseUrl, order, names);
              if (preview.proxyChanged) store.activate(session.baseUrl, upstream, order, names, aliases);
            });
            proxyActivated = true;
          } catch {
            proxyReason = "library_order_proxy_save_failed";
          }
        }
      }
      audit(
        database,
        "admin",
        "emby_library_order.applied",
        "emby_library_order",
        undefined,
        { order },
        {
          updated: users.filter((user) => user.status === "updated").length,
          unchanged: users.filter((user) => user.status === "unchanged").length,
          skipped: users.filter((user) => user.status === "skipped").length,
          failed: users.filter((user) => user.status === "failed").length,
          users: users.map(({ id, status, reason }) => ({ id, status, reason })),
          proxyActivated,
          proxyReason,
        },
        "完成媒体库顺序同步",
      );
      response.json({ users, order, proxyActivated, proxyReason });
    } catch {
      fail(response, 502, "library_order_read_failed");
    } finally {
      applying = false;
    }
  });
}
