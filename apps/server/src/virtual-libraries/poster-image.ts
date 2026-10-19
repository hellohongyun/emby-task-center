import { createHash } from "node:crypto";

export const MAX_POSTER_BYTES = 5 * 1024 * 1024;
export class InvalidPosterError extends Error {
  constructor(message = "请选择有效的 JPEG、PNG 或 WebP 图片（最大 5 MiB）。") {
    super(message);
  }
}

function pngSize(data: Buffer): [number, number] | undefined {
  if (data.length < 45 || !data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return;
  let cursor = 8;
  let size: [number, number] | undefined;
  let imageData = false;
  while (cursor + 12 <= data.length) {
    const length = data.readUInt32BE(cursor);
    const end = cursor + 12 + length;
    if (end > data.length) return;
    const kind = data.toString("ascii", cursor + 4, cursor + 8);
    if (cursor === 8) {
      if (kind !== "IHDR" || length !== 13) return;
      size = [data.readUInt32BE(cursor + 8), data.readUInt32BE(cursor + 12)];
    }
    if (kind === "IDAT" && length > 0) imageData = true;
    if (kind === "IEND") return length === 0 && end === data.length && imageData ? size : undefined;
    cursor = end;
  }
}

function jpegSize(data: Buffer): [number, number] | undefined {
  if (data.length < 12 || data.readUInt16BE(0) !== 0xffd8 || data.readUInt16BE(data.length - 2) !== 0xffd9) return;
  let cursor = 2;
  let size: [number, number] | undefined;
  while (cursor + 4 <= data.length) {
    if (data[cursor++] !== 0xff) return;
    while (data[cursor] === 0xff) cursor++;
    if (cursor + 3 > data.length) return;
    const marker = data[cursor++];
    if (marker === 0xda) return size;
    const length = data.readUInt16BE(cursor);
    if (length < 2 || cursor + length > data.length) return;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker!)) {
      if (length < 8) return;
      size = [data.readUInt16BE(cursor + 5), data.readUInt16BE(cursor + 3)];
    }
    cursor += length;
  }
}

function webpSize(data: Buffer): [number, number] | undefined {
  if (data.length < 26 || data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WEBP") return;
  if (data.readUInt32LE(4) + 8 !== data.length) return;
  let cursor = 12;
  let size: [number, number] | undefined;
  let imageData = false;
  while (cursor + 8 <= data.length) {
    const kind = data.toString("ascii", cursor, cursor + 4);
    const length = data.readUInt32LE(cursor + 4);
    const start = cursor + 8;
    const end = start + length;
    if (end > data.length) return;
    if (kind === "VP8X" && length === 10) size = [data.readUIntLE(start + 4, 3) + 1, data.readUIntLE(start + 7, 3) + 1];
    if (
      kind === "VP8 " &&
      length >= 10 &&
      data.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))
    ) {
      imageData = true;
      size ??= [data.readUInt16LE(start + 6) & 0x3fff, data.readUInt16LE(start + 8) & 0x3fff];
    }
    if (kind === "VP8L" && length >= 5 && data[start] === 0x2f) {
      imageData = true;
      const bits = data.readUInt32LE(start + 1);
      size ??= [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
    }
    cursor = end + (length % 2);
  }
  return cursor === data.length && imageData ? size : undefined;
}

export function parsePosterImage(content: Buffer, declaredType?: string) {
  if (!Buffer.isBuffer(content) || !content.length || content.length > MAX_POSTER_BYTES) throw new InvalidPosterError();
  const formats = [
    ["image/png", pngSize],
    ["image/jpeg", jpegSize],
    ["image/webp", webpSize],
  ] as const;
  for (const [contentType, dimensions] of formats) {
    const size = dimensions(content);
    if (!size) continue;
    const [width, height] = size;
    if (!width || !height || width > 16384 || height > 16384 || width * height > 100_000_000)
      throw new InvalidPosterError("图片尺寸无效或过大。");
    if (declaredType && declaredType !== contentType) throw new InvalidPosterError("图片内容与文件类型不一致。");
    return { content, contentType, width, height, imageTag: createHash("sha256").update(content).digest("hex") };
  }
  throw new InvalidPosterError();
}
