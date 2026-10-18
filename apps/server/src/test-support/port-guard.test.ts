import { createServer } from "node:http";
import { describe, expect, it } from "vitest";

import { FETCH_BLOCKED_PORTS, installSafeListen } from "./port-guard";

describe("port guard (test-only)", () => {
  it("never hands out a port that fetch refuses", async () => {
    installSafeListen();
    const ports: number[] = [];
    for (let index = 0; index < 200; index += 1) {
      const server = createServer(() => undefined);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      if (address && typeof address === "object") ports.push(address.port);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(ports.length).toBe(200);
    expect(ports.filter((port) => FETCH_BLOCKED_PORTS.has(port))).toEqual([]);
    // 端口必须仍然各不相同地"可用"：全部落在安全区间内
    expect(Math.min(...ports)).toBeGreaterThanOrEqual(20_000);
    expect(Math.max(...ports)).toBeLessThanOrEqual(60_000);
  });

  it("lets a real fetch reach a listen(0) server", async () => {
    installSafeListen();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;

    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("leaves explicit ports untouched", async () => {
    installSafeListen();
    const server = createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(18_765, resolve));
    const address = server.address();
    expect(address && typeof address === "object" ? address.port : 0).toBe(18_765);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
