const MAX_EDGE = 1600;

/** Canvas works on HTTP deployments and preserves transparency when encoding WebP/PNG. */
export async function compressPoster(file: File, signal?: AbortSignal): Promise<File> {
  const image = new Image();
  const source = URL.createObjectURL(file);
  const canceled = () => new DOMException("图片处理已取消", "AbortError");
  let canvas: HTMLCanvasElement | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        image.onload = null;
        image.onerror = null;
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(canceled());
      const timer = setTimeout(() => finish(new Error("图片处理超时，请重新选择图片。")), 30_000);
      image.onload = () => finish();
      image.onerror = () => finish(new Error("图片无法解码，请重新选择有效图片。"));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else image.src = source;
    });
    if (signal?.aborted) throw canceled();
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height || width > 16384 || height > 16384 || width * height > 100_000_000)
      throw new Error("图片尺寸无效或过大，请选择其他图片。");
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器暂不支持图片压缩，请更换浏览器后重试。");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      const finish = (blob: Blob | null, error?: Error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else if (blob?.size) resolve(blob);
        else reject(new Error("图片压缩失败，请重新选择图片。"));
      };
      const abort = () => finish(null, canceled());
      const timer = setTimeout(() => finish(null, new Error("图片压缩超时，请重新选择图片。")), 30_000);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else {
        try {
          canvas!.toBlob((blob) => finish(blob), "image/webp", 0.82);
        } catch {
          finish(null, new Error("图片压缩失败，请重新选择图片。"));
        }
      }
    });
    if (signal?.aborted) throw canceled();
    if (!["image/webp", "image/png"].includes(blob.type))
      throw new Error("浏览器无法生成有效海报，请更换浏览器后重试。");
    if (blob.size >= file.size) return file;
    const extension = blob.type === "image/webp" ? "webp" : "png";
    return new File([blob], `${file.name.replace(/\.[^.]*$/, "")}.${extension}`, { type: blob.type });
  } finally {
    image.src = "";
    URL.revokeObjectURL(source);
    if (canvas) canvas.width = canvas.height = 0;
  }
}
