import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = resolve(process.cwd(), "src");
const publicDir = resolve(process.cwd(), "public");

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}
interface Manifest {
  name: string;
  short_name: string;
  start_url: string;
  display: string;
  icons: ManifestIcon[];
}

describe("PWA support", () => {
  it("serves a valid web app manifest with installable icons", () => {
    const manifest = JSON.parse(readFileSync(resolve(publicDir, "manifest.json"), "utf8")) as Manifest;

    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");

    const pngIcons = manifest.icons.filter((icon) => icon.type === "image/png");
    expect(pngIcons.some((icon) => icon.sizes === "192x192")).toBe(true);
    expect(pngIcons.some((icon) => icon.sizes === "512x512")).toBe(true);
    expect(pngIcons.some((icon) => icon.purpose === "maskable")).toBe(true);
    for (const icon of pngIcons) {
      expect(existsSync(resolve(publicDir, icon.src.replace(/^\//, ""))), `${icon.src} should exist`).toBe(true);
    }
  });

  it("ships a service worker registered in production and linked from index.html", () => {
    expect(existsSync(resolve(publicDir, "sw.js"))).toBe(true);
    const sw = readFileSync(resolve(publicDir, "sw.js"), "utf8");
    expect(sw).toContain("skipWaiting");
    expect(sw).toContain("clients.claim");
    expect(sw).toContain('"/api/"');

    const main = readFileSync(resolve(srcDir, "main.ts"), "utf8");
    expect(main).toContain('navigator.serviceWorker.register("/sw.js")');

    const html = readFileSync(resolve(publicDir, "../index.html"), "utf8");
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('href="/icons/icon-192.png"');
  });
});
