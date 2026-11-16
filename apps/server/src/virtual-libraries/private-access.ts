import type { VirtualLibraryStore } from "./store";
import { authenticationUrl, setParameter, type QueryUpstream } from "./query-helpers";

export interface ProxyLibraryAccess {
  memberId?: number;
  subscriberId: string;
  visibleLibraryIds: readonly string[];
  ownLibraryIds: readonly string[];
  personalOrder?: readonly string[];
}

export function privateIdentity(value: string) {
  return /^[a-f\d-]{32,36}$/i.test(value) ? value.replaceAll("-", "").toLowerCase() : value;
}

/** Revalidate a previously proven token owner; request UserId never proves ownership. */
export async function privateMember(
  url: URL,
  upstream: QueryUpstream,
  lookup?: (embyId: string) => number | undefined,
  verifiedUserId?: string,
  report?: (reason: string, status?: number) => void,
): Promise<number | undefined> {
  if (!lookup || !verifiedUserId) {
    report?.("login_proof_missing");
    return undefined;
  }
  const userId = await validatePrivateUser(url, upstream, verifiedUserId, report);
  if (!userId) return undefined;
  const member = lookup(userId);
  if (member === undefined) report?.("member_unavailable");
  return member;
}

/** Ownership is established by the login proof, then revalidated with the same credentials. */
export async function validatePrivateUser(
  url: URL,
  upstream: QueryUpstream,
  verifiedUserId?: string,
  report?: (reason: string, status?: number) => void,
): Promise<string | undefined> {
  if (!verifiedUserId) {
    report?.("login_proof_missing");
    return undefined;
  }
  try {
    const target = authenticationUrl(url, `/Users/${encodeURIComponent(verifiedUserId)}`);
    setParameter(target, "UserId");
    const reply = await upstream(target, 3_000);
    const body = reply.body as { Id?: unknown } | null;
    if (reply.status < 200 || reply.status >= 300) {
      report?.("validation_failed", reply.status);
      return undefined;
    }
    if (typeof body?.Id !== "string" || privateIdentity(body.Id) !== privateIdentity(verifiedUserId)) {
      report?.("invalid_identity_response", reply.status);
      return undefined;
    }
    const requested = [
      /^\/Users\/([^/]+)\//i.exec(url.pathname)?.[1],
      ...[...url.searchParams].filter(([key]) => key.toLowerCase() === "userid").map(([, value]) => value),
    ].filter((id): id is string => !!id);
    if (requested.some((id) => privateIdentity(decodeURIComponent(id)) !== privateIdentity(body.Id as string))) {
      report?.("user_claim_mismatch");
      return undefined;
    }
    return body.Id;
  } catch {
    report?.("validation_unavailable");
    return undefined;
  }
}

/** Narrow every library read, including posters and repair lookups, for one request. */
export function privateRequestStore(
  store: VirtualLibraryStore,
  memberId: number | undefined,
  libraryIds?: readonly string[],
) {
  const allowed = libraryIds ? new Set(libraryIds.map(privateIdentity)) : undefined;
  const visible = () =>
    store
      .list()
      .filter((library) =>
        allowed
          ? allowed.has(privateIdentity(library.id))
          : library.ownerMemberId == null || library.ownerMemberId === memberId,
      );
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
export function forbiddenPrivateReference(
  url: URL,
  all: VirtualLibraryStore,
  visible: VirtualLibraryStore,
  protectAll = false,
) {
  const values = [
    ...url.pathname.split("/").map(decodeURIComponent),
    ...[...url.searchParams.values()].flatMap((value) => value.split(",")),
  ].map((value) => (value.startsWith("task-center-latest:") ? value.slice("task-center-latest:".length) : value));
  const references = new Set(values.map(privateIdentity));
  return all
    .list()
    .some(
      (library) =>
        (protectAll || library.ownerMemberId != null) &&
        references.has(privateIdentity(library.id)) &&
        !visible.get(library.id),
    );
}
