import type { AdapterContext, TrendingAdapter } from "./adapters/common";
import type { TrendingSection } from "./types";

/** A source refresh has a total deadline, including response bodies and pagination. */
export async function fetchSectionsWithDeadline(
  adapter: TrendingAdapter,
  context: AdapterContext,
  timeoutMs = 60_000,
): Promise<TrendingSection[]> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("trending_refresh_timeout"));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      adapter.fetchSections({
        ...context,
        fetchImpl: async (input, init) => {
          const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
          const signal = requestSignal ? AbortSignal.any([controller.signal, requestSignal]) : controller.signal;
          signal.throwIfAborted();
          return context.fetchImpl(input, { ...init, signal });
        },
      }),
      deadline,
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
