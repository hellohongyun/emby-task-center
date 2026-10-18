import { effectScope } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettings } from "./useSettings";

const stops: Array<() => void> = [];
const payload = (username = "admin") => ({
  groups: [],
  admin: { username, hasPassword: true, mustChangePassword: false },
  warnings: [],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
function subject(fetchImpl: typeof fetch) {
  const scope = effectScope();
  const auth = vi.fn();
  const api = scope.run(() => useSettings(auth, fetchImpl))!;
  stops.push(() => scope.stop());
  return { api, auth, stop: () => scope.stop() };
}
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
});

describe("settings request lifecycle", () => {
  it.each([200, 500])("bounds a stalled %i JSON body to 15 seconds", async (status) => {
    vi.useFakeTimers();
    const response = Response.json({}, { status });
    vi.spyOn(response, "json").mockReturnValue(new Promise(() => {}));
    const { api } = subject(vi.fn().mockResolvedValue(response));
    const pending = api.load();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toBe(false);
    expect(api.loading.value).toBe(false);
    expect(api.error.value).toContain("无法读取");
  });

  it("aborts an older load and keeps the latest state", async () => {
    const old = deferred<Response>();
    const fetchImpl = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(Response.json(payload("new")));
    const { api } = subject(fetchImpl);
    const pending = api.load();
    const signal = fetchImpl.mock.calls[0]![1].signal as AbortSignal;
    await api.load();
    old.resolve(Response.json(payload("old")));
    await pending;
    expect(signal.aborted).toBe(true);
    expect(api.admin.value.username).toBe("new");
    expect(api.error.value).toBe("");
  });

  it("stops new requests and ignores old unauthorized responses after disposal", async () => {
    const old = deferred<Response>();
    const fetchImpl = vi.fn().mockReturnValue(old.promise);
    const { api, auth, stop } = subject(fetchImpl);
    const pending = api.load();
    stop();
    old.resolve(Response.json({ error: "unauthorized" }, { status: 401 }));
    await pending;
    await api.load();
    await api.save({ example: true });
    await api.changePassword("old", "new");
    expect(auth).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(api.error.value).toBe("");
  });

  it("does not allow an old load or a concurrent load to overwrite a save", async () => {
    const old = deferred<Response>();
    const writing = deferred<Response>();
    const fetchImpl = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(writing.promise);
    const { api } = subject(fetchImpl);
    const loading = api.load();
    const saving = api.save({ "admin.username": "saved" });
    expect(await api.load()).toBe(false);
    writing.resolve(Response.json({ ...payload("saved"), updated: ["admin.username"], restartRequired: ["key"] }));
    expect(await saving).toEqual([]);
    old.resolve(Response.json(payload("old")));
    await loading;
    expect(api.admin.value.username).toBe("saved");
    expect(api.restartRequired.value).toEqual(["key"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("serializes writes without aborting the pending save", async () => {
    const writing = deferred<Response>();
    const fetchImpl = vi.fn().mockReturnValue(writing.promise);
    const { api } = subject(fetchImpl);
    const pending = api.save({ a: true });
    expect(await api.save({ b: true })).toEqual([{ key: "b", error: "request_pending" }]);
    expect(await api.changePassword("old", "new")).toBe("request_pending");
    expect(fetchImpl.mock.calls[0]![1].signal.aborted).toBe(false);
    writing.resolve(Response.json({ ...payload(), updated: ["a"] }));
    await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps a 90 second deadline for runtime configuration application", async () => {
    vi.useFakeTimers();
    const { api } = subject(vi.fn(() => new Promise<Response>(() => {})) as typeof fetch);
    const pending = api.save({ a: true });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(api.saving.value).toBe(true);
    await vi.advanceTimersByTimeAsync(75_000);
    expect(await pending).toEqual([{ key: "a", error: "request_failed" }]);
    expect(api.saving.value).toBe(false);
  });

  it("retains password error codes and bounds stalled error bodies", async () => {
    vi.useFakeTimers();
    const response = Response.json({}, { status: 403 });
    vi.spyOn(response, "json").mockReturnValue(new Promise(() => {}));
    const { api } = subject(
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ error: "invalid_current_password" }, { status: 403 }))
        .mockResolvedValue(response),
    );
    expect(await api.changePassword("old", "new")).toBe("invalid_current_password");
    expect(api.error.value).toBe("当前口令不正确。");
    const pending = api.changePassword("old", "new");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toBe("Request aborted");
    expect(api.saving.value).toBe(false);
  });
});
