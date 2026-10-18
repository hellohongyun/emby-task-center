/**
 * 磁力链接 → 实际文件大小（尽力而为，纯 JS，无原生依赖）。
 *
 * 流程：解析 infohash → DHT lookup 找 peer → TCP 握手 + ut_metadata 拉取种子元数据
 *（不下载内容）→ bencode 解析 info 目录求和得到总大小。
 * 失败（无 peer / 死种 / 网络受限）返回 null，调用方回退到标题/备注里的大小。
 */

import { randomBytes } from "node:crypto";
import net from "node:net";

import DHT from "bittorrent-dht";
import Protocol from "bittorrent-protocol";
import utMetadata from "ut_metadata";
import bencode from "bencode";

/** infohash → 解析出的大小，避免重复走 BT。 */
const cache = new Map<string, string>();

function formatBytes(bytes: number): string | null {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)}GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${Math.round(mb)}MB`;
  return `${Math.round(bytes / 1024)}KB`;
}

function magnetInfoHash(magnet: string): string | null {
  const match = /xt=urn:btih:([0-9a-fA-F]{40})/.exec(magnet);
  return match ? match[1].toLowerCase() : null;
}

function sizeFromInfo(info: Record<string, unknown>): number | null {
  const files = info.files;
  if (Array.isArray(files)) {
    let total = 0;
    for (const file of files) {
      const n = Number((file as { length?: unknown }).length ?? 0);
      if (Number.isFinite(n)) total += n;
    }
    return total;
  }
  const n = Number(info.length ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function resolveMagnetSize(magnet: string, timeoutMs = 10_000): Promise<string | null> {
  if (!/^magnet:/i.test(magnet)) return null;
  const infoHash = magnetInfoHash(magnet);
  if (!infoHash) return null;
  const cached = cache.get(infoHash);
  if (cached) return cached;

  const infoHashBuf = Buffer.from(infoHash, "hex");
  const peerId = Buffer.concat([Buffer.from("-MG0001-"), randomBytes(12)]);
  let connecting = false;

  return await new Promise<string | null>((resolve) => {
    let done = false;
    const dht = new DHT();
    const finish = (size: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        dht.destroy();
      } catch {
        /* ignore */
      }
      if (size) cache.set(infoHash, size);
      resolve(size);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    dht.on("error", () => finish(null));

    function tryPeer(peer: { host: string; port: number }) {
      if (done || connecting) return;
      connecting = true;
      const socket = net.connect(peer.port, peer.host);
      const wire = new Protocol();
      const cleanup = () => {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
        connecting = false;
      };
      socket.setTimeout(4_000, cleanup);
      wire.on("error", () => {
        cleanup();
        dht.once("peer", (p) => tryPeer(p));
      });
      socket.on("error", () => {
        cleanup();
        dht.once("peer", (p) => tryPeer(p));
      });
      wire.use(utMetadata());
      wire.on("ut_metadata", (meta: { on(event: string, cb: (metadata: Buffer, hash: Buffer) => void): void }) => {
        meta.on("metadata", (metadata: Buffer) => {
          try {
            const info = bencode.decode(metadata) as Record<string, unknown>;
            const bytes = sizeFromInfo(info);
            if (bytes) finish(formatBytes(bytes));
          } catch {
            finish(null);
          }
        });
      });
      socket.on("connect", () => {
        socket.pipe(wire as unknown as NodeJS.WritableStream);
        (wire as unknown as NodeJS.ReadableStream).pipe(socket);
        wire.handshake(infoHashBuf, peerId, { dht: true });
      });
    }

    dht.on("peer", (peer: { host: string; port: number }, hash: Buffer) => {
      if (hash.toString("hex") === infoHash) tryPeer(peer);
    });
    // 必须先 listen 绑定 UDP 端口，否则 DHT lookup 无法收到路由/peer 应答。
    dht.listen(0, () => dht.lookup(infoHash));
  });
}
