import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { compressPoster } from "./compress-poster";

let image: { naturalWidth: number; naturalHeight: number; onload: (() => void) | null; onerror: (() => void) | null };
const draw = vi.fn();
const revoke = vi.fn();
let encode: MockInstance<HTMLCanvasElement["toBlob"]>;
function captureImage(value: typeof image) {
  image = value;
}
beforeEach(() => {
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:source"), revokeObjectURL: revoke }));
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 3200;
      naturalHeight = 1600;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        captureImage(this);
      }
      set src(value: string) {
        if (value) queueMicrotask(() => this.onload?.());
      }
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: draw,
  } as unknown as CanvasRenderingContext2D);
  encode = vi
    .spyOn(HTMLCanvasElement.prototype, "toBlob")
    .mockImplementation((callback) => callback(new Blob(["small"], { type: "image/webp" })));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const input = () => new File([new Uint8Array(1024)], "封面.png", { type: "image/png" });

it("resizes proportionally, uses WebP quality .82 and releases source resources", async () => {
  const result = await compressPoster(input());
  expect(result.type).toBe("image/webp");
  expect(result.name).toBe("封面.webp");
  expect(result.size).toBe(5);
  expect(draw).toHaveBeenCalledWith(image, 0, 0, 1600, 800);
  expect(encode).toHaveBeenCalledWith(expect.any(Function), "image/webp", 0.82);
  expect(revoke).toHaveBeenCalledWith("blob:source");
});

it("does not upscale and retains original when encoding would grow the file", async () => {
  encode.mockImplementation((callback: BlobCallback) => {
    callback(new Blob([new Uint8Array(2048)], { type: "image/webp" }));
  });
  const file = input();
  const pending = compressPoster(file);
  image.naturalWidth = 100;
  image.naturalHeight = 200;
  expect(await pending).toBe(file);
  expect(draw).toHaveBeenCalledWith(image, 0, 0, 100, 200);
});

it("accepts the browser's transparent PNG fallback", async () => {
  encode.mockImplementation((callback: BlobCallback) => callback(new Blob(["png"], { type: "image/png" })));
  expect((await compressPoster(input())).type).toBe("image/png");
});

it("rejects corrupt image decode and still releases the object URL", async () => {
  const pending = compressPoster(input());
  image.onerror?.();
  await expect(pending).rejects.toThrow("图片无法解码");
  expect(encode).not.toHaveBeenCalled();
  expect(revoke).toHaveBeenCalledWith("blob:source");
});

it("rejects oversized source dimensions before allocating a canvas", async () => {
  const pending = compressPoster(input());
  image.naturalWidth = 20000;
  await expect(pending).rejects.toThrow("图片尺寸无效或过大");
  expect(draw).not.toHaveBeenCalled();
});

it("cancels while encoding and ignores a late callback", async () => {
  let finish!: BlobCallback;
  encode.mockImplementation((callback: BlobCallback) => {
    finish = callback;
  });
  const controller = new AbortController();
  const pending = compressPoster(input(), controller.signal);
  await vi.waitFor(() => expect(encode).toHaveBeenCalled());
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  finish(new Blob(["late"], { type: "image/webp" }));
  expect(revoke).toHaveBeenCalledWith("blob:source");
});

it("clears timers and abort listeners when the encoder throws synchronously", async () => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    encode.mockImplementation(() => {
      throw new Error("canvas failure");
    });
    const pending = compressPoster(input(), controller.signal);
    image.onload?.();
    await expect(pending).rejects.toThrow("图片压缩失败");
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(revoke).toHaveBeenCalledWith("blob:source");
  } finally {
    vi.useRealTimers();
  }
});
