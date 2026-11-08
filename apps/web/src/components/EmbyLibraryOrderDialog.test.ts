import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EmbyLibraryOrderDialog from "./EmbyLibraryOrderDialog.vue";

const base = "/api/emby/library-order";
const source = { id: "admin", name: "样板管理员" };
const user = { id: "member", name: "会员 A" };
const preview = {
  previewToken: "preview-1",
  source,
  libraries: ["电影", "剧集"],
  users: [{ ...user, status: "change", before: ["剧集", "电影"], after: ["电影", "剧集"] }],
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function stub(fetchImpl: typeof fetch) {
  const mock = vi.fn(fetchImpl);
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => {
  // jsdom exposes HTMLDialogElement without implementing its modal methods.
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = true;
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = false;
      },
    },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  vi.unstubAllGlobals();
});

describe("EmbyLibraryOrderDialog", () => {
  it("previews the ordering, then submits once after the administrator confirms", async () => {
    let finish!: (value: Response) => void;
    const fetchMock = stub(async (input) => {
      if (input === base) return json({ admins: [source] });
      if (input === `${base}/preview`) return json(preview);
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    });
    const view = render(EmbyLibraryOrderDialog, { props: { requireAuth: vi.fn() } });
    const dialog = screen.getByRole("dialog", { name: "统一媒体库顺序" });
    await fireEvent.click(await within(dialog).findByRole("button", { name: "预览顺序" }));
    const confirm = await within(dialog).findByRole("button", { name: "确认同步 1 个账号" });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([base, `${base}/preview`]);
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({ sourceUserId: source.id });
    expect(within(dialog).getByText("同步前")).toBeInTheDocument();
    expect(within(dialog).getByText("同步后")).toBeInTheDocument();
    await fireEvent.click(confirm);
    await fireEvent.click(confirm);
    expect(confirm).toBeDisabled();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([base, `${base}/preview`, `${base}/apply`]);
    expect(JSON.parse(fetchMock.mock.calls[2]![1]!.body as string)).toEqual({ previewToken: preview.previewToken });
    await fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(view.emitted("close")).toBeUndefined();
    finish(json({ users: [{ ...user, status: "updated" }] }));
    await waitFor(() => expect(within(dialog).getByText("已同步 1")).toBeInTheDocument());
    expect(within(dialog).getByRole("heading", { name: "同步结果" })).toHaveFocus();
    await fireEvent.click(within(dialog).getByRole("button", { name: "完成" }));
    expect(view.emitted("close")).toHaveLength(1);
  });

  it("requires a new preview after expiration and clears the old preview on source changes", async () => {
    const alternate = { id: "admin2", name: "另一位管理员" };
    const fetchMock = stub(async (input) => {
      if (input === base) return json({ admins: [source, alternate] });
      if (input === `${base}/preview`) return json(preview);
      return json({ error: "library_order_preview_expired" }, 409);
    });
    render(EmbyLibraryOrderDialog, { props: { requireAuth: vi.fn() } });
    const select = await screen.findByRole("combobox", { name: "排序样板" });
    expect(screen.getByRole("button", { name: "预览顺序" })).toBeDisabled();
    await fireEvent.update(select, source.id);
    await fireEvent.click(screen.getByRole("button", { name: "预览顺序" }));
    await fireEvent.click(await screen.findByRole("button", { name: "确认同步 1 个账号" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("预览已失效，请重新预览");
    expect(screen.queryByRole("button", { name: /确认同步/ })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "预览顺序" }));
    await screen.findByRole("button", { name: "确认同步 1 个账号" });
    await fireEvent.update(select, alternate.id);
    expect(screen.queryByRole("button", { name: /确认同步/ })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => url === `${base}/apply`)).toHaveLength(1);
  });
});
