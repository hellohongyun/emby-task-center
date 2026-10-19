import { fireEvent, render, screen, waitFor } from "@testing-library/vue";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VirtualLibrary } from "@emby-task-center/contracts/virtual-library";
import VirtualLibraryPoster from "./VirtualLibraryPoster.vue";

const library: VirtualLibrary = {
  id: "one",
  name: "精选",
  collectionType: "mixed",
  sortOrder: 0,
  itemCount: 1,
  createdAt: "",
  updatedAt: "",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const revoke = vi.fn();
beforeEach(() => {
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: revoke }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
function setup(value = library) {
  const requireAuth = vi.fn();
  const view = render(VirtualLibraryPoster, { props: { library: value, requireAuth } });
  const select = (file: File) =>
    fireEvent.change(screen.getByLabelText(/选择图片|更换图片/), { target: { files: [file] } });
  return { ...view, select, requireAuth };
}

it("previews a valid image and uploads raw bytes only after explicit save", async () => {
  const fetch = vi.fn(async () => json({ library: { ...library, posterImageTag: "new" } }));
  vi.stubGlobal("fetch", fetch);
  const view = setup();
  const file = new File(["image"], "封面.png", { type: "image/png" });
  await view.select(file);
  expect(screen.getByRole("img")).toHaveAttribute("src", "blob:preview");
  expect(fetch).not.toHaveBeenCalled();
  await fireEvent.click(screen.getByRole("button", { name: "保存海报" }));
  await waitFor(() =>
    expect(view.emitted().saved).toEqual([[expect.objectContaining({ id: "one", posterImageTag: "new" })]]),
  );
  expect(fetch).toHaveBeenCalledWith(
    "/api/virtual-libraries/one/poster",
    expect.objectContaining({
      method: "PUT",
      body: file,
      credentials: "include",
      headers: { "Content-Type": "image/png" },
    }),
  );
  expect(revoke).toHaveBeenCalledWith("blob:preview");
});

it.each([
  [new File(["gif"], "cover.gif", { type: "image/gif" }), "请选择 JPEG、PNG 或 WebP 图片"],
  [
    new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }),
    "图片大小需大于 0 且不超过 5 MB",
  ],
  [new File([], "empty.png", { type: "image/png" }), "图片大小需大于 0 且不超过 5 MB"],
])("rejects invalid images without requesting the API", async (file, message) => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const view = setup();
  await view.select(file);
  expect(screen.getByRole("alert")).toHaveTextContent(message);
  expect(screen.getByRole("button", { name: "保存海报" })).toBeDisabled();
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps a selected file available after an upload error", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ message: "图片无法解码" }, 400)),
  );
  const view = setup();
  await view.select(new File(["image"], "cover.webp", { type: "image/webp" }));
  await fireEvent.click(screen.getByRole("button", { name: "保存海报" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("图片无法解码");
  expect(screen.getByRole("button", { name: "保存海报" })).toBeEnabled();
  expect(view.emitted().saved).toBeUndefined();
});

it("removes only the selected library poster", async () => {
  const fetch = vi.fn(async () => json({ library }));
  vi.stubGlobal("fetch", fetch);
  const view = setup({ ...library, posterImageTag: "cover tag" });
  expect(screen.getByRole("img")).toHaveAttribute("src", "/api/virtual-libraries/one/poster?tag=cover%20tag");
  await fireEvent.click(screen.getByRole("button", { name: "移除自定义海报" }));
  await waitFor(() => expect(view.emitted().saved).toEqual([[library]]));
  expect(fetch).toHaveBeenCalledWith(
    "/api/virtual-libraries/one/poster",
    expect.objectContaining({ method: "DELETE" }),
  );
});

it("does not apply a previous library upload response after the selection changes", async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const view = setup();
  await view.select(new File(["image"], "cover.jpg", { type: "image/jpeg" }));
  await fireEvent.click(screen.getByRole("button", { name: "保存海报" }));
  await view.rerender({ library: { ...library, id: "two", name: "另一个库" } });
  finish(json({ library: { ...library, posterImageTag: "old-library" } }));
  await waitFor(() => expect(screen.getByRole("button", { name: "保存海报" })).toBeDisabled());
  expect(view.emitted().saved).toBeUndefined();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});

it("requests login again for an expired admin session", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({}, 401)),
  );
  const view = setup();
  await view.select(new File(["image"], "cover.png", { type: "image/png" }));
  await fireEvent.click(screen.getByRole("button", { name: "保存海报" }));
  await waitFor(() => expect(view.requireAuth).toHaveBeenCalledOnce());
  expect(view.emitted().saved).toBeUndefined();
});
