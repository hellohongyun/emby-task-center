import { fireEvent, render, screen, waitFor } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import SettingsCenterView from "./SettingsCenterView.vue";

const payload = {
  groups: [
    {
      group: "email",
      label: "邮件通知",
      settings: [
        {
          key: "email.host",
          group: "email",
          label: "SMTP 服务器",
          secret: false,
          hasValue: true,
          source: "db",
          value: "initial",
        },
      ],
    },
  ],
  admin: { username: "admin", hasPassword: true, mustChangePassword: false },
  warnings: [],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SettingsCenterView request lifecycle", () => {
  it("preserves an edited draft when a refresh is cancelled by a failed save", async () => {
    const old = deferred<Response>();
    const writing = deferred<Response>();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json(payload))
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(writing.promise);
    vi.stubGlobal("fetch", fetchImpl);
    render(SettingsCenterView);
    const input = await screen.findByLabelText(/SMTP 服务器/, { selector: "input" });
    await fireEvent.update(input, "new-host");
    await fireEvent.click(screen.getByRole("button", { name: /重新读取/ }));
    await fireEvent.click(screen.getByRole("button", { name: /保存修改/ }));
    writing.resolve(Response.json({ error: "write_failed" }, { status: 500 }));
    old.resolve(Response.json(payload));
    await screen.findByText("保存失败，请稍后重试。");
    expect((input as HTMLInputElement).value).toBe("new-host");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("aborts a pending save on unmount without notifying the parent from its late response", async () => {
    const writing = deferred<Response>();
    const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json(payload)).mockReturnValueOnce(writing.promise);
    vi.stubGlobal("fetch", fetchImpl);
    const saved = vi.fn();
    const auth = vi.fn();
    const { unmount } = render(SettingsCenterView, { props: { requireAuth: auth }, attrs: { onSaved: saved } });
    const input = await screen.findByLabelText(/SMTP 服务器/, { selector: "input" });
    await fireEvent.update(input, "new-host");
    await fireEvent.click(screen.getByRole("button", { name: /保存修改/ }));
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    const signal = fetchImpl.mock.calls[1]![1].signal as AbortSignal;
    unmount();
    writing.resolve(Response.json({ ...payload, updated: ["email.host"], rejected: [] }));
    await Promise.resolve();
    await Promise.resolve();
    expect(signal.aborted).toBe(true);
    expect(saved).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
  });
});
