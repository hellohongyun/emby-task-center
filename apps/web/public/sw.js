/* Service worker: precache the app shell（含当前构建的带哈希静态资源），
   并在运行时后台更新静态缓存。API/认证请求一律走网络，不缓存。
   部署更新后，下次访问拉取新 index.html，从而引用新的带哈希资源。 */
// 修改静态资源（图标/字体/海报等）时必须递增 VERSION，否则已安装客户端会继续用旧缓存
const VERSION = "v5";
const SHELL_CACHE = `emby-task-center-shell-${VERSION}`;
const ASSET_CACHE = `emby-task-center-assets-${VERSION}`;
const SHELL_URLS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/logo.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
];

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  const urls = [...SHELL_URLS];
  try {
    const response = await fetch("/index.html");
    const html = await response.text();
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const url = match[1];
      if (url.startsWith("/assets/") && !urls.includes(url)) urls.push(url);
    }
  } catch {
    /* 预缓存失败不阻塞安装 */
  }
  await cache.addAll(urls);
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("emby-task-center-") && key !== SHELL_CACHE && key !== ASSET_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // 页面导航：网络优先，失败时回退到缓存的壳。
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put("/index.html", copy));
          return response;
        })
        .catch(() => caches.match("/index.html").then((cached) => cached || caches.match("/"))),
    );
    return;
  }

  // 静态资源：按 URL 匹配缓存（兼容浏览器不同请求模式），命中直接返回，否则走网络并后台缓存。
  event.respondWith(
    caches.match(url.href).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(ASSET_CACHE).then((cache) => cache.put(url.href, copy));
          }
          return response;
        })
        .catch(() => cached);
    }),
  );
});
