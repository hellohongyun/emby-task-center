import type { AppDatabase } from "@emby-task-center/database/client";
import type { EmbyLibraryOrderSession } from "../integrations/emby-library-order-client";
import { sameOrder } from "../integrations/emby-library-order-plan";
import { inBatches } from "../integrations/emby-library-order-side";
import type { EmbyLibraryOrderStore, SavedLibraryOrder } from "../integrations/emby-library-order-store";
import { audit } from "../subscriptions/domain-utils";
import { applyTarget, type Target } from "./emby-library-order-targets";

export type LibraryOrderPreview = {
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

export async function applyLibraryOrder({
  database,
  store,
  session,
  saved,
  preview,
  isCurrent,
  readProxyState,
}: {
  database: AppDatabase;
  store: EmbyLibraryOrderStore;
  session: EmbyLibraryOrderSession;
  saved: SavedLibraryOrder;
  preview: LibraryOrderPreview;
  isCurrent: (upstream?: string) => boolean;
  readProxyState: () => { configured: boolean; enabled: boolean; running: boolean };
}) {
  const { proxyUpstream: upstream, order, names, aliases, ownedIds, targets } = preview;
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
  const proxy = readProxyState();
  let proxyActivated = false;
  let proxyReason: string | undefined;
  if (upstream) {
    if (!isCurrent(upstream)) {
      proxyReason = "library_order_connection_changed";
    } else {
      try {
        database.transaction(() => {
          if (!sameOrder(saved.order, order)) store.save(session.baseUrl, order, names);
          if (preview.proxyChanged) store.activate(session.baseUrl, upstream, order, names, aliases);
        });
        proxyActivated = true;
        if (!proxy.enabled) proxyReason = "library_order_proxy_disabled";
        else if (!proxy.running) proxyReason = "library_order_proxy_not_running";
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
  return {
    users,
    order,
    proxyActivated,
    proxyReason,
    proxyConfigured: proxy.configured,
    proxyEnabled: proxy.enabled,
    proxyRunning: proxy.running,
  };
}
