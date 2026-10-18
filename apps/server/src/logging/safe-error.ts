/** 日志里统一的错误文本化（避免把整个 Error 对象塞进 JSON）。 */
export function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
