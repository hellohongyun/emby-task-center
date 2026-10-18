import { discardBody } from "./http";

/** Shared image deadline covers transport and body; bounded reads never buffer an unlimited response. */
export async function fetchImage(
  url: string,
  options: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxBytes?: number;
    allowUrl?: (url: string) => boolean;
  } = {},
): Promise<{ contentType: string; body: Buffer }> {
  const controller = new AbortController();
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const deadline = setTimeout(() => controller.abort(new Error("image_timeout")), options.timeoutMs ?? 8000);
  deadline.unref();
  let rejectAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason ?? new Error("image_aborted"));
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
    if (controller.signal.aborted) rejectAbort();
  });
  const run = async () => {
    let currentUrl = url;
    for (let redirects = 0; ; redirects++) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (options.allowUrl && !options.allowUrl(currentUrl)) throw new Error("image_host_not_allowed");
      response = await fetch(currentUrl, { headers: options.headers, signal: controller.signal, redirect: "manual" });
      if (controller.signal.aborted) {
        discardBody(response);
        throw controller.signal.reason;
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      discardBody(response);
      if (!location || redirects >= 5) throw new Error("image_redirect_invalid");
      currentUrl = new URL(location, currentUrl).href;
    }
    if (!response.ok) throw new Error(`image_http_${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^image\/[a-z0-9.+-]+(?:\s*;|$)/i.test(contentType)) throw new Error("image_content_type_invalid");
    const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("image_too_large");
    if (!response.body) throw new Error("image_body_missing");
    reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let length = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxBytes) throw new Error("image_too_large");
      chunks.push(Buffer.from(chunk.value));
    }
    return { contentType, body: Buffer.concat(chunks, length) };
  };
  try {
    return await Promise.race([run(), interrupted]);
  } catch (error) {
    controller.abort(error);
    if (reader) void reader.cancel().catch(() => undefined);
    else discardBody(response);
    throw error;
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", abort);
    if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
  }
}
