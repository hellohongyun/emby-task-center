<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import { mdiCalendarMonth, mdiChevronLeft, mdiChevronRight, mdiClose } from "@mdi/js";
import { computed, onBeforeUnmount, ref, watch } from "vue";

/**
 * 到期日选择器（自定义卡密用）。
 *
 * 为什么自绘而不是 `<input type="date">`：原生控件在暗色面板里是浏览器自己的一套观感，
 * 与整站格格不入；而这个组件的核心信息也不只是"选一天"——管理员真正要判断的是
 * **"离今天还有多少天、这张卡什么时候没人要"**，所以选中后立刻把天数摆出来。
 *
 * 口径：选中的日期在服务端会被归一到当日 23:59:59.999（"10 月 8 日到期"= 8 号这天还能看），
 * 这里只负责把 `YYYY-MM-DD` 交给上层，不做时间部分。
 */
const props = defineProps<{ modelValue: string; disabled?: boolean }>();
const emit = defineEmits<{ (event: "update:modelValue", value: string): void }>();

const open = ref(false);
/** 当前翻到哪个月（只看展示，与选中值解耦）。 */
const viewMonth = ref(startOfMonth(parseKey(props.modelValue) ?? new Date()));
const root = ref<HTMLElement | null>(null);

function parseKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim());
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}
function toKey(date: Date): string {
  const pad = (count: number) => String(count).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

const selected = computed(() => parseKey(props.modelValue));
/** 距今天还有几天（今天=0，明天=1）；未选日期时为 null。 */
const daysAhead = computed(() => {
  const target = selected.value;
  if (!target) return null;
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((target.getTime() - start.getTime()) / 86_400_000);
});
const selectedLabel = computed(() => {
  const days = daysAhead.value;
  if (!selected.value || days === null) return "";
  if (days === 0) return "今天到期";
  if (days === 1) return "明天到期";
  if (days < 0) return `已经过期 ${Math.abs(days)} 天`;
  return `距今 ${days} 天`;
});

const monthLabel = computed(() => `${viewMonth.value.getFullYear()} 年 ${viewMonth.value.getMonth() + 1} 月`);

/** 42 格（6 周 × 7 天）：固定行数，翻月时高度不跳。 */
const grid = computed(() => {
  const first = startOfMonth(viewMonth.value);
  // 周一为一周之首（中文习惯），getDay() 里 0=周日
  const offset = (first.getDay() + 6) % 7;
  const cells: Array<{ key: string; day: number; inMonth: boolean; isToday: boolean }> = [];
  const todayKey = toKey(new Date());
  for (let index = 0; index < 42; index++) {
    const date = new Date(first.getFullYear(), first.getMonth(), 1 - offset + index);
    const key = toKey(date);
    cells.push({
      key,
      day: date.getDate(),
      inMonth: date.getMonth() === first.getMonth(),
      isToday: key === todayKey,
    });
  }
  return cells;
});

const QUICK = [
  { days: 10, label: "10 天" },
  { days: 30, label: "1 个月" },
  { days: 90, label: "3 个月" },
  { days: 180, label: "半年" },
  { days: 365, label: "1 年" },
];

function addDays(days: number): string {
  const today = new Date();
  return toKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() + days));
}

function pick(key: string) {
  emit("update:modelValue", key);
  open.value = false;
}

function shiftMonth(delta: number) {
  viewMonth.value = new Date(viewMonth.value.getFullYear(), viewMonth.value.getMonth() + delta, 1);
}

function toggle() {
  // 显式挡住禁用态：原生 disabled 只在真实点击路径上生效，脚本派发的事件会绕过去
  if (props.disabled) return;
  open.value = !open.value;
}

function onDocumentClick(event: MouseEvent) {
  if (!open.value) return;
  if (root.value && !root.value.contains(event.target as Node)) open.value = false;
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") open.value = false;
}

watch(open, (value) => {
  if (value) {
    // 打开时把视图拉到当前选中值所在月份，管理员不用手动翻回去
    viewMonth.value = startOfMonth(selected.value ?? new Date());
    document.addEventListener("mousedown", onDocumentClick);
    document.addEventListener("keydown", onKeydown);
  } else {
    document.removeEventListener("mousedown", onDocumentClick);
    document.removeEventListener("keydown", onKeydown);
  }
});
onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocumentClick);
  document.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <div ref="root" class="expiry-picker">
    <button
      type="button"
      class="picker-trigger"
      :disabled="disabled"
      :aria-expanded="open"
      aria-haspopup="dialog"
      @click="toggle"
    >
      <SvgIcon type="mdi" :path="mdiCalendarMonth" :size="15" aria-hidden="true" />
      <span :class="{ placeholder: !modelValue }">{{ modelValue || "选择到期日期" }}</span>
      <em v-if="selectedLabel" :class="{ warning: (daysAhead ?? 0) < 0 }">{{ selectedLabel }}</em>
    </button>

    <div v-if="open" class="picker-pop" role="dialog" aria-label="选择到期日期">
      <div class="quick">
        <button
          v-for="item in QUICK"
          :key="item.days"
          type="button"
          class="quick-btn"
          @click="pick(addDays(item.days))"
        >
          {{ item.label }}
        </button>
        <button type="button" class="quick-close" title="关闭" @click="open = false">
          <SvgIcon type="mdi" :path="mdiClose" :size="14" />
        </button>
      </div>

      <div class="month-head">
        <button type="button" title="上一个月" @click="shiftMonth(-1)">
          <SvgIcon type="mdi" :path="mdiChevronLeft" :size="16" />
        </button>
        <span>{{ monthLabel }}</span>
        <button type="button" title="下一个月" @click="shiftMonth(1)">
          <SvgIcon type="mdi" :path="mdiChevronRight" :size="16" />
        </button>
      </div>

      <div class="weekdays" aria-hidden="true">
        <span v-for="label in ['一', '二', '三', '四', '五', '六', '日']" :key="label">{{ label }}</span>
      </div>

      <div class="days">
        <button
          v-for="cell in grid"
          :key="cell.key"
          type="button"
          class="day"
          :class="{ outside: !cell.inMonth, today: cell.isToday, picked: cell.key === modelValue }"
          @click="pick(cell.key)"
        >
          {{ cell.day }}
        </button>
      </div>

      <p class="footnote">到期日按当天 23:59 计 —— 选 10 月 8 日，用户 8 号这天还能看。</p>
    </div>
  </div>
</template>

<style scoped>
.expiry-picker {
  position: relative;
}
.picker-trigger {
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 0 11px;
  border: 1px solid #283b47;
  border-radius: 9px;
  color: #eef2f4;
  background: #0e1a23;
  font-size: 13px;
  cursor: pointer;
}
.picker-trigger:hover:not(:disabled) {
  border-color: #3f5a6b;
}
.picker-trigger .placeholder {
  color: #63727d;
}
.picker-trigger em {
  font-style: normal;
  color: #7fd08a;
  font-size: 11px;
}
.picker-trigger em.warning {
  color: #f0b7b7;
}

.picker-pop {
  position: absolute;
  z-index: 30;
  top: calc(100% + 6px);
  left: 0;
  width: 268px;
  padding: 12px;
  border: 1px solid #2a3c46;
  border-radius: 12px;
  background: #0c171f;
  box-shadow: 0 18px 40px rgb(0 0 0 / 45%);
}
.quick {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 10px;
}
.quick-btn {
  flex: 1;
  min-height: 28px;
  border: 1px solid #2a3c46;
  border-radius: 7px;
  color: #c9d3da;
  background: #101d25;
  font-size: 11px;
  cursor: pointer;
}
.quick-btn:hover {
  border-color: #5aa95a;
  color: #eef2f4;
}
.quick-close {
  width: 28px;
  min-height: 28px;
  display: grid;
  place-items: center;
  border: 1px solid #2a3c46;
  border-radius: 7px;
  color: #8a97a1;
  background: #101d25;
  cursor: pointer;
}
.month-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #eef2f4;
  font-size: 12.5px;
  font-weight: 700;
  margin-bottom: 6px;
}
.month-head button {
  width: 26px;
  min-height: 26px;
  display: grid;
  place-items: center;
  border: 1px solid #2a3c46;
  border-radius: 7px;
  color: #c9d3da;
  background: #101d25;
  cursor: pointer;
}
.month-head button:hover {
  border-color: #3f5a6b;
}
.weekdays,
.days {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}
.weekdays span {
  text-align: center;
  color: #63727d;
  font-size: 10.5px;
  padding: 3px 0;
}
.day {
  min-height: 30px;
  border: 1px solid transparent;
  border-radius: 7px;
  color: #dbe3e8;
  background: transparent;
  font-size: 12px;
  cursor: pointer;
}
.day:hover {
  border-color: #3f5a6b;
  background: #101d25;
}
.day.outside {
  color: #4d5a63;
}
.day.today {
  border-color: #2a3c46;
  color: #8fb7e8;
}
.day.picked {
  border-color: #5aa95a;
  color: #07120d;
  background: linear-gradient(180deg, #74c574, #5aa95a);
  font-weight: 760;
}
.footnote {
  margin: 9px 0 0;
  color: #63727d;
  font-size: 10.5px;
  line-height: 1.5;
}
</style>
<style scoped src="./CardExpiryCalendar.mobile.css"></style>
