/**
 * 测试用端口守卫（让间歇性 "fetch failed: bad port" 不再出现）。
 *
 * 根因（2026-09-10 实测确认）：
 *  - 本机 Windows 动态端口范围是 `netsh int ipv4 show dynamicport tcp` = **1024 起、13977 个**（1024–15000）；
 *  - `server.listen(0)` 因此可能拿到 1024–15000 之间的任意端口，多次采样落在 2359–4159 / 10243–10804；
 *  - 而 WHATWG fetch（undici）**拒绝**一批端口（6000、6666、10080、4045、1719…）。
 *  - 于是当某个测试文件的服务恰好绑到这些端口时，`fetch(http://127.0.0.1:<该端口>)` 直接抛
 *    `TypeError: fetch failed / Caused by: Error: bad port`——这就是此前三次全量跑里
 *    随机出现在不同测试文件上的"偶发失败"。
 *
 * 处理方式：仅在测试环境把 `listen(0)`（系统临时分配）替换为"从安全范围内随机取端口 + 遇忙重试"，
 * 显式端口的 listen 调用完全不受影响。
 */
import { Server } from "node:http";

/** WHATWG fetch 规范禁用端口（与 undici 的实现一致）。 */
export const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
  111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

const SAFE_MIN = 20_000;
const SAFE_MAX = 60_000;
const MAX_ATTEMPTS = 8;

function randomSafePort(): number {
  for (;;) {
    const port = SAFE_MIN + Math.floor(Math.random() * (SAFE_MAX - SAFE_MIN));
    if (!FETCH_BLOCKED_PORTS.has(port)) return port;
  }
}

let installed = false;

/** 幂等安装：多次调用只生效一次。 */
export function installSafeListen(): void {
  if (installed) return;
  installed = true;

  const originalListen = Server.prototype.listen;
  Server.prototype.listen = function safeListen(this: Server, ...args: unknown[]) {
    const numericIndex = args.findIndex((value) => typeof value === "number");
    // 只处理 listen(0)：其余（固定端口、pipe、options 对象）原样交给 Node。
    if (numericIndex === -1 || args[numericIndex] !== 0) {
      return (originalListen as (...callArgs: unknown[]) => Server).apply(this, args);
    }

    let attempts = 0;
    const tryPort = (): void => {
      attempts += 1;
      const nextArgs = [...args];
      nextArgs[numericIndex] = randomSafePort();
      const onError = (error: NodeJS.ErrnoException): void => {
        this.removeListener("error", onError);
        if (error.code === "EADDRINUSE" && attempts < MAX_ATTEMPTS) tryPort();
        else this.emit("error", error);
      };
      this.once("error", onError);
      (originalListen as (...callArgs: unknown[]) => Server).apply(this, nextArgs);
    };
    tryPort();
    return this;
  } as typeof Server.prototype.listen;
}
