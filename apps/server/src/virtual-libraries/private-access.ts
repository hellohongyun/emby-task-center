import type { VirtualLibraryStore } from "./store";
import { authenticationUrl, setParameter, type QueryUpstream } from "./query-helpers";

export function privateIdentity(value: string) {
  return /^[a-f\d-]{32,36}$/i.test(value) ? value.replaceAll("-", "").toLowerCase() : value;
}

/** Revalidate a previously proven token owner; request UserId never proves ownership. */
export async function privateMember(
  url: URL,
  upstream: QueryUpstream,
  lookup?: (embyId: string) => number | undefined,
  verifiedUserId?: string,
): Promise<number | undefined> {
  if (!lookup || !verifiedUserId) return undefined;
  try {
    const target = authenticationUrl(url, `/Users/${encodeURIComponent(verifiedUserId)}`);
    setParameter(target, "UserId");
    const reply = await upstream(target, 3_000);
    const body = reply.body as { Id?: unknown } | null;
    if (
      reply.status < 200 ||
      reply.status >= 300 ||
      typeof body?.Id !== "string" ||
      privateIdentity(body.Id) !== privateIdentity(verifiedUserId)
    )
      return undefined;
    const requested = [
      /^\/Users\/([^/]+)\//i.exec(url.pathname)?.[1],
      ...[...url.searchParams].filter(([key]) => key.toLowerCase() === "userid").map(([, value]) => value),
    ].filter((id): id is string => !!id);
    if (requested.some((id) => privateIdentity(decodeURIComponent(id)) !== privateIdentity(body.Id as string)))
      return undefined;
    return lookup(body.Id);
  } catch {
    return undefined;
  }
}

/** Narrow every library read, including posters and repair lookups, for one request. */
export function privateRequestStore(store: VirtualLibraryStore, memberId: number | undefined) {
  const visible = () =>
    store.list().filter((library) => library.ownerMemberId == null || library.ownerMemberId === memberId);
  const get = (id: string) => visible().find((library) => privateIdentity(library.id) === privateIdentity(id));
  return {
    ...store,
    list: visible,
    get,
    listItems: (id: string) => {
      const library = get(id);
      return library ? store.listItems(library.id) : [];
    },
    getPoster: (id: string) => {
      const library = get(id);
      return library ? store.getPoster(library.id) : undefined;
    },
  };
}

/** Stop guessed private IDs locally, even on unsupported routes or mixed-ID queries. */
export function forbiddenPrivateReference(url: URL, all: VirtualLibraryStore, visible: VirtualLibraryStore) {
  const values = [
    ...url.pathname.split("/").map(decodeURIComponent),
    ...[...url.searchParams.values()].flatMap((value) => value.split(",")),
  ].map((value) => (value.startsWith("task-center-latest:") ? value.slice("task-center-latest:".length) : value));
  const references = new Set(values.map(privateIdentity));
  return all
    .list()
    .some(
      (library) =>
        library.ownerMemberId != null && references.has(privateIdentity(library.id)) && !visible.get(library.id),
    );
}
