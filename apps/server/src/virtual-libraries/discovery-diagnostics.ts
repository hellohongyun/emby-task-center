import type { ExternalLibraryAccess } from "./external-library-access";
import type { PrivateClient, PrivateDiagnostic, PrivateDiagnosticReporter } from "./private-diagnostics";
import { privateIdentity } from "./private-access";
import { parameter, type UpstreamJson } from "./query-helpers";
import { isRootLibraryDiscovery } from "./root-library-discovery";

export type DiscoveryAccountType = "administrator" | "member" | "mixed" | "unresolved";

export interface DiscoveryResultDiagnostic extends PrivateDiagnostic {
  reason: "discovery_result";
  kind: "libraries" | "home_sections";
  accountType: DiscoveryAccountType;
  recognizedLibraryDiscovery: boolean;
  bodyShape: "array" | "items" | "other";
  encoding: "identity" | "gzip" | "deflate" | "br" | "other";
  startIndex?: number;
  limit?: number;
  itemCount: number;
  localLibraryCount: number;
  externalLibraryCount: number;
  visibleLocalLibraryCount: number;
  registeredExternalLibraryCount: number;
  enabledExternalLibraryCount: number;
  totalRecordCount?: number;
}

export interface DiscoveryDiagnosticContext {
  method: string | undefined;
  url: URL;
  reply: UpstreamJson;
  visibleLocalLibraryIds: readonly string[];
  externalLibraries: ExternalLibraryAccess["libraries"];
  accountType: DiscoveryAccountType;
  client: PrivateClient;
  reporter?: PrivateDiagnosticReporter;
  /** Caller confirmed this section's upstream SectionType is userviews. */
  confirmedUserViews?: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function numericParameter(url: URL, name: string): number | undefined {
  const value = parameter(url, name);
  return value !== undefined && /^\d+$/.test(value) ? nonnegativeInteger(Number(value)) : undefined;
}

function ids(...values: unknown[]): string[] {
  return values.filter((value): value is string => typeof value === "string" && !!value).map(privateIdentity);
}

/** Observe only a response already obtained by the proxy; never fetch or change it. */
export function observeDiscoveryResponse(context: DiscoveryDiagnosticContext): DiscoveryResultDiagnostic | undefined {
  if (context.method !== "GET") return undefined;
  const { url, reply } = context;
  const body = record(reply.body);
  const values: unknown[] | undefined = Array.isArray(reply.body)
    ? reply.body
    : Array.isArray(body?.Items)
      ? body.Items
      : undefined;
  let route: DiscoveryResultDiagnostic["route"];
  let kind: DiscoveryResultDiagnostic["kind"] = "libraries";
  let recognizedLibraryDiscovery = true;
  if (/^\/Users\/[^/]+\/Views\/?$/i.test(url.pathname)) route = "views";
  else if (/^\/Library\/MediaFolders\/?$/i.test(url.pathname)) route = "folders";
  else if (/^\/Users\/[^/]+\/HomeSections\/?$/i.test(url.pathname)) {
    route = "home";
    kind = "home_sections";
  } else if (context.confirmedUserViews && /^\/Users\/[^/]+\/Sections\/[^/]+\/Items\/?$/i.test(url.pathname))
    route = "home";
  else {
    const root =
      /^\/Users\/[^/]+\/Items\/?$/i.test(url.pathname) ||
      (/^\/Items\/?$/i.test(url.pathname) && !!parameter(url, "UserId")?.trim());
    if (!root) return undefined;
    recognizedLibraryDiscovery = isRootLibraryDiscovery(url);
    // Unknown query options can disable overlays. Report that gap only when
    // the actual root response proves this is a folder list, not film search.
    if (!recognizedLibraryDiscovery) {
      const scoped = [...url.searchParams].some(
        ([key, value]) => /^(parentid|ids|searchterm)$/i.test(key) && !!value.trim(),
      );
      if (scoped || !values?.length || !values.every((item) => record(item)?.Type === "CollectionFolder"))
        return undefined;
    }
    route = "items";
  }
  const localIds = new Set(ids(...context.visibleLocalLibraryIds));
  const externalIds = new Set<string>();
  const enabledIds = new Set<string>();
  const aliases = new Map<string, string>();
  for (const library of context.externalLibraries) {
    const canonical = privateIdentity(library.id);
    externalIds.add(canonical);
    if (library.enabled) enabledIds.add(canonical);
    for (const alias of ids(library.id, ...library.aliases)) aliases.set(alias, canonical);
  }
  const localMatches = new Set<string>();
  const externalMatches = new Set<string>();
  for (const value of values ?? []) {
    const item = record(value);
    const parent = record(item?.ParentItem);
    const identities =
      kind === "home_sections" ? ids(item?.ParentId, parent?.Id, parent?.Guid) : ids(item?.Id, item?.Guid);
    for (const id of identities) {
      if (localIds.has(id)) localMatches.add(id);
      const canonical = aliases.get(id);
      if (canonical !== undefined) externalMatches.add(canonical);
    }
  }
  const startIndex = numericParameter(url, "StartIndex");
  const limit = numericParameter(url, "Limit");
  const totalRecordCount = nonnegativeInteger(body?.TotalRecordCount);
  const contentEncoding = reply.headers["content-encoding"];
  const normalizedEncoding = typeof contentEncoding === "string" ? contentEncoding.trim().toLowerCase() : undefined;
  const encoding =
    contentEncoding === undefined || normalizedEncoding === "identity"
      ? "identity"
      : normalizedEncoding === "gzip" || normalizedEncoding === "deflate" || normalizedEncoding === "br"
        ? normalizedEncoding
        : "other";
  const diagnostic: DiscoveryResultDiagnostic = {
    client: context.client,
    route,
    reason: "discovery_result",
    status: reply.status,
    kind,
    accountType: context.accountType,
    recognizedLibraryDiscovery,
    bodyShape: Array.isArray(reply.body) ? "array" : values ? "items" : "other",
    encoding,
    ...(startIndex === undefined ? {} : { startIndex }),
    ...(limit === undefined ? {} : { limit }),
    itemCount: values?.length ?? 0,
    localLibraryCount: localMatches.size,
    externalLibraryCount: externalMatches.size,
    visibleLocalLibraryCount: localIds.size,
    registeredExternalLibraryCount: externalIds.size,
    enabledExternalLibraryCount: enabledIds.size,
    ...(totalRecordCount === undefined ? {} : { totalRecordCount }),
  };
  try {
    context.reporter?.(diagnostic);
  } catch {
    // Logging must not affect the response or authentication.
  }
  return diagnostic;
}
