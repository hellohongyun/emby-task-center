import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/vue";
import { afterEach } from "vitest";

afterEach(() => cleanup());

/**
 * jsdom 没有布局引擎：`window.scrollTo` 存在但一调用就通过 virtualConsole 报
 * "Not implemented"，vitest 会把它算成 unhandled error —— 即使所有用例都是绿的，
 * 测试步骤也会被判失败（本轮就踩到了：含路由回顶行为的用例触发）。
 *
 * 直接覆盖 window 上的实现（vi.stubGlobal 会被 App.test 里的 unstubAllGlobals 撤掉）。
 */
Object.defineProperty(window, "scrollTo", {
  value: () => undefined,
  writable: true,
  configurable: true,
});
