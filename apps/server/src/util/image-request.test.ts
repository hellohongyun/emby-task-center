import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchImage } from "./image-request";

describe("image request lifecycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  function tracked(status = 200, headers: Record<string, string> = { "content-type": "image/jpeg" }) {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { status, headers });
    return { response, cancel };
  }
  it.each([404, 429, 500])("releases unread HTTP %i bodies", async (status) => {
    const source = tracked(status);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(source.response));
    await expect(fetchImage("https://image.tmdb.org/a")).rejects.toThrow(`image_http_${status}`);
    expect(source.cancel).toHaveBeenCalledOnce();
  });
  it("rejects HTML responses and oversized declared lengths without reading", async () => {
    const headerCases: Record<string, string>[] = [
      { "content-type": "text/html" },
      { "content-type": "image/jpeg", "content-length": "50" },
    ];
    for (const headers of headerCases) {
      const source = tracked(200, headers);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(source.response));
      await expect(fetchImage("https://image.tmdb.org/a", { maxBytes: 10 })).rejects.toThrow();
      expect(source.cancel).toHaveBeenCalledOnce();
    }
  });
  it("bounds streamed bytes even when content-length is absent", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(11));
        },
        cancel,
      }),
      { headers: { "content-type": "image/png" } },
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(fetchImage("https://image.tmdb.org/a", { maxBytes: 10 })).rejects.toThrow("image_too_large");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("cancels a stalled response body when its overall deadline expires", async () => {
    vi.useFakeTimers();
    const source = tracked();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(source.response));
    const result = expect(fetchImage("https://image.tmdb.org/a", { timeoutMs: 20 })).rejects.toThrow("image_timeout");
    await vi.advanceTimersByTimeAsync(20);
    await result;
    expect(source.cancel).toHaveBeenCalledOnce();
  });
  it("releases a response that arrives after a timed-out transport", async () => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        () =>
          new Promise<Response>((r) => {
            resolve = r;
          }),
      ),
    );
    const result = expect(fetchImage("https://image.tmdb.org/a", { timeoutMs: 20 })).rejects.toThrow("image_timeout");
    await vi.advanceTimersByTimeAsync(20);
    await result;
    const source = tracked();
    resolve(source.response);
    await Promise.resolve();
    expect(source.cancel).toHaveBeenCalledOnce();
  });
  it("cancels upstream when the caller disconnects", async () => {
    const source = tracked();
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(source.response);
    vi.stubGlobal("fetch", fetchMock);
    const result = expect(fetchImage("https://image.tmdb.org/a", { signal: controller.signal })).rejects.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await result;
    expect(fetchMock.mock.calls[0]?.[1].signal.aborted).toBe(true);
    expect(source.cancel).toHaveBeenCalledOnce();
  });
  it("rejects redirected hosts and releases the redirect body", async () => {
    const source = tracked(302, { location: "http://127.0.0.1/private" });
    const fetchMock = vi.fn().mockResolvedValue(source.response);
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fetchImage("https://image.tmdb.org/a", { allowUrl: (url) => new URL(url).hostname === "image.tmdb.org" }),
    ).rejects.toThrow("image_host_not_allowed");
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("returns a complete valid image", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/webp" } })),
    );
    expect(await fetchImage("https://image.tmdb.org/a")).toEqual({
      contentType: "image/webp",
      body: Buffer.from([1, 2, 3]),
    });
  });
  it("cancels the reader after a body read fails", async () => {
    const response = tracked().response;
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(response.body!, "getReader").mockReturnValue({
      read: vi.fn().mockRejectedValue(new Error("broken_body")),
      cancel,
    } as unknown as ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(fetchImage("https://image.tmdb.org/a")).rejects.toThrow("broken_body");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("does not start an upstream request for an already-aborted caller", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const controller = new AbortController();
    controller.abort();
    await expect(fetchImage("https://image.tmdb.org/a", { signal: controller.signal })).rejects.toThrow();
    expect(upstream).not.toHaveBeenCalled();
  });
});
