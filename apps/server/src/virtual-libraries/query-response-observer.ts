import type { ServerResponse } from "node:http";
import type { UpstreamJson } from "./query-helpers";

const observers = new WeakMap<ServerResponse, (reply: UpstreamJson) => void>();

/** Request-scoped observation only; never buffers or changes a streaming response. */
export function observeJsonResponse(response: ServerResponse, observer: (reply: UpstreamJson) => void) {
  observers.set(response, observer);
}

export function notifyJsonResponse(response: ServerResponse, reply: UpstreamJson) {
  const observer = observers.get(response);
  observers.delete(response);
  try {
    observer?.(reply);
  } catch {
    // Logging must not affect authentication, response bytes or streaming.
  }
}
