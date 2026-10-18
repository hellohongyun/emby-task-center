/**
 * 路由层共享小工具（P4）。
 *
 * 各路由文件都要把 Express 的 `req.params.x`（string | string[] | undefined）转成正整数 ID，
 * 收在一处，避免每个文件各写一份。
 */
export function readId(value: string | string[] | undefined): number | null {
  const id = Number(typeof value === "string" ? value : Array.isArray(value) ? value[0] : 0);
  return Number.isInteger(id) && id > 0 ? id : null;
}
