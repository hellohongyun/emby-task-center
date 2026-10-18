/**
 * HTTP 响应体的释放工具。
 *
 * 未消费的响应体会占用网络资源；失败、提前退出和超时路径应主动释放。
 * 线上曾出现 undici 的 `assert(!this.paused)` 异常，但仅凭失败响应未释放
 * 不能认定这些异常或容器重启的根因，仍需结合堆栈及运行日志定位。
 *
 * 所以：**凡是拿到 response 又不打算读 body 的分支，都必须先调用它。**
 */
export function discardBody(response: Response | undefined): void {
  try {
    void response?.body?.cancel().catch(() => undefined);
  } catch {
    // 释放失败不影响业务；这里绝不能再抛。
  }
}
