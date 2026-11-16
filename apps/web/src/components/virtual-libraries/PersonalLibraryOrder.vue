<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import type { LibraryOrderItem, LibraryOrderView } from "@emby-task-center/contracts/virtual-library-market";
import { virtualLibraryRequests } from "../../composables/virtual-library-requests";
import VirtualLibraryCover from "./VirtualLibraryCover.vue";
const props = defineProps<{ personal?: boolean; defaults?: boolean; requireAuth: () => void }>();
const emit = defineEmits<{ "dirty-change": [value: boolean] }>();
const base = props.defaults
  ? "/api/virtual-library-market/order"
  : props.personal
    ? "/api/public/virtual-library-order"
    : "/api/virtual-library-order";
const { run, error } = virtualLibraryRequests(props.requireAuth, base);
function posterUrl(item: LibraryOrderItem) {
  if (!item.posterImageTag) return;
  const path = item.marketId
    ? `${props.personal ? "/api/public" : "/api"}/virtual-library-market/${encodeURIComponent(item.marketId)}`
    : `${base}/${encodeURIComponent(item.id)}`;
  return `${path}/poster?tag=${encodeURIComponent(item.posterImageTag)}`;
}
const items = ref<LibraryOrderItem[]>([]);
const order = ref<string[]>([]);
const saved = ref<string[]>([]);
const hasPersonalOrder = ref(false);
const ready = ref(false);
const busy = ref(false);
const loading = ref(false);
const notice = ref("");
const dragging = ref<string>();
const dirty = computed(() => ready.value && JSON.stringify(order.value) !== JSON.stringify(saved.value));
watch(dirty, (value) => {
  emit("dirty-change", value);
  if (value) notice.value = "";
});
onBeforeUnmount(() => emit("dirty-change", false));
function apply(result: LibraryOrderView) {
  items.value = result.items;
  const ids = new Set(items.value.map((item) => item.id));
  order.value = [...new Set([...result.order, ...ids])].filter((id) => ids.has(id));
  saved.value = [...order.value];
  hasPersonalOrder.value = result.hasPersonalOrder ?? !props.defaults;
  ready.value = true;
}
const rows = computed(() => order.value.map((id) => items.value.find((item) => item.id === id)!).filter(Boolean));
const counts = computed(() =>
  Object.fromEntries(
    ["native", "owned", "subscribed"].map((kind) => [kind, rows.value.filter((item) => item.kind === kind).length]),
  ),
);
const sourceLabel = computed(() =>
  props.defaults ? "管理员默认模板" : hasPersonalOrder.value ? "使用个人顺序" : "使用默认顺序",
);
async function load() {
  if (dirty.value) return;
  ready.value = false;
  const result = await run<LibraryOrderView>("order", loading, "");
  if (result) apply(result);
}
function move(id: string, target: number) {
  const index = order.value.indexOf(id);
  if (!ready.value || busy.value || loading.value || index < 0 || target < 0 || target >= order.value.length) return;
  const next = [...order.value];
  next.splice(index, 1);
  next.splice(target, 0, id);
  order.value = next;
}
function drop(target: number) {
  if (dragging.value) move(dragging.value, target);
  dragging.value = undefined;
}
async function save() {
  if (!ready.value || !dirty.value) return;
  const result = await run<LibraryOrderView>("order", busy, "", {
    method: "PUT",
    body: JSON.stringify({ order: order.value }),
  });
  if (!result) return;
  apply(result);
  notice.value = props.defaults ? "默认模板已保存，不覆盖用户个人顺序。" : "个人顺序已保存，播放器刷新后生效。";
}
async function reset() {
  if (!ready.value || busy.value) return;
  const result = await run<LibraryOrderView>("order", busy, "", { method: "DELETE" });
  if (!result) return;
  apply(result);
  notice.value = "已恢复默认，启用关系保持不变。";
}
const label = (kind: string) =>
  (({ native: "Emby 媒体库", owned: "自己创建", subscribed: "订阅媒体库" }) as Record<string, string>)[kind] ?? kind;
onMounted(load);
</script>
<template>
  <section class="vm-page" :aria-label="defaults ? '默认媒体库顺序' : '我的媒体库顺序'" :aria-busy="busy || loading">
    <header class="vm-heading">
      <div>
        <h1>{{ defaults ? "默认媒体库顺序" : "我的媒体库顺序" }}</h1>
        <p>
          {{
            defaults
              ? "设置新用户及恢复默认时使用的模板，不覆盖用户已保存的个人顺序。"
              : "这里的编号就是播放器的显示顺序。拖动或使用上下移动按钮，私人库也可以自由移动。"
          }}
        </p>
      </div>
      <button type="button" :disabled="busy || loading || dirty" @click="load">刷新</button>
    </header>
    <div class="vm-summary" aria-label="当前可见媒体库">
      <div class="vm-summary-item">
        <strong>{{ ready ? rows.length : "—" }}</strong
        ><span>当前显示</span>
      </div>
      <div v-for="kind in ['native', 'owned', 'subscribed']" :key="kind" class="vm-summary-item">
        <strong>{{ ready ? counts[kind] : "—" }}</strong
        ><span>{{ label(kind) }}</span>
      </div>
    </div>
    <div class="vm-toolbar">
      <span class="vm-status" :class="ready ? 'good' : 'muted'">{{ ready ? sourceLabel : "正在读取顺序" }}</span
      ><span v-if="dirty" class="vm-status warn">有未保存的更改</span>
    </div>
    <p v-if="error" class="vl-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="vm-feedback" role="status">{{ notice }}</p>
    <p v-if="loading" class="vm-empty" role="status">正在读取顺序…</p>
    <div v-else-if="ready && !rows.length" class="vm-empty">
      <strong>暂无可排列的媒体库</strong>
      <p>先创建自己的库，或在市场启用一个库，再来调整顺序。</p>
    </div>
    <ol class="vm-order" aria-label="媒体库显示顺序">
      <li
        v-for="(item, index) in rows"
        :key="item.id"
        :draggable="ready && !busy && !loading"
        @dragstart="dragging = item.id"
        @dragend="dragging = undefined"
        @dragover.prevent
        @drop.prevent="drop(index)"
      >
        <span class="vm-drag-handle" aria-hidden="true">⠿</span><span class="vm-order-rank">{{ index + 1 }}</span>
        <VirtualLibraryCover class="vm-order-poster" :name="item.name" :src="posterUrl(item)" />
        <div class="vm-order-name">
          <strong>{{ item.name }}</strong
          ><span class="vm-status muted">{{ label(item.kind) }}</span>
          <span v-if="item.source === 'tgtodrive'" class="vm-status muted">系统自带</span>
        </div>
        <div class="vm-actions">
          <button
            type="button"
            :disabled="index === 0 || busy || loading"
            :aria-label="`上移 ${item.name}`"
            @click="move(item.id, index - 1)"
          >
            上移</button
          ><button
            type="button"
            :disabled="index === rows.length - 1 || busy || loading"
            :aria-label="`下移 ${item.name}`"
            @click="move(item.id, index + 1)"
          >
            下移
          </button>
        </div>
      </li>
    </ol>
    <footer class="vm-savebar">
      <div>
        <span class="vm-status" :class="!ready ? 'muted' : dirty ? 'warn' : 'good'">{{
          !ready ? "尚未读取" : busy ? "正在保存…" : dirty ? "有未保存的更改" : "当前顺序已保存"
        }}</span>
        <p>
          {{
            defaults
              ? "修改此模板，不会改变用户已有的个人顺序。"
              : "只调整自己的显示位置，不改变启用关系。恢复默认也不会重新启用已关闭的库。"
          }}
        </p>
      </div>
      <div class="vm-actions">
        <button v-if="dirty" type="button" :disabled="busy" @click="order = [...saved]">撤销修改</button
        ><button v-if="!defaults" type="button" :disabled="busy || loading || !ready" @click="reset">恢复默认</button
        ><button class="vm-button-primary" type="button" :disabled="busy || loading || !ready || !dirty" @click="save">
          {{ busy ? "正在保存…" : "保存顺序" }}
        </button>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.vm-order-poster {
  width: 112px;
  flex: 0 0 auto;
}
@media (max-width: 600px) {
  .vm-order li {
    display: grid;
    grid-template-columns: 28px 76px minmax(0, 1fr);
    align-items: center;
  }
  .vm-order-poster {
    width: 76px;
  }
  .vm-order .vm-actions {
    grid-column: 2 / -1;
    justify-content: flex-end;
  }
}
</style>
