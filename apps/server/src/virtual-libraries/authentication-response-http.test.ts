import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forwardRequest } from "./proxy-transport";
import { authenticationResponseLimit, type AuthenticationDiagnostic } from "./authentication-response";

describe("bounded authentication observation over real HTTP", () => {
  const servers: Server[] = [];
  const login = { AccessToken: "opaque-secret", User: { Id: "alice" }, SessionInfo: null };
  let wire: Buffer;
  let encoding: string;
  let status: number;
  let base: string;
  let observed: unknown[];
  let diagnostics: AuthenticationDiagnostic[];
  let observerThrows: boolean;
  async function listen(server: Server) {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  beforeEach(async () => {
    wire = Buffer.from("\uFEFF" + JSON.stringify(login));
    encoding = "identity";
    status = 200;
    observed = [];
    diagnostics = [];
    observerThrows = false;
    const upstream = await listen(
      createServer((req, res) => {
        req.resume();
        res.writeHead(status, {
          "content-type": "application/json",
          "content-encoding": encoding,
          "content-length": String(wire.length),
        });
        res.end(wire);
      }),
    );
    base = await listen(
      createServer((req, res) =>
        forwardRequest(
          { upstream, request: req, response: res, signal: new AbortController().signal },
          undefined,
          undefined,
          (body) => {
            if (observerThrows) throw new Error("must not escape or log opaque-secret");
            observed.push(body);
          },
          (result) => diagnostics.push(result),
        ),
      ),
    );
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  // node:http deliberately avoids the automatic decompression performed by fetch.
  async function send() {
    return new Promise<{ status: number; encoding?: string; wire: Buffer }>((resolve, reject) => {
      const req = request(base + "/emby/Users/AuthenticateByName.json", { method: "POST" }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode!, encoding: res.headers["content-encoding"], wire: Buffer.concat(chunks) }),
        );
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end("{}");
    });
  }
  it.each(["identity", "gzip", "deflate", "br"])(
    "decodes %s plus BOM while preserving the response wire",
    async (kind) => {
      encoding = kind;
      if (kind === "gzip") wire = gzipSync(wire);
      if (kind === "deflate") wire = deflateSync(wire);
      if (kind === "br") wire = brotliCompressSync(wire);
      expect(await send()).toEqual({ status, encoding, wire });
      expect(observed).toEqual([login]);
      expect(diagnostics).toEqual([{ status, encoding, bytes: wire.length, reason: "decoded" }]);
      expect(JSON.stringify(diagnostics)).not.toContain("opaque-secret");
    },
  );
  it.each(["gzip", "deflate", "br"])("bounds decoded %s expansion without changing the wire", async (kind) => {
    encoding = kind;
    const oversized = Buffer.from(JSON.stringify({ ...login, Extra: "x".repeat(authenticationResponseLimit) }));
    wire =
      kind === "gzip"
        ? gzipSync(oversized)
        : kind === "deflate"
          ? deflateSync(oversized)
          : brotliCompressSync(oversized);
    expect((await send()).wire).toEqual(wire);
    expect(observed).toEqual([]);
    expect(diagnostics[0].reason).toBe("response_too_large");
  });
  it("accepts the decoded boundary and rejects oversized wire bodies", async () => {
    wire = Buffer.from(JSON.stringify(login).padEnd(authenticationResponseLimit));
    await send();
    expect(observed).toEqual([login]);
    observed = [];
    wire = Buffer.concat([wire, Buffer.from(" ")]);
    expect((await send()).wire).toEqual(wire);
    expect(observed).toEqual([]);
    expect(diagnostics.at(-1)?.reason).toBe("response_too_large");
  });
  it.each([
    [401, "identity", "non_success_response"],
    [200, "gzip", "decoding_failed"],
    [200, "opaque-secret", "unsupported_encoding"],
    [200, "gzip, br", "unsupported_encoding"],
  ])("rejects opaque authentication replies %s/%s without disrupting passthrough", async (code, kind, reason) => {
    status = Number(code);
    encoding = kind;
    expect(await send()).toEqual({ status, encoding, wire });
    expect(observed).toEqual([]);
    expect(diagnostics[0].reason).toBe(reason);
    expect(JSON.stringify(diagnostics)).not.toContain("opaque-secret");
  });
  it("isolates invalid JSON and failing observers", async () => {
    wire = Buffer.from("not json opaque-secret");
    expect((await send()).wire).toEqual(wire);
    expect(diagnostics[0].reason).toBe("invalid_json");
    wire = Buffer.from(JSON.stringify(login));
    observerThrows = true;
    expect((await send()).wire).toEqual(wire);
    expect(diagnostics.at(-1)?.reason).toBe("observer_error");
    expect(JSON.stringify(diagnostics)).not.toContain("opaque-secret");
  });
});
