import express from "express";
import { request as httpRequest } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPublicImageRoutes } from "./public-images";
import type { EmbyClient } from "../integrations/emby-client";

describe("public image routes", () => {
  const nativeFetch = globalThis.fetch;
  let server: Server | undefined;
  afterEach(async () => {
    vi.unstubAllGlobals();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  });
  async function listen(emby?: EmbyClient) {
    const app = express();
    registerPublicImageRoutes(app, emby);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  it("preserves URL boundaries and returns uncached placeholder on upstream failure", async () => {
    const cancel = vi.fn();
    const upstream = vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 500 }));
    vi.stubGlobal("fetch", upstream);
    const base = await listen();
    expect((await nativeFetch(`${base}/api/public/image?url=${encodeURIComponent("http://127.0.0.1/a")}`)).status).toBe(
      403,
    );
    expect(upstream).not.toHaveBeenCalled();
    const response = await nativeFetch(
      `${base}/api/public/image?url=${encodeURIComponent("https://image.tmdb.org/a")}`,
    );
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await response.arrayBuffer();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("aborts an Emby image request when the browser closes its connection", async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cancelled!: () => void;
    const cancelledPromise = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const image = vi.fn(
      (_id, _type, signal: AbortSignal) =>
        new Promise<null>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              cancelled();
              resolve(null);
            },
            { once: true },
          );
          started();
        }),
    );
    const base = await listen({ image } as unknown as EmbyClient);
    const request = httpRequest(`${base}/api/public/emby-poster?id=42`);
    request.on("error", () => undefined);
    request.end();
    await startedPromise;
    request.destroy();
    await cancelledPromise;
    expect(image).toHaveBeenCalledOnce();
  });
  it("aborts an external stalled image request when the browser closes", async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cancelled!: () => void;
    const cancelledPromise = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, options) => {
        options.signal.addEventListener("abort", () => cancelled(), { once: true });
        started();
        return new Promise(() => undefined);
      }),
    );
    const base = await listen();
    const request = httpRequest(`${base}/api/public/image?url=${encodeURIComponent("https://image.tmdb.org/a")}`);
    request.on("error", () => undefined);
    request.end();
    await startedPromise;
    request.destroy();
    await cancelledPromise;
  });
});
