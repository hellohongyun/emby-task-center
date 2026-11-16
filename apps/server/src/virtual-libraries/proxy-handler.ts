import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type { VirtualLibraryStore } from "./store";
import { handleVirtualQuery } from "./queries";
import { forwardRequest, upstreamJson, type ProxyTarget } from "./proxy-transport";
import { createProxyMappingRepair } from "./proxy-mapping-repair";
import { parameter, sendJson } from "./query-helpers";
import { createHomeSectionCache } from "./home-section-cache";
import type { OwnedViewPreferences } from "./owned-view-preferences";
import { serveOwnedPoster } from "./proxy-poster";
import { appendOwnedHomeSections, ownedLatestLibraryId } from "./owned-home-sections";
import { isRootLibraryDiscovery } from "./root-library-discovery";
import {
  privateMember,
  privateRequestStore,
  forbiddenPrivateReference,
  validatePrivateUser,
  type ProxyLibraryAccess,
} from "./private-access";
import { createPrivateTokenIdentity, isPrivateAuthentication } from "./private-token-identity";
import { privateClient, privateDiscoveryRoute, type PrivateDiagnosticReporter } from "./private-diagnostics";
import { externalLibraryAccess, type ReadExternalLibraryAccess } from "./external-library-access";

export function createVirtualProxyHandler(
  allStore: VirtualLibraryStore,
  upstream: () => string,
  marker: string,
  preferences?: OwnedViewPreferences,
  readAdminOrder?: (upstream: string) => readonly string[] | undefined,
  lookupMember?: (embyId: string) => number | undefined,
  identities = createPrivateTokenIdentity(),
  reportIdentity?: PrivateDiagnosticReporter,
  resolveLibraryAccess?: (embyId: string) => ProxyLibraryAccess | undefined,
  readExternalAccess?: ReadExternalLibraryAccess,
) {
  const repairMappings = createProxyMappingRepair(allStore);
  const homeSections = createHomeSectionCache();
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (request.headers["x-task-center-proxy"] === marker) {
        response.writeHead(508).end();
        return;
      }
      request.headers["x-task-center-proxy"] = marker;
      const abort = new AbortController();
      response.once("close", () => abort.abort());
      request.once("aborted", () => abort.abort());
      const context: ProxyTarget = { upstream: upstream(), request, response, signal: abort.signal };
      const url = new URL(request.url ?? "/", "http://proxy.local");
      url.pathname = url.pathname.replace(/^\/emby(?=\/|$)/i, "") || "/";
      const rawUpstream = (target: URL, timeout?: number) => upstreamJson(context, target, timeout);
      const externalCatalog = readExternalAccess?.();
      const hasExternal = !!externalCatalog?.libraries.length;
      const publicExternal = externalCatalog ? externalLibraryAccess(externalCatalog, rawUpstream) : undefined;
      const client = privateClient(request.headers);
      const discoveryRoute = privateDiscoveryRoute(url);
      const libraries = allStore.list();
      const requestStore = { ...allStore, list: () => libraries };
      const hasPrivate = libraries.some((library) => library.ownerMemberId != null);
      const protectedLibraries = !!resolveLibraryAccess || hasPrivate;
      const publicStore = resolveLibraryAccess
        ? privateRequestStore(requestStore, undefined, [])
        : hasPrivate
          ? privateRequestStore(requestStore, undefined)
          : allStore;
      const privateBrowsing =
        protectedLibraries &&
        (publicExternal?.references(url) ||
          (hasExternal && publicExternal?.handles(url)) ||
          forbiddenPrivateReference(url, requestStore, publicStore, !!resolveLibraryAccess) ||
          ((request.method === "GET" || request.method === "HEAD") &&
            /^\/(?:Users\/[^/]+\/(?:Views|HomeSections|Sections\/[^/]+\/Items|Items)|Library\/MediaFolders|Items)\/?$/i.test(
              url.pathname,
            )));
      const report = (reason: string, status?: number) => {
        if (discoveryRoute)
          reportIdentity?.({ client, route: discoveryRoute, reason, ...(status === undefined ? {} : { status }) });
      };
      const provenId = privateBrowsing ? identities.resolve(context.upstream, url, request.headers) : undefined;
      const validatedId =
        privateBrowsing && resolveLibraryAccess
          ? await validatePrivateUser(
              url,
              (target, timeout) => upstreamJson(context, target, timeout),
              provenId,
              report,
            )
          : undefined;
      const access = validatedId ? resolveLibraryAccess?.(validatedId) : undefined;
      const external = hasExternal
        ? externalLibraryAccess(readExternalAccess!(validatedId), rawUpstream, validatedId)
        : undefined;
      const queryUpstream = external?.query ?? rawUpstream;
      if (validatedId && !access) report("member_unavailable");
      const memberId = resolveLibraryAccess
        ? access?.memberId
        : privateBrowsing
          ? await privateMember(
              url,
              (target, timeout) => upstreamJson(context, target, timeout),
              lookupMember,
              provenId,
              report,
            )
          : undefined;
      const store = resolveLibraryAccess
        ? privateRequestStore(requestStore, undefined, access?.visibleLibraryIds ?? [])
        : hasPrivate
          ? privateRequestStore(requestStore, memberId)
          : allStore;
      const ownLibraryIds = resolveLibraryAccess && access ? access.ownLibraryIds : hasExternal ? [] : undefined;
      const personalOrder = access?.personalOrder;
      if (protectedLibraries && discoveryRoute && (access || memberId !== undefined)) {
        const privateLibraryCount = resolveLibraryAccess
          ? store.list().length
          : store.list().filter((library) => library.ownerMemberId != null).length;
        reportIdentity?.({
          client,
          route: discoveryRoute,
          reason: privateLibraryCount ? "private_scope_ready" : "no_personal_library",
          privateLibraryCount,
        });
      }
      if (
        (external && (await external.forbidden(url))) ||
        (protectedLibraries && forbiddenPrivateReference(url, requestStore, store, !!resolveLibraryAccess))
      ) {
        sendJson(response, { status: 404, headers: {}, body: { error: "virtual_library_not_found" } });
        return;
      }
      const user = /^\/Users\/([^/]+)\//i.exec(url.pathname)?.[1] ?? parameter(url, "UserId");
      const orderedDiscovery =
        request.method === "GET" &&
        (/^\/Users\/[^/]+\/(?:Views|HomeSections|Sections\/[^/]+\/Items)\/?$/i.test(url.pathname) ||
          /^\/Library\/MediaFolders\/?$/i.test(url.pathname) ||
          isRootLibraryDiscovery(url));
      const adminOrder = orderedDiscovery ? readAdminOrder?.(context.upstream) : undefined;
      const ownedOrder =
        (!adminOrder || resolveLibraryAccess) && user && orderedDiscovery && store.list().length
          ? preferences?.read(context.upstream, decodeURIComponent(user))
          : undefined;
      const homeUser = /^\/Users\/([^/]+)\/(HomeSections|Sections\/[^/]+\/Items)\/?$/i.exec(url.pathname);
      let knownSections: unknown;
      if (request.method === "GET" && homeUser && (adminOrder || store.list().length || hasExternal)) {
        const scope = createHash("sha256")
          .update(
            JSON.stringify([
              context.upstream,
              request.headers.authorization,
              request.headers["x-emby-authorization"],
              request.headers["x-mediabrowser-authorization"],
              request.headers["x-emby-token"],
              [...url.searchParams].filter(([key]) => /^(api_key|apikey|token|x-emby-token)$/i.test(key)),
            ]),
          )
          .digest("hex");
        if (homeUser[2].toLowerCase() === "homesections") {
          const reply = await appendOwnedHomeSections({
            url,
            store,
            upstream: queryUpstream,
            reply: await queryUpstream(url),
            ownedOrder,
            personalOrder,
            ownLibraryIds,
            adminOrder,
          });
          if (reply.status >= 200 && reply.status < 300) homeSections.write(scope, homeUser[1], reply.body);
          sendJson(response, reply);
          return;
        }
        knownSections = homeSections.read(scope, homeUser[1]);
      }
      const image = /^\/Items\/([^/]+)\/Images\/(Primary|Thumb|Backdrop)(?:\/\d+)?$/i.exec(url.pathname);
      if (image && (await serveOwnedPoster(context, url, store))) return;
      const detail = /^\/(?:Users\/[^/]+\/)?Items\/([^/]+)\/?$/i.exec(url.pathname);
      const section = /^\/Users\/[^/]+\/Sections\/([^/]+)\/Items\/?$/i.exec(url.pathname);
      const virtualId =
        parameter(url, "ParentId") ??
        image?.[1] ??
        detail?.[1] ??
        (section ? ownedLatestLibraryId(decodeURIComponent(section[1]), store) : undefined);
      if (request.method === "GET" && virtualId && store.get(virtualId)) {
        await repairMappings(
          virtualId,
          request,
          url,
          context.upstream,
          (target) => upstreamJson(context, target),
          context.signal,
        );
      }
      if (
        await handleVirtualQuery({
          request,
          response,
          url,
          store,
          homeSections: knownSections,
          ownedOrder,
          adminOrder,
          personalOrder,
          ownLibraryIds,
          upstream: queryUpstream,
        })
      )
        return;
      if (external && request.method === "GET" && external.handles(url)) {
        sendJson(response, await external.query(url));
        return;
      }
      const deleted = request.method === "DELETE" ? /^\/Items\/([^/]+)\/?$/i.exec(url.pathname)?.[1] : undefined;
      preferences?.observe(request, response, url, context.upstream);
      forwardRequest(
        context,
        request.url ?? "/",
        deleted
          ? () => {
              try {
                store.removeItemEverywhere(decodeURIComponent(deleted));
              } catch {
                /* A later read can still show an absent upstream item. */
              }
            }
          : undefined,
        isPrivateAuthentication(request.method, url)
          ? (body) => {
              const reason = identities.observe(context.upstream, body);
              reportIdentity?.({ client, route: "login", reason });
            }
          : undefined,
        isPrivateAuthentication(request.method, url)
          ? (diagnostic) => reportIdentity?.({ client, route: "login", ...diagnostic })
          : undefined,
      );
    } catch {
      if (response.destroyed) return;
      if (response.headersSent) response.destroy();
      else
        response
          .writeHead(502, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "virtual_proxy_upstream_unavailable" }));
    }
  };
}
