import type { EmbyLibraryOrderSession } from "./emby-library-order-client";

type View = Awaited<ReturnType<EmbyLibraryOrderSession["listUserViews"]>>[number];
type Preferences = Awaited<ReturnType<EmbyLibraryOrderSession["getUserPreferences"]>>;

function identity(value: string): string {
  return /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(value)
    ? value.replaceAll("-", "").toLowerCase()
    : value;
}

function keys(view: View): string[] {
  return [...new Set([view.id, view.guid ?? view.id].map(identity))];
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
  return left.length === right.length && left.every((value, index) => identity(value) === identity(right[index]!));
}

function viewIds(views: View[]): string[] {
  return views.map((view) => view.guid ?? view.id);
}

export async function readLibraryOrder(session: EmbyLibraryOrderSession, userId: string, isAdministrator: boolean) {
  const preferences = await session.getUserPreferences(userId);
  if (preferences.isAdministrator !== isAdministrator) return null;
  const views = await session.listUserViews(userId);
  return snapshot(preferences, views);
}

function snapshot(preferences: Preferences, views: View[]) {
  indexViews(views);
  const hidden = new Set(preferences.hiddenViews.map(identity));
  const visible = views.filter((view) => !keys(view).some((key) => hidden.has(key)));
  const index = indexViews(visible);
  const explicit = preferences.orderedViews.flatMap((token) => {
    const view = index.get(identity(token));
    return view ? [view] : [];
  });
  return {
    orderedViews: preferences.orderedViews,
    visible,
    templateOrder: [...new Set([...explicit, ...visible])],
    index,
    fingerprint: JSON.stringify([preferences, views]),
  };
}

export function planLibraryOrder(
  source: NonNullable<Awaited<ReturnType<typeof readLibraryOrder>>>,
  target: NonNullable<Awaited<ReturnType<typeof readLibraryOrder>>>,
) {
  const shared = new Set<View>();
  for (const view of source.templateOrder) {
    const matches = new Set(
      keys(view)
        .map((key) => target.index.get(key))
        .filter((item) => item !== undefined),
    );
    if (matches.size > 1) throw new Error("Conflicting Emby view identity");
    for (const match of matches) {
      if (shared.has(match) || (view.guid && match.guid && identity(view.guid) !== identity(match.guid))) {
        throw new Error("Conflicting Emby view identity");
      }
      shared.add(match);
    }
  }
  const desired = [...shared, ...target.visible.filter((view) => !shared.has(view))];
  const expected = viewIds(desired);
  const before = target.visible.map((view) => view.name);
  const after = desired.map((view) => view.name);
  if (sameOrder(viewIds(target.visible), expected)) return { before, after, expected, update: null };

  // Reuse the account's existing representation for known libraries. Keep every
  // token that the account cannot currently see in its original relative order.
  const storedKeys = new Map<View, string>();
  for (const token of target.orderedViews) {
    const view = target.index.get(identity(token));
    if (view && !storedKeys.has(view)) storedKeys.set(view, token);
  }
  const pending = desired.map((view) => storedKeys.get(view) ?? view.guid ?? view.id);
  const consumed = new Set<View>();
  const update = target.orderedViews.flatMap((token) => {
    const view = target.index.get(identity(token));
    if (!view) return [token];
    if (consumed.has(view)) return [];
    consumed.add(view);
    return [pending.shift()!];
  });
  return { before, after, expected, update: [...update, ...pending] };
}

export function matchesLibraryOrder(
  actual: Awaited<ReturnType<typeof readLibraryOrder>>,
  plan: ReturnType<typeof planLibraryOrder>,
): boolean {
  return Boolean(
    actual &&
    plan.update &&
    sameOrder(actual.orderedViews, plan.update) &&
    sameOrder(viewIds(actual.visible), plan.expected),
  );
}
