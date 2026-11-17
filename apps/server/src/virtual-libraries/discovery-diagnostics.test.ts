import { describe, expect, it, vi } from "vitest";
import { observeDiscoveryResponse, type DiscoveryDiagnosticContext } from "./discovery-diagnostics";
import type { PrivateDiagnosticReporter } from "./private-diagnostics";

function context(overrides: Partial<DiscoveryDiagnosticContext> = {}): DiscoveryDiagnosticContext {
  return {
    method: "GET",
    url: new URL("http://proxy/Users/private-account/Views?api_key=private-token&StartIndex=0&Limit=30"),
    reply: { status: 200, headers: {}, body: { Items: [{ Id: "native" }], TotalRecordCount: 1 } },
    visibleLocalLibraryIds: ["local-private"],
    externalLibraries: [{ id: "external-private", aliases: ["external-guid"], enabled: true }],
    accountType: "administrator",
    client: "SenPlayer",
    reporter: vi.fn(),
    ...overrides,
  };
}

describe("response discovery diagnostics", () => {
  it("shows an established library scope even when the output contains no virtual libraries", () => {
    const input = context();
    const result = observeDiscoveryResponse(input);
    expect(result).toMatchObject({
      route: "views",
      reason: "discovery_result",
      accountType: "administrator",
      status: 200,
      startIndex: 0,
      limit: 30,
      bodyShape: "items",
      itemCount: 1,
      totalRecordCount: 1,
      visibleLocalLibraryCount: 1,
      enabledExternalLibraryCount: 1,
      localLibraryCount: 0,
      externalLibraryCount: 0,
    });
    expect(input.reporter).toHaveBeenCalledWith(result);
  });

  it("matches Guid aliases and normalized IDs in mixed DTOs, counting each library once", () => {
    const guid = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
    const result = observeDiscoveryResponse(
      context({
        visibleLocalLibraryIds: [guid, guid.replaceAll("-", "").toLowerCase()],
        reply: {
          status: 200,
          headers: {},
          body: [
            { Guid: guid.toLowerCase(), Name: "do-not-log" },
            { Id: guid, Guid: guid },
            { Id: "ttd-opaque", Guid: "external-guid" },
            { Id: "external-private" },
            { Type: "Movie" },
            null,
          ],
        },
      }),
    );
    expect(result).toMatchObject({
      bodyShape: "array",
      itemCount: 6,
      visibleLocalLibraryCount: 1,
      localLibraryCount: 1,
      externalLibraryCount: 1,
    });
  });

  it("counts HomeSections by ParentItem/ParentId instead of section IDs", () => {
    const result = observeDiscoveryResponse(
      context({
        url: new URL("http://proxy/Users/private-account/HomeSections"),
        reply: {
          status: 200,
          headers: {},
          body: [
            { Id: "section-one", ParentItem: { Id: "local-private" } },
            { Id: "section-two", ParentId: "local-private" },
            { Id: "section-three", ParentItem: { Guid: "external-guid" } },
            { Id: "external-private" },
          ],
        },
      }),
    );
    expect(result).toMatchObject({
      route: "home",
      kind: "home_sections",
      itemCount: 4,
      localLibraryCount: 1,
      externalLibraryCount: 1,
    });
  });

  it.each(["/Library/MediaFolders", "/Items?UserId=private-account&IncludeItemTypes=CollectionFolder"])(
    "recognizes library requests %s",
    (path) => {
      expect(observeDiscoveryResponse(context({ url: new URL(path, "http://proxy") }))).toMatchObject({
        recognizedLibraryDiscovery: true,
      });
    },
  );

  it("records unknown root query options only when a pure folder response proves discovery", () => {
    const input = context({
      url: new URL("http://proxy/Users/private-account/Items?IncludeItemTypes=CollectionFolder&Opaque=secret"),
      reply: { status: 200, headers: {}, body: { Items: [{ Id: "native", Type: "CollectionFolder" }] } },
    });
    expect(observeDiscoveryResponse(input)).toMatchObject({ route: "items", recognizedLibraryDiscovery: false });
    input.reply.body = { Items: [{ Id: "native", Type: "Movie" }] };
    expect(observeDiscoveryResponse(input)).toBeUndefined();
  });

  it.each([
    "/Users/private-account/Items?SearchTerm=film",
    "/Users/private-account/Items?ParentId=folder",
    "/Users/private-account/Items?Ids=film",
    "/Items?UserId=private-account",
    "/Videos/film/stream",
    "/Users/private-account/Sections/unknown/Items",
  ])("does not label ordinary or unconfirmed responses as library lists: %s", (path) => {
    expect(observeDiscoveryResponse(context({ url: new URL(path, "http://proxy") }))).toBeUndefined();
  });

  it("handles only confirmed userviews sections and GET requests", () => {
    const input = context({ url: new URL("http://proxy/Users/private-account/Sections/libraries/Items") });
    expect(observeDiscoveryResponse({ ...input, confirmedUserViews: true })).toMatchObject({ route: "home" });
    expect(observeDiscoveryResponse({ ...input, confirmedUserViews: true, method: "HEAD" })).toBeUndefined();
  });

  it.each([304, 401, 502])("records non-JSON status %s without leaking the response", (status) => {
    expect(
      observeDiscoveryResponse(
        context({
          reply: {
            status,
            headers: { "set-cookie": ["private-token"] },
            body: "private-upstream-error",
          },
        }),
      ),
    ).toMatchObject({ status, bodyShape: "other", itemCount: 0, localLibraryCount: 0, externalLibraryCount: 0 });
  });

  it.each([undefined, "gzip", "deflate", "br", "secret-unsupported-encoding"])(
    "classifies the upstream encoding without copying arbitrary header values: %s",
    (encoding) => {
      const result = observeDiscoveryResponse(
        context({
          reply: {
            status: 200,
            headers: { "content-encoding": encoding },
            body: "unparsed-private-body",
          },
        }),
      );
      expect(result).toMatchObject({
        bodyShape: "other",
        encoding: encoding === undefined ? "identity" : encoding.startsWith("secret") ? "other" : encoding,
      });
      expect(JSON.stringify(result)).not.toMatch(/secret|unparsed-private-body/);
    },
  );

  it("omits invalid numeric metadata and keeps disabled external scope distinct from actual output", () => {
    const result = observeDiscoveryResponse(
      context({
        url: new URL("http://proxy/Users/private-account/Views?StartIndex=-1&Limit=9007199254740992"),
        externalLibraries: [{ id: "external-private", aliases: [], enabled: false }],
        reply: { status: 200, headers: {}, body: { Items: [{ Id: "external-private" }], TotalRecordCount: -1 } },
      }),
    );
    expect(result).toMatchObject({
      registeredExternalLibraryCount: 1,
      enabledExternalLibraryCount: 0,
      externalLibraryCount: 1,
    });
    expect(result).not.toHaveProperty("startIndex");
    expect(result).not.toHaveProperty("limit");
    expect(result).not.toHaveProperty("totalRecordCount");
  });

  it("emits only explicit safe fields and leaves inputs unchanged even when the callback throws", () => {
    const input = context();
    const before = JSON.stringify([input.url.href, input.reply, input.visibleLocalLibraryIds, input.externalLibraries]);
    const report = vi.fn<PrivateDiagnosticReporter>(() => {
      throw new Error("private-callback-error");
    });
    input.reporter = report;
    expect(() => observeDiscoveryResponse(input)).not.toThrow();
    const output = JSON.stringify(report.mock.calls);
    expect(output).not.toMatch(
      /private-account|private-token|local-private|external-private|external-guid|http|\/Users|api_key/,
    );
    expect(Object.keys(report.mock.calls[0][0]).sort()).toEqual(
      [
        "accountType",
        "bodyShape",
        "client",
        "encoding",
        "enabledExternalLibraryCount",
        "externalLibraryCount",
        "itemCount",
        "kind",
        "limit",
        "localLibraryCount",
        "reason",
        "recognizedLibraryDiscovery",
        "registeredExternalLibraryCount",
        "route",
        "startIndex",
        "status",
        "totalRecordCount",
        "visibleLocalLibraryCount",
      ].sort(),
    );
    expect(JSON.stringify([input.url.href, input.reply, input.visibleLocalLibraryIds, input.externalLibraries])).toBe(
      before,
    );
  });
});
