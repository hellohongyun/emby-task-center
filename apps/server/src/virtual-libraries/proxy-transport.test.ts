import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forwardRequest, forwardUpgrade, upstreamJson, type ProxyTarget } from "./proxy-transport";

describe("virtual proxy streaming transport over HTTP", () => {
  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  let upstream: string;
  let proxy: string;
  let captured: { url?: string; headers?: IncomingMessage["headers"]; body?: Buffer };

  async function listen(handler?: (request: IncomingMessage, response: ServerResponse) => void) {
    const server = createServer(handler);
    servers.push(server);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  beforeEach(async () => {
    captured = {};
    const remote = await listen(async (request, response) => {
      captured.url = request.url;
      captured.headers = request.headers;
      if (request.url === "/emby/stream") {
        captured.body = Buffer.alloc(0);
        let acknowledged = false;
        request.on("data", (chunk: Buffer) => {
          captured.body = Buffer.concat([captured.body!, chunk]);
          if (!acknowledged) {
            acknowledged = true;
            response.write("ack");
          }
        });
        request.on("end", () => response.end("done"));
      } else if (request.url?.startsWith("/emby/redirect")) {
        const external = request.url.endsWith("external");
        response
          .writeHead(302, {
            location: external
              ? "https://cdn.test/a?token=opaque"
              : request.url.endsWith("relative")
                ? "../web/index.html?x=1"
                : `${upstream}/emby/web/index.html?x=1`,
          })
          .end();
      } else if (request.url?.startsWith("/emby/range")) {
        response.writeHead(206, {
          "content-type": "application/octet-stream",
          "content-range": "bytes 2-5/10",
          "content-length": "4",
        });
        response.end(request.method === "HEAD" ? undefined : "2345");
      } else if (request.url?.startsWith("/emby/json")) {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      } else {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        captured.body = Buffer.concat(chunks);
        response.writeHead(200, { "content-type": "application/octet-stream" }).end(captured.body);
      }
    });
    upstream = remote.url;
    remote.server.on("upgrade", (request, socket, head) => {
      captured.url = request.url;
      captured.headers = request.headers;
      if (request.url === "/emby/denied") {
        socket.end(
          'HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Emby realm="server"\r\nContent-Length: 6\r\nConnection: close\r\n\r\ndenied',
        );
        return;
      }
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nserver-head|");
      if (head.length) socket.write(`echo:${head.toString()}|`);
      socket.on("data", (chunk) => socket.write(`echo:${chunk.toString()}|`));
    });
    const local = await listen((request, response) => {
      const abort = new AbortController();
      response.once("close", () => abort.abort());
      const context: ProxyTarget = { upstream: `${upstream}/emby`, request, response, signal: abort.signal };
      if (request.url?.startsWith("/json")) {
        void upstreamJson(context, new URL(request.url, "http://proxy.local")).then((result) =>
          response.end(JSON.stringify(result.body)),
        );
      } else forwardRequest(context);
    });
    local.server.on("upgrade", (request, socket, head) => forwardUpgrade(`${upstream}/emby`, request, socket, head));
    proxy = local.url;
  });
  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it("streams binary POST bodies without parsing and keeps caller authentication and query strings", async () => {
    const payload = Buffer.from([0, 1, 2, 255, 123, 13, 10]);
    const response = await fetch(`${proxy}/emby/Items/abc/PlaybackInfo?api_key=client-token`, {
      method: "POST",
      body: payload,
      headers: {
        "content-type": "application/octet-stream",
        "x-emby-token": "client-token",
        "x-emby-authorization": "MediaBrowser Client=phone",
      },
    });
    expect(Buffer.from(await response.arrayBuffer())).toEqual(payload);
    expect(captured).toMatchObject({
      url: "/emby/Items/abc/PlaybackInfo?api_key=client-token",
      body: payload,
      headers: { "x-emby-token": "client-token", "x-emby-authorization": "MediaBrowser Client=phone" },
    });
    expect(captured.headers?.host).toBe(new URL(upstream).host);
  });

  it("preserves every external, same-origin and relative redirect Location verbatim", async () => {
    const external = await fetch(`${proxy}/redirect/external`, { redirect: "manual" });
    expect(external.status).toBe(302);
    expect(external.headers.get("location")).toBe("https://cdn.test/a?token=opaque");
    const same = await fetch(`${proxy}/redirect/local`, { redirect: "manual" });
    expect(same.status).toBe(302);
    expect(same.headers.get("location")).toBe(`${upstream}/emby/web/index.html?x=1`);
    const relative = await fetch(`${proxy}/redirect/relative`, { redirect: "manual" });
    expect(relative.headers.get("location")).toBe("../web/index.html?x=1");
  });

  it("preserves range status, headers, body and HEAD semantics", async () => {
    const response = await fetch(`${proxy}/range`, { headers: { range: "bytes=2-5" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await response.text()).toBe("2345");
    expect(captured.headers?.range).toBe("bytes=2-5");
    const head = await fetch(`${proxy}/range`, { method: "HEAD", headers: { range: "bytes=2-5" } });
    expect(head.status).toBe(206);
    expect(head.headers.get("content-length")).toBe("4");
    expect(await head.text()).toBe("");
  });

  it("forwards upload chunks before the request body has ended", async () => {
    const received = await new Promise<string>((resolve, reject) => {
      const request = httpRequest(`${proxy}/stream`, { method: "POST" }, (response) => {
        let text = "";
        let ended = false;
        response.on("data", (chunk: Buffer) => {
          text += chunk.toString();
          if (!ended) {
            ended = true;
            request.end("second");
          }
        });
        response.on("end", () => resolve(text));
        response.on("error", reject);
      });
      request.on("error", reject);
      request.write("first");
    });
    expect(received).toBe("ackdone");
    expect(captured.body?.toString()).toBe("firstsecond");
  });

  it("buffers browsing JSON using only client credentials", async () => {
    expect(await (await fetch(`${proxy}/json?api_key=user`, { headers: { "x-emby-token": "user" } })).json()).toEqual({
      ok: true,
    });
    expect(captured.headers?.["x-emby-token"]).toBe("user");
    expect(captured.headers?.["accept-encoding"]).toBe("identity");
    expect(captured.url).toBe("/emby/json?api_key=user");
  });

  it("tunnels WebSocket upgrade headers, handshake head and subsequent bytes bidirectionally", async () => {
    const address = new URL(proxy);
    const socket = connect(Number(address.port), address.hostname);
    sockets.add(socket);
    let received = "";
    const finished = new Promise<void>((resolve, reject) => {
      socket.on("error", reject);
      let sent = false;
      socket.on("data", (chunk) => {
        received += chunk.toString();
        if (received.includes("server-head|") && !sent) {
          sent = true;
          socket.write("client-next");
        }
        if (received.includes("echo:client-head|") && received.includes("echo:client-next|")) resolve();
      });
    });
    socket.write(
      `GET /emby/embywebsocket?api_key=websocket-user HTTP/1.1\r\nHost: ${address.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nX-Emby-Token: websocket-user\r\n\r\nclient-head`,
    );
    await finished;
    expect(received).toContain("101 Switching Protocols");
    expect(captured.headers?.["x-emby-token"]).toBe("websocket-user");
    expect(captured.url).toBe("/emby/embywebsocket?api_key=websocket-user");
    socket.destroy();
  });

  it("preserves upstream WebSocket handshake rejection headers and body", async () => {
    const address = new URL(proxy);
    const socket = connect(Number(address.port), address.hostname);
    sockets.add(socket);
    const received = new Promise<string>((resolve, reject) => {
      let text = "";
      socket.on("data", (chunk) => {
        text += chunk.toString();
      });
      socket.on("end", () => {
        socket.end();
        resolve(text);
      });
      socket.on("error", reject);
    });
    socket.write(`GET /denied HTTP/1.1\r\nHost: ${address.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    const response = await received;
    expect(response).toContain("401 Unauthorized");
    expect(response.toLowerCase()).toContain('www-authenticate: emby realm="server"');
    expect(response.endsWith("denied")).toBe(true);
  });
});
