import { onBeforeUnmount, ref, type Ref } from "vue";

/**
 * 视口判断（matchMedia）。
 *
 * 剧集追踪看板的桌面表格与移动卡片是**两套 DOM**（不是同一套换皮），所以要靠 JS 判断
 * 而不是纯 CSS 隐藏 —— 否则手机上也会存在一张溢出屏幕的表格。
 *
 * 环境没有 matchMedia（jsdom 默认没有）时按"否"处理，组件落到桌面形态。
 */
export function useMediaQuery(query: string): Ref<boolean> {
  const matches = ref(false);
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return matches;
  const list = window.matchMedia(query);
  matches.value = list.matches;
  const onChange = (event: MediaQueryListEvent) => {
    matches.value = event.matches;
  };
  list.addEventListener?.("change", onChange);
  onBeforeUnmount(() => list.removeEventListener?.("change", onChange));
  return matches;
}

/** 窄屏（移动）断点：沿用项目既有的 900px。 */
export function useIsNarrowViewport(): Ref<boolean> {
  return useMediaQuery("(max-width: 900px)");
}
