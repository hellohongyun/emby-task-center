import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { createVirtualLibraryStore } from "./store";
import { createVirtualProxyHandler } from "./proxy-handler";
import { createPrivateTokenIdentity } from "./private-token-identity";
import { createPrivateDiagnosticReporter, type PrivateDiagnostic } from "./private-diagnostics";

const servers: Server[] = [];
let database: DatabaseHandle | undefined;
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  database?.close();
});

describe("private identity diagnostics through HTTP", () => {
  it.each(["SenPlayer", "Yamby", "Hills", "VidHub"] as const)(
    "reports %s discovery and login stages without credentials",
    async (client) => {
      database = createDatabase(":memory:");
      const own = createVirtualLibraryStore(database.db, { ownerMemberId: 7 }).create({ name: "private-title" });
      const shared = createVirtualLibraryStore(database.db).create({ name: "shared-title" });
      const entries: PrivateDiagnostic[] = [];
      let validationStatus = 200;
      const upstream = await listen(
        createServer((req, res) => {
          req.resume();
          const login = req.method === "POST";
          res
            .writeHead(login ? 200 : validationStatus, { "content-type": "application/json" })
            .end(
              JSON.stringify(
                login
                  ? { AccessToken: "opaque-secret", User: { Id: "private-account" } }
                  : req.url?.includes("/Views")
                    ? { Items: [], TotalRecordCount: 0 }
                    : { Id: "private-account" },
              ),
            );
        }),
      );
      const base = await listen(
        createServer(
          createVirtualProxyHandler(
            createVirtualLibraryStore(database.db, { all: true }),
            () => upstream,
            "test-marker",
            undefined,
            undefined,
            (id) => (id === "private-account" ? 7 : undefined),
            createPrivateTokenIdentity(),
            createPrivateDiagnosticReporter((entry) => entries.push(entry)),
          ),
        ),
      );
      const headers = {
        "x-emby-token": "opaque-secret",
        "x-emby-authorization": `Emby Client="${client}", Token="", DeviceId="secret-device"`,
      };
      const views = async () => {
        const r = await fetch(base + "/Users/private-account/Views", { headers });
        return ((await r.json()) as { Items: { Id: string }[] }).Items.map((item) => item.Id);
      };
      expect(await views()).toEqual([shared.id]);
      expect(entries).toContainEqual({ client, route: "views", reason: "login_proof_missing" });
      const login = await fetch(base + "/Users/AuthenticateByName", {
        method: "POST",
        headers,
        body: "private-password",
      });
      await login.arrayBuffer();
      expect(entries).toContainEqual({ client, route: "login", reason: "recorded" });
      expect(entries).toContainEqual(
        expect.objectContaining({ client, route: "login", reason: "decoded", status: 200 }),
      );
      expect(await views()).toEqual([own.id, shared.id]);
      expect(entries).toContainEqual({ client, route: "views", reason: "private_scope_ready", privateLibraryCount: 1 });
      validationStatus = 401;
      await views();
      expect(entries).toContainEqual({ client, route: "views", reason: "validation_failed", status: 401 });
      expect(JSON.stringify(entries)).not.toMatch(
        /opaque-secret|private-account|private-password|secret-device|private-title/,
      );
    },
  );
});
