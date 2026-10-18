import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJsonWithTimeout, fetchWithTimeout } from "./request-timeout";

afterEach(() => vi.useRealTimers());
describe("JSON request deadlines", () => {
  it.each([fetchJsonWithTimeout, fetchWithTimeout])(
    "does not start transport for an already cancelled request",
    async (fetchRequest) => {
      const fetchImpl = vi.fn();
      const controller = new AbortController();
      controller.abort();
      await expect(fetchRequest(fetchImpl, "/api/tasks", { signal: controller.signal })).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
  it("times out a stalled response body and aborts its transport", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url, init) => {
      signal = init?.signal;
      return { ok: true, json: () => new Promise(() => undefined) } as unknown as Response;
    }) as unknown as typeof fetch;
    const pending = fetchJsonWithTimeout(fetchImpl, "/api/tasks", {}, 100);
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(signal?.aborted).toBe(true);
  });

  it("does not wait for an error body before returning unauthorized", async () => {
    const json = vi.fn(() => new Promise(() => undefined));
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json }) as unknown as Response);
    const result = await fetchJsonWithTimeout(fetchImpl, "/api/tasks");
    expect(result.response.status).toBe(401);
    expect(result.body).toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  });
});
