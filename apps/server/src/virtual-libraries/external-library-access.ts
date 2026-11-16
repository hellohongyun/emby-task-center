import { privateIdentity } from "./private-access";
import { isRootLibraryDiscovery } from "./root-library-discovery";
import {
  authenticationUrl,
  integerParameter,
  parameter,
  setParameter,
  UpstreamQueryError,
  type Item,
  type QueryUpstream,
  type UpstreamJson,
} from "./query-helpers";

export interface ExternalLibraryAccess {
  libraries: { id: string; aliases: string[]; enabled: boolean }[];
}
export type ReadExternalLibraryAccess = (provenId?: string) => ExternalLibraryAccess;

/** Only explicitly registered upstream virtual folders participate in market access. */
export function externalLibraryAccess(access: ExternalLibraryAccess, raw: QueryUpstream, userId?: string) {
  const denied = new Set(
    access.libraries.filter((item) => !item.enabled).flatMap((item) => [item.id, ...item.aliases].map(privateIdentity)),
  );
  const blocked = (value: unknown) => typeof value === "string" && denied.has(privateIdentity(value));
  function references(url: URL) {
    return [
      ...url.pathname.split("/").map(decodeURIComponent),
      ...[...url.searchParams.values()].flatMap((value) => value.split(",")),
    ].some((value) => blocked(value.startsWith("task-center-latest:") ? value.slice(19) : value));
  }
  function hidden(item: unknown) {
    if (!item || typeof item !== "object") return false;
    const row = item as Item;
    const parent = row.ParentItem as Item | undefined;
    return (
      blocked(row.Id) || blocked(row.Guid) || blocked(row.ParentId) || blocked(parent?.Id) || blocked(parent?.Guid)
    );
  }
  const sectionReads = new Map<string, Promise<UpstreamJson>>();
  function homeSections(url: URL, user: string) {
    const target = authenticationUrl(url, `/Users/${user}/HomeSections`);
    let read = sectionReads.get(target.href);
    if (!read) {
      read = raw(target, 3_000);
      sectionReads.set(target.href, read);
    }
    return read;
  }
  async function section(url: URL) {
    const match = /^\/Users\/([^/]+)\/Sections\/([^/]+)\/Items\/?$/i.exec(url.pathname);
    if (!match) return undefined;
    const reply = await homeSections(url, match[1]);
    if (reply.status < 200 || reply.status >= 300 || !Array.isArray(reply.body))
      throw new UpstreamQueryError({ status: 502, headers: {}, body: { error: "external_library_scope_unavailable" } });
    return reply.body.find((row) => row?.Id === decodeURIComponent(match[2])) as Item | undefined;
  }
  function items(reply: UpstreamJson): unknown[] | undefined {
    return Array.isArray(reply.body) ? reply.body : (reply.body as { Items?: unknown[] } | null)?.Items;
  }
  function unpaged(url: URL, original: UpstreamJson, complete: UpstreamJson) {
    const count = items(original)?.length ?? 0;
    return (
      integerParameter(url, "StartIndex", 0) === 0 &&
      count > integerParameter(url, "Limit", Number.MAX_SAFE_INTEGER) &&
      count === items(complete)?.length
    );
  }
  async function complete(url: URL, initial: UpstreamJson) {
    const original = items(initial);
    if (!Array.isArray(original)) return initial;
    const total = (initial.body as { TotalRecordCount?: number } | null)?.TotalRecordCount;
    if (
      integerParameter(url, "StartIndex", 0) === 0 &&
      (typeof total === "number" ? original.length >= total : parameter(url, "Limit") === undefined)
    )
      return initial;
    const target = new URL(url);
    setParameter(target, "StartIndex", "0");
    setParameter(target, "Limit", "200");
    const combined: unknown[] = [];
    const signatures = new Set<string>();
    let expected = total;
    for (;;) {
      setParameter(target, "StartIndex", String(combined.length));
      const reply = await raw(target);
      if (reply.status < 200 || reply.status >= 300) throw new UpstreamQueryError(reply);
      const page = items(reply);
      if (!Array.isArray(page)) throw new Error("invalid_external_library_list");
      const count = (reply.body as { TotalRecordCount?: number } | null)?.TotalRecordCount;
      if (typeof count === "number") expected = count;
      const signature = JSON.stringify(page);
      if (page.length && signatures.has(signature)) throw new Error("repeated_external_library_page");
      signatures.add(signature);
      combined.push(...page);
      if (typeof expected === "number" ? combined.length >= expected : page.length < 200) break;
      if (!page.length || combined.length >= 10_000) throw new Error("incomplete_external_library_list");
    }
    return {
      ...initial,
      raw: undefined,
      body: Array.isArray(initial.body)
        ? combined
        : { ...(initial.body as Item), Items: combined, TotalRecordCount: combined.length },
    };
  }
  const handles = (url: URL) =>
    /^\/(?:Users\/[^/]+\/(?:Views|HomeSections|Sections\/[^/]+\/Items|Items(?:\/(?:Latest|Resume))?)|Library\/MediaFolders|Items(?:\/(?:Latest|Resume))?)\/?$/i.test(
      url.pathname,
    );
  async function appendMissing(url: URL, reply: UpstreamJson) {
    const values = items(reply)!;
    const identities = (item: unknown) => {
      const row = item as Item;
      return [row?.Id, row?.Guid].filter((id): id is string => typeof id === "string").map(privateIdentity);
    };
    const present = new Set(values.flatMap(identities));
    const missing = access.libraries.filter(
      (library) => library.enabled && ![library.id, ...library.aliases].some((id) => present.has(privateIdentity(id))),
    );
    if (!userId || !missing.length) return reply;
    const target = authenticationUrl(url, `/Users/${encodeURIComponent(userId)}/Views`);
    for (const [name, value] of url.searchParams)
      if (/^(fields|includehidden|enableimages|enableuserdata|imagetypelimit|enableimagetypes)$/i.test(name))
        target.searchParams.set(name, value);
    // Retain the client's page size so the fallback also detects an upstream
    // that serves its entire Views catalog instead of a requested first page.
    setParameter(target, "Limit", parameter(url, "Limit"));
    try {
      const source = await raw(target);
      if (source.status < 200 || source.status >= 300 || !Array.isArray(items(source))) return reply;
      const completeSource = await complete(target, source);
      const additional = items(completeSource)!.filter(
        (entry) =>
          (entry as Item)?.Type === "CollectionFolder" &&
          missing.some((library) =>
            [library.id, ...library.aliases].some((id) => identities(entry).includes(privateIdentity(id))),
          ) &&
          !identities(entry).some((id) => present.has(id)),
      );
      if (!additional.length) return reply;
      const combined = [...values, ...additional];
      return {
        ...reply,
        raw: undefined,
        unpagedLibraryList:
          reply.unpagedLibraryList ||
          (integerParameter(url, "StartIndex", 0) === 0 && unpaged(target, source, completeSource)),
        body: Array.isArray(reply.body)
          ? combined
          : {
              ...(reply.body as Item),
              Items: combined,
              TotalRecordCount: combined.length,
            },
      };
    } catch {
      return reply;
    }
  }
  async function query(url: URL, timeout?: number): Promise<UpstreamJson> {
    let reply = await raw(url, timeout);
    if (reply.status < 200 || reply.status >= 300 || !handles(url)) return reply;
    if (/\/HomeSections\/?$/i.test(url.pathname)) {
      if (!Array.isArray(reply.body)) return reply;
      return { ...reply, raw: undefined, body: reply.body.filter((row) => !hidden(row)) };
    }
    const original = items(reply);
    if (!Array.isArray(original)) return reply;
    const libraryList =
      /^\/(?:Users\/[^/]+\/Views|Library\/MediaFolders)\/?$/i.test(url.pathname) ||
      (isRootLibraryDiscovery(url) && original.every((item) => (item as Item)?.Type === "CollectionFolder")) ||
      (await section(url))?.SectionType === "userviews";
    if (libraryList) {
      const whole = await complete(url, reply);
      whole.unpagedLibraryList = unpaged(url, reply, whole);
      reply = await appendMissing(url, whole);
    }
    const values = items(reply)!;
    const filtered = values.filter((item) => !hidden(item));
    if (!libraryList && filtered.length === values.length) return reply;
    return {
      ...reply,
      raw: undefined,
      body: Array.isArray(reply.body)
        ? filtered
        : {
            ...(reply.body as Item),
            Items: filtered,
            ...(libraryList ? { TotalRecordCount: filtered.length } : {}),
          },
    };
  }
  return {
    references,
    handles,
    query,
    async forbidden(url: URL) {
      return references(url) || hidden(await section(url));
    },
  };
}
