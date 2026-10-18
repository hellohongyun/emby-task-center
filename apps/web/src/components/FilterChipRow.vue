<script setup lang="ts">
import { ref } from "vue";

import type { FilterOption } from "../types";

export type { FilterOption };

const props = withDefaults(
  defineProps<{
    options: FilterOption[];
    modelValue: string;
    allLabel: string;
    scrollable?: boolean;
    showAll?: boolean;
  }>(),
  { scrollable: false, showAll: true },
);
const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const rowEl = ref<HTMLElement | null>(null);
let drag = { active: false, startX: 0, startScroll: 0, moved: false };

/** 鼠标滚轮 → 横向滑动；支持按住拖拽滑动。 */
function onWheel(event: WheelEvent) {
  const el = rowEl.value;
  if (!el) return;
  if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) el.scrollLeft += event.deltaY;
  else el.scrollLeft += event.deltaX;
}
function onPointerDown(event: PointerEvent) {
  const el = rowEl.value;
  if (!el || !props.scrollable || event.button !== 0 || event.pointerType === "touch") return;
  drag = { active: true, startX: event.clientX, startScroll: el.scrollLeft, moved: false };
}
function onPointerMove(event: PointerEvent) {
  const el = rowEl.value;
  if (!el || !drag.active) return;
  const dx = event.clientX - drag.startX;
  if (Math.abs(dx) > 3) drag.moved = true;
  el.scrollLeft = drag.startScroll - dx;
}
function endDrag() {
  drag.active = false;
}

function select(value: string) {
  if (drag.moved) {
    drag.moved = false;
    return;
  }
  // 再次点击已选中的选项 → 取消选择，回到“全部”。
  if (props.showAll && props.modelValue === value) {
    emit("update:modelValue", "all");
    return;
  }
  emit("update:modelValue", value);
}
</script>

<template>
  <div
    ref="rowEl"
    class="chip-row"
    :class="{ scroll: props.scrollable }"
    @wheel="onWheel"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="endDrag"
    @pointercancel="endDrag"
    @pointerleave="endDrag"
  >
    <button v-if="props.showAll" type="button" :class="{ active: modelValue === 'all' }" @click="select('all')">
      {{ allLabel }}
    </button>
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      :class="{ active: modelValue === option.value }"
      @click="select(option.value)"
    >
      {{ option.label }}
    </button>
  </div>
</template>

<style scoped>
.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip-row.scroll {
  flex-wrap: nowrap;
  overflow-x: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  touch-action: pan-x;
  scrollbar-width: none;
}
.chip-row.scroll::-webkit-scrollbar {
  display: none;
}
.chip-row button {
  flex: none;
  min-height: 30px;
  padding: 0 11px;
  border: 1px solid #22343e;
  border-radius: 999px;
  color: #9aa6ae;
  background: #0d1921;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
.chip-row button.active {
  border-color: #4d9b51;
  color: #83d486;
  background: #12241c;
}
@media (max-width: 1024px) {
  .chip-row button {
    min-height: 44px;
    padding: 0 12px;
  }
  .chip-row.scroll {
    overscroll-behavior: auto;
    touch-action: auto;
  }
}
</style>
