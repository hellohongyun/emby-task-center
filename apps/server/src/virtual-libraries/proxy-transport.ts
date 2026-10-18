import { request as httpRequest, type IncomingMessage, type ServerResponse, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";

export interface ProxyTarget {
  upstream: string;
  request: IncomingMessage;
  response: ServerResponse;
  signal: AbortSignal;
}

const hopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function proxyHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const omit = new Set(hopHeaders);
  for (const value of String(headers.connection ?? "").split(",")) omit.add(value.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !omit.has(key.toLowerCase())));
}

export function targetUrl(upstream: string, path: string): URL {
  const base = new URL(upstream);
  const input = new URL(path, "http://proxy.local");
  let pathname = input.pathname;
  const prefix = base.pathname.replace(/\/$/, "");
  if (/\/emby$/i.test(prefix)) pathname = pathname.replace(/^\/emby(?=\/|$)/i, "");
  base.pathname = `${prefix}${pathname || "/"}`;
  base.search = input.search;
  return base;
}

function requestHeaders(context: ProxyTarget, target: URL): IncomingHttpHeaders {
  const headers = proxyHeaders(context.request.headers);
  headers.host = target.host;
  headers["x-forwarded-for"] = [headers["x-forwarded-for"], context.request.socket.remoteAddress]
    .filter(Boolean)
    .join(", ");
  headers["x-forwarded-host"] = context.request.headers["x-forwarded-host"] ?? context.request.headers.host;
  headers["x-forwarded-proto"] = context.request.headers["x-forwarded-proto"] ?? "http";
  return headers;
}

/** Streaming passthrough: no body parser, redirect following, or playback-duration timeout. */
export function forwardRequest(context: ProxyTarget, path = context.request.url ?? "/", onSuccess?: () => void): void {
  const target = targetUrl(context.upstream, path);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = send(
    target,
    {
      method: context.request.method,
      headers: requestHeaders(context, target),
      signal: context.signal,
    },
    (incoming) => {
      const headers = proxyHeaders(incoming.headers);
      context.response.writeHead(incoming.statusCode ?? 502, headers);
      incoming.on("error", () => context.response.destroy());
      incoming.once("end", () => {
        if ((incoming.statusCode ?? 500) < 300 && (incoming.statusCode ?? 0) >= 200) onSuccess?.();
      });
      incoming.pipe(context.response);
    },
  );
  upstream.on("error", () => {
    if (context.response.destroyed) return;
    if (context.response.headersSent) context.response.destroy();
    else {
      context.response.writeHead(502, { "content-type": "application/json" });
      context.response.end(JSON.stringify({ error: "virtual_proxy_upstream_unavailable" }));
    }
  });
  context.request.pipe(upstream);
}

/** Only browsing responses are buffered; every query retains the original Emby user's credentials. */
export function upstreamJson(context: ProxyTarget, url: URL) {
  const originalPrefix = /^\/emby(?=\/|\?|$)/i.test(context.request.url ?? "") ? "/emby" : "";
  const target = targetUrl(context.upstream, `${originalPrefix}${url.pathname}${url.search}`);
  const headers = requestHeaders(context, target);
  headers["accept-encoding"] = "identity";
  delete headers["content-length"];
  delete headers["if-none-match"];
  delete headers["if-modified-since"];
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: unknown; raw: Buffer }>(
    (resolve, reject) => {
      const upstream = send(
        target,
        { method: "GET", headers, signal: AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]) },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.on("error", reject);
          incoming.on("end", () => {
            const raw = Buffer.concat(chunks);
            const data = raw.toString("utf8");
            let body: unknown = data;
            try {
              body = JSON.parse(data);
            } catch {
              /* Keep upstream errors that are not JSON. */
            }
            resolve({ status: incoming.statusCode ?? 502, headers: incoming.headers, body, raw });
          });
        },
      );
      upstream.on("error", reject);
      upstream.end();
    },
  );
}

/** WebSocket is a byte tunnel so upstream session events and control messages stay intact. */
export function forwardUpgrade(upstreamBase: string, request: IncomingMessage, socket: Duplex, head: Buffer): void {
  const target = targetUrl(upstreamBase, request.url ?? "/");
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = send(target, { method: request.method, headers: { ...request.headers, host: target.host } });
  upstream.on("upgrade", (incoming, remote, upstreamHead) => {
    const lines = [`HTTP/${incoming.httpVersion} ${incoming.statusCode} ${incoming.statusMessage}`];
    for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
      lines.push(`${incoming.rawHeaders[i]}: ${incoming.rawHeaders[i + 1]}`);
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) remote.write(head);
    remote.on("error", () => socket.destroy());
    socket.on("error", () => remote.destroy());
    socket.on("close", () => remote.destroy());
    remote.on("close", () => socket.destroy());
    remote.pipe(socket).pipe(remote);
  });
  upstream.on("response", (incoming) => {
    const lines = [
      `HTTP/${incoming.httpVersion} ${incoming.statusCode ?? 502} ${incoming.statusMessage ?? ""}`,
      "Connection: close",
    ];
    for (const [key, value] of Object.entries(proxyHeaders(incoming.headers))) {
      for (const entry of Array.isArray(value) ? value : [value])
        if (entry !== undefined) lines.push(`${key}: ${entry}`);
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    incoming.pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.once("close", () => upstream.destroy());
  socket.once("error", () => upstream.destroy());
  upstream.end();
}
