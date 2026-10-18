import { discardBody } from "../util/http";
import type { TmdbClientOptions } from "./client";

/** Bound the entire HTTP operation, including a stalled JSON response body. */
export function createTmdbRequest(options: TmdbClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBaseUrl = options.apiBaseUrl ?? "https://api.themoviedb.org/3";
  const timeoutMs = options.timeoutMs ?? 15_000;
  const usesV3ApiKey = /^[a-f0-9]{32}$/i.test(options.token);
  return async (path: string, query?: URLSearchParams): Promise<unknown> => {
    const requestQuery = new URLSearchParams(query);
    if (usesV3ApiKey) requestQuery.set("api_key", options.token);
    const suffix = requestQuery.size ? `?${requestQuery.toString()}` : "";
    const controller = new AbortController();
    let response: Response | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        discardBody(response);
        reject(new Error("TMDB request timed out."));
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      const operation = (async () => {
        response = await fetchImpl(`${apiBaseUrl}${path}${suffix}`, {
          signal: controller.signal,
          headers: {
            accept: "application/json",
            ...(!usesV3ApiKey ? { authorization: `Bearer ${options.token}` } : {}),
          },
        });
        if (controller.signal.aborted) {
          discardBody(response);
          throw new Error("TMDB request timed out.");
        }
        if (!response.ok) {
          discardBody(response);
          throw new Error("TMDB request failed.");
        }
        return response.json();
      })();
      return await Promise.race([operation, deadline]);
    } catch (error) {
      discardBody(response);
      throw error;
    } finally {
      clearTimeout(timer!);
    }
  };
}
