import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type ErrorRequestHandler,
} from "express";
import type { VirtualLibraryStore } from "../virtual-libraries/store";
import { InvalidPosterError, MAX_POSTER_BYTES } from "../virtual-libraries/poster-image";

/** Registered after the administrator gate; binary data lives with the existing database. */
export function registerVirtualLibraryPosterRoutes(app: Express, store: VirtualLibraryStore): void {
  const path = "/api/virtual-libraries/:id/poster";
  const types = ["image/jpeg", "image/png", "image/webp"];
  const parse = express.raw({ type: types, limit: MAX_POSTER_BYTES, inflate: false });
  const parseError: ErrorRequestHandler = (error, _request, response, next) => {
    if (error?.type === "entity.too.large") {
      response.status(413).json({ error: "poster_too_large", message: "图片不能超过 5 MiB。" });
    } else if (error?.status === 400 || error?.status === 415) {
      response.status(error.status).json({ error: "invalid_poster", message: "无法读取图片，请重新选择文件。" });
    } else next(error);
  };
  app.put(
    path,
    (request: Request, response: Response, next: NextFunction) => {
      if (!store.get(String(request.params.id)))
        return void response.status(404).json({ error: "virtual_library_not_found" });
      if (!types.includes(request.get("content-type")?.split(";")[0]?.trim() ?? "")) {
        return void response.status(415).json({ error: "invalid_poster", message: "仅支持 JPEG、PNG 和 WebP 图片。" });
      }
      next();
    },
    parse,
    (request: Request, response: Response) => {
      try {
        const id = String(request.params.id);
        store.setPoster(id, request.body, request.get("content-type")?.split(";")[0]?.trim());
        response.json({ library: store.get(id) });
      } catch (error) {
        if (error instanceof InvalidPosterError)
          response.status(400).json({ error: "invalid_poster", message: error.message });
        else throw error;
      }
    },
    parseError,
  );
  app.get(path, (request, response) => {
    const poster = store.getPoster(String(request.params.id));
    if (!poster) return void response.status(404).json({ error: "poster_not_found" });
    const etag = `"${poster.imageTag}"`;
    response.set({
      "Content-Type": poster.contentType,
      ETag: etag,
      "Cache-Control": "private, no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    if (
      request
        .get("if-none-match")
        ?.split(",")
        .some((value) => [etag, `W/${etag}`, "*"].includes(value.trim()))
    ) {
      return void response.status(304).end();
    }
    response.send(poster.content);
  });
  app.delete(path, (request, response) => {
    const id = String(request.params.id);
    if (!store.get(id)) return void response.status(404).json({ error: "virtual_library_not_found" });
    store.removePoster(id);
    response.json({ library: store.get(id) });
  });
}
