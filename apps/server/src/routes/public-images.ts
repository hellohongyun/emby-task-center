import type { Express, Request, Response } from "express";
import type { EmbyClient } from "../integrations/emby-client";
import { fetchImage } from "../util/image-request";

const allowedImageHosts = [
  "image.tmdb.org",
  "themoviedb.org",
  "doubanio.com",
  "movie.douban.com",
  "maoyan.com",
  "meituan.com",
];
function allowedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      allowedImageHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
    );
  } catch {
    return false;
  }
}

function clientSignal(request: Request, response: Response) {
  const controller = new AbortController();
  const abort = () => {
    if (!response.writableEnded) controller.abort();
  };
  request.once("aborted", abort);
  response.once("close", abort);
  return {
    signal: controller.signal,
    dispose() {
      request.off("aborted", abort);
      response.off("close", abort);
    },
  };
}

export function registerPublicImageRoutes(app: Express, emby?: EmbyClient): void {
  for (const route of ["/api/public/library/poster", "/api/public/emby-poster"]) {
    app.get(route, async (request: Request, response: Response) => {
      const legacy = route.endsWith("library/poster");
      const path = String(request.query.path ?? "").trim();
      const id = legacy ? (path.startsWith("emby:") ? path.slice(5) : "") : String(request.query.id ?? "");
      if (!/^\d+$/.test(id) || !emby?.image) {
        response.status(legacy ? 404 : 400).json({ error: legacy ? "poster_not_found" : "invalid_request" });
        return;
      }
      const client = clientSignal(request, response);
      try {
        const image = await emby.image(id, "Primary", client.signal).catch(() => null);
        if (client.signal.aborted || response.destroyed) return;
        if (!image) {
          response.status(404).json({ error: legacy ? "poster_not_found" : "image_not_found" });
          return;
        }
        response.setHeader("content-type", image.contentType);
        response.setHeader("cache-control", "public, max-age=86400");
        response.send(image.body);
      } finally {
        client.dispose();
      }
    });
  }
  app.get("/api/public/image", async (request: Request, response: Response) => {
    const url = String(request.query.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) return void response.status(400).json({ error: "invalid_url" });
    try {
      new URL(url);
    } catch {
      return void response.status(400).json({ error: "invalid_url" });
    }
    if (!allowedUrl(url)) return void response.status(403).json({ error: "host_not_allowed" });
    const hostname = new URL(url).hostname;
    const referer =
      hostname.includes("doubanio") || hostname.includes("movie.douban")
        ? "https://movie.douban.com/"
        : hostname.includes("maoyan") || hostname.includes("meituan")
          ? "https://maoyan.com/"
          : "https://www.themoviedb.org/";
    const client = clientSignal(request, response);
    try {
      const image = await fetchImage(url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; EmbyTaskCenter/1.0)", accept: "image/*,*/*;q=0.8", referer },
        signal: client.signal,
        allowUrl: allowedUrl,
      });
      if (client.signal.aborted || response.destroyed) return;
      response.setHeader("content-type", image.contentType);
      response.setHeader("cache-control", "public, max-age=86400");
      response.send(image.body);
    } catch {
      if (client.signal.aborted || response.destroyed) return;
      response.setHeader("content-type", "image/svg+xml");
      response.setHeader("cache-control", "no-store");
      response.send(
        Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="440"><rect width="300" height="440" fill="#15242e"/><text x="150" y="230" fill="#3a5666" font-size="44" text-anchor="middle">海报</text></svg>`,
        ),
      );
    } finally {
      client.dispose();
    }
  });
}
