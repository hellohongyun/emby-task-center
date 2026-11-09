import type { Account } from "../integrations/emby-library-order-catalog";
import type { EmbyLibraryOrderSession } from "../integrations/emby-library-order-client";
import {
  matchesLibraryOrder,
  nativeLibraryOrder,
  planLibraryOrderFromTokens,
  readLibraryOrder,
  viewIdentity,
  type LibraryOrderSnapshot,
} from "../integrations/emby-library-order-plan";
import type { OwnedViewAnchor } from "../virtual-libraries/owned-view-preferences";
import { anchorOwnedViews, applyAdminLibraryOrder } from "../virtual-libraries/view-order";

type Library = { id: string; name: string };
type ProxyPreview = {
  before?: string[];
  after: string[];
  owned: Library[];
  readAnchors: () => OwnedViewAnchor[];
  snapshot?: LibraryOrderSnapshot;
};
type PreviewRow = Account & {
  status: "change" | "unchanged" | "failed";
  before: string[];
  after: string[];
  proxyBefore?: string[];
  proxyAfter?: string[];
  proxyReason?: string;
  reason?: string;
};
type ApplyRow = Account & { status: "updated" | "unchanged" | "skipped" | "failed"; reason?: string };
type Plan = ReturnType<typeof planLibraryOrderFromTokens>;
export type Target = { account: Account; row: PreviewRow; snapshot?: string; plan?: Plan };

function proxyOrders(proxy: ProxyPreview) {
  const { snapshot } = proxy;
  if (!snapshot) return { proxyReason: "library_order_proxy_read_failed" };
  const original = snapshot.visible.map(({ id, guid, name }) => ({ Id: id, Guid: guid, Name: name }));
  // Emby Web's Library Order query uses IncludeHidden=true, including our own hidden libraries.
  const additions = proxy.owned.map(({ id, name }) => ({ Id: id, Name: name }));
  const mixed = [...original, ...additions];
  const keys = (item: (typeof mixed)[number]) => [item.Id, "Guid" in item ? item.Guid : undefined];
  const personalOrder = snapshot.personalOrder.map(viewIdentity);
  const before = proxy.before
    ? applyAdminLibraryOrder(mixed, proxy.before, keys)
    : anchorOwnedViews(original, additions, personalOrder, proxy.readAnchors());
  return {
    proxyBefore: before.map((item) => String(item.Name)),
    proxyAfter: applyAdminLibraryOrder(mixed, proxy.after, keys).map((item) => item.Name),
  };
}

export function previewTarget(
  account: Account,
  target: LibraryOrderSnapshot | undefined,
  order: string[],
  proxyOnlyIds: ReadonlySet<string>,
  proxy?: ProxyPreview,
): Target {
  const proxyOrder = proxy ? proxyOrders(proxy) : {};
  if (!target) {
    return {
      account,
      row: { ...account, status: "failed", before: [], after: [], reason: "library_order_read_failed", ...proxyOrder },
    };
  }
  const native = nativeLibraryOrder(target, proxyOnlyIds);
  const plan = planLibraryOrderFromTokens(order, native);
  return {
    account,
    row: {
      ...account,
      status: plan.update ? "change" : "unchanged",
      before: plan.before,
      after: plan.after,
      ...proxyOrder,
    },
    snapshot: native.fingerprint,
    plan,
  };
}

export async function applyTarget(
  session: EmbyLibraryOrderSession,
  { account, snapshot, plan }: Target,
  ownedIds: ReadonlySet<string>,
  proxyOnlyIds: ReadonlySet<string>,
  isCurrent: () => boolean,
): Promise<ApplyRow> {
  const { id } = account;
  const skipped = (reason: string): ApplyRow => ({ ...account, status: "skipped", reason });
  const failed = (reason: string): ApplyRow => ({ ...account, status: "failed", reason });
  const read = async () => nativeLibraryOrder(await readLibraryOrder(session, id, ownedIds), proxyOnlyIds);
  if (!snapshot || !plan) return failed("library_order_read_failed");
  if (!isCurrent()) return skipped("library_order_connection_changed");
  try {
    const current = await read();
    if (current.fingerprint !== snapshot) return skipped("library_order_user_changed");
  } catch {
    return failed("library_order_read_failed");
  }
  if (!isCurrent()) return skipped("library_order_connection_changed");
  if (!plan.update) return { ...account, status: "unchanged" };
  try {
    await session.updateOrder(id, plan.update);
  } catch {
    return failed("library_order_write_failed");
  }
  try {
    if (matchesLibraryOrder(await read(), plan)) {
      return { ...account, status: "updated" };
    }
  } catch {
    // The write may already have succeeded. Generate a new preview before retrying.
  }
  return failed("library_order_verify_failed");
}
