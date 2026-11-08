import type { EmbyLibraryOrderSession } from "./emby-library-order-client";

type View = Awaited<ReturnType<EmbyLibraryOrderSession["listUserViews"]>>[number];
type Preferences = Awaited<ReturnType<EmbyLibraryOrderSession["getUserPreferences"]>>;

export function viewIdentity(value: string): string {
  return /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(value)
    ? value.replaceAll("-", "").toLowerCase()
    : value;
}

function keys(view: View): string[] {
  return [...new Set([view.id, view.guid || view.id].map(viewIdentity).filter(Boolean))];
}

function indexViews(views: View[]): Map<string, View> {
  const index = new Map<string, View>();
  for (const view of views) {
    for (const key of keys(view)) {
      if (index.has(key)) throw new Error("Ambiguous Emby view identity");
      index.set(key, view);
    }
  }
  return index;
}

export function sameOrder(left: string[], right: string[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => viewIdentity(value) === viewIdentity(right[index]!))
  );
}

function viewIds(views: View[]): string[] {
  return views.map((view) => view.guid || view.id);
}

export async function readLibraryOrder(
  session: EmbyLibraryOrderSession,
  userId: string,
  ownedIds: ReadonlySet<string>,
): Promise<LibraryOrderSnapshot> {
  const [preferences, views] = await Promise.all([session.getUserPreferences(userId), session.listUserViews(userId)]);
  return libraryOrderSnapshot(preferences, views, ownedIds);
}

export type LibraryOrderSnapshot = ReturnType<typeof libraryOrderSnapshot>;

export function libraryOrderSnapshot(preferences: Preferences, views: View[], ownedIds: ReadonlySet<string>) {
  // MyMediaExcludes only controls the home "My Media" row; it is not a
  // per-library visibility flag. /Views already applies the real hidden policy.
  const visible = views.filter((view) => !keys(view).some((key) => ownedIds.has(key)));
  const visibleIndex = indexViews(visible);
  const explicit = preferences.orderedViews.flatMap((token) => {
    const view = visibleIndex.get(viewIdentity(token));
    return view ? [view] : [];
  });
  return {
    orderedViews: preferences.orderedViews.filter((id) => !ownedIds.has(viewIdentity(id))),
    personalOrder: preferences.orderedViews,
    hiddenViews: preferences.hiddenViews,
    visible,
    explicitOrder: [...new Set(explicit)],
    // Emby's /Views endpoint does not necessarily return the user's configured
    // order. OrderedViews is the source of truth for what the client shows.
    templateOrder: [...new Set([...explicit, ...visible])],
    index: visibleIndex,
    fingerprint: JSON.stringify([preferences, views]),
  };
}

export function planLibraryOrderFromTokens(order: string[], target: LibraryOrderSnapshot) {
  const desired: View[] = [];
  const seen = new Set<View>();
  for (const token of order) {
    const view = target.index.get(viewIdentity(token));
    if (view && !seen.has(view)) {
      seen.add(view);
      desired.push(view);
    }
  }
  for (const view of target.templateOrder) {
    if (!seen.has(view)) {
      seen.add(view);
      desired.push(view);
    }
  }
  const expected = viewIds(desired);
  const before = target.templateOrder.map((view) => view.name);
  const after = desired.map((view) => view.name);
  if (sameOrder(viewIds(target.explicitOrder), expected)) return { before, after, expected, update: null };

  // Reuse the account's existing representation for known libraries. Tokens
  // for hidden or deleted libraries stay in place, preserving unrelated user
  // preferences while visible libraries are moved into the requested order.
  const storedKeys = new Map<View, string>();
  for (const token of target.orderedViews) {
    const view = target.index.get(viewIdentity(token));
    if (view && !storedKeys.has(view)) storedKeys.set(view, token);
  }
  const pending = desired.map((view) => storedKeys.get(view) ?? (view.guid || view.id));
  const consumed = new Set<View>();
  const update = target.orderedViews.flatMap((token) => {
    const view = target.index.get(viewIdentity(token));
    if (!view) return [token];
    if (consumed.has(view)) return [];
    consumed.add(view);
    const next = pending.shift();
    return next ? [next] : [];
  });
  return { before, after, expected, update: [...update, ...pending] };
}

export function matchesLibraryOrder(
  actual: LibraryOrderSnapshot,
  plan: ReturnType<typeof planLibraryOrderFromTokens>,
): boolean {
  return Boolean(plan.update && sameOrder(viewIds(actual.explicitOrder), plan.expected));
}
