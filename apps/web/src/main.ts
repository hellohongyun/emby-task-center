import { createApp } from "vue";

import App from "./App.vue";
import { installFetchLogging } from "./logging";
import { createAppRouter } from "./router";
import "./styles.css";

installFetchLogging();

// 生产环境注册 Service Worker，支持 PWA 安装与离线壳加载（安卓浏览器可「安装应用」）。
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* 注册失败不阻塞正常使用 */
    });
  });
}

// P4：视图由 URL 决定。
// 注意顺序：必须先 app.use(router) 触发初始导航，isReady() 才会 resolve——
// 反过来（先 isReady 再 use）会让 Promise 永不兑现，页面直接空白。
const router = createAppRouter();
const app = createApp(App).use(router);
void router.isReady().then(() => app.mount("#app"));
