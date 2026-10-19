import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { appSettings } from "@emby-task-center/database/schema";
import type { VirtualQueryStore } from "./query-helpers";

export interface OwnedViewAnchor {
  id: string;
  previous: string[];
  next: string[];
}
export interface OwnedViewPreferences {
  read(upstream: string, user: string): OwnedViewAnchor[];
  observe(request: IncomingMessage, response: ServerResponse, url: URL, upstream: string): void;
}

export function viewIdentity(value: string) {
  return /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(value)
    ? value.replaceAll("-", "").toLowerCase()
    : value;
}

export function createOwnedViewPreferences(database: AppDatabase, store: VirtualQueryStore): OwnedViewPreferences {
  const key = (upstream: string, user: string) => {
    const target = new URL(upstream);
    target.username = "";
    target.password = "";
    target.search = "";
    target.hash = "";
    const scope = [target.toString().replace(/\/$/, ""), viewIdentity(user)];
    return `virtualLibraryOrder.${createHash("sha256").update(JSON.stringify(scope)).digest("hex")}`;
  };
  return {
    read(upstream, user) {
      try {
        const row = database
          .select()
          .from(appSettings)
          .where(eq(appSettings.key, key(upstream, user)))
          .get();
        const value = JSON.parse(row?.value ?? "[]") as OwnedViewAnchor[];
        return Array.isArray(value)
          ? value.filter(
              (entry) =>
                typeof entry?.id === "string" &&
                Array.isArray(entry.previous) &&
                Array.isArray(entry.next) &&
                entry.previous.every((id) => typeof id === "string") &&
                entry.next.every((id) => typeof id === "string"),
            )
          : [];
      } catch {
        return [];
      }
    },
    observe(request, response, url, upstream) {
      if (request.method !== "POST" || !store.list().length) return;
      const match = /^\/Users\/([^/]+)\/Configuration(?:\/Partial)?\/?$/i.exec(url.pathname);
      if (!match) return;
      const chunks: Buffer[] = [];
      let bytes = 0;
      let completed = false;
      request.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes <= 256 * 1024) chunks.push(Buffer.from(chunk));
        else chunks.length = 0;
      });
      request.once("end", () => {
        completed = true;
      });
      response.once("finish", () => {
        if (!completed || bytes > 256 * 1024 || response.statusCode < 200 || response.statusCode >= 300) return;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (
            !Array.isArray(body?.OrderedViews) ||
            body.OrderedViews.length > 5000 ||
            !body.OrderedViews.every((id: unknown) => typeof id === "string")
          )
            return;
          const order: string[] = [...new Set<string>(body.OrderedViews.map(viewIdentity))];
          const owned = new Set(store.list().map((library) => viewIdentity(library.id)));
          const anchors = order.flatMap((id, index) =>
            owned.has(id) ? [{ id, previous: order.slice(0, index).reverse(), next: order.slice(index + 1) }] : [],
          );
          const row = {
            key: key(upstream, decodeURIComponent(match[1])),
            value: JSON.stringify(anchors),
            updatedAt: new Date().toISOString(),
            updatedBy: "virtual-library-proxy",
            isSecret: false,
          };
          database
            .insert(appSettings)
            .values(row)
            .onConflictDoUpdate({
              target: appSettings.key,
              set: { value: row.value, updatedAt: row.updatedAt, updatedBy: row.updatedBy },
            })
            .run();
        } catch {
          // Observation must never change an otherwise successful upstream response.
        }
      });
    },
  };
}
