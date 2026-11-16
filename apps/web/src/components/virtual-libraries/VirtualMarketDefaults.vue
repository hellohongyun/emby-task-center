<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import type { MarketLibrary, MarketDefaults } from "@emby-task-center/contracts/virtual-library-market";
import { virtualLibraryRequests } from "../../composables/virtual-library-requests";
import VirtualLibraryCover from "./VirtualLibraryCover.vue";
const props = defineProps<{ requireAuth: () => void }>();
const emit = defineEmits<{ "dirty-change": [value: boolean] }>();
const { run, error } = virtualLibraryRequests(props.requireAuth, "/api/virtual-library-market");
const libraries = ref<MarketLibrary[]>([]);
const selected = ref<string[]>([]);
const saved = ref<string[]>([]);
const loading = ref(false);
const settingsLoading = ref(false);
const busy = ref(false);
const notice = ref("");
const ready = ref(false);
const unavailable = ref(0);
const same = (values: string[]) => JSON.stringify([...values].sort());
const dirty = computed(() => ready.value && same(selected.value) !== same(saved.value));
watch(dirty, (value) => {
  emit("dirty-change", value);
  if (value) notice.value = "";
});
onBeforeUnmount(() => emit("dirty-change", false));
async function load() {
  if (dirty.value) return;
  ready.value = false;
  const [market, defaults] = await Promise.all([
    run<{ libraries: MarketLibrary[] }>("market", loading, ""),
    run<MarketDefaults>("defaults", settingsLoading, "/defaults"),
  ]);
  if (!market || !defaults) return;
  libraries.value = market.libraries;
  const available = new Set(libraries.value.map((library) => library.id));
  selected.value = defaults.libraryIds.filter((id) => available.has(id));
  saved.value = [...selected.value];
  unavailable.value = defaults.libraryIds.length - selected.value.length;
  ready.value = true;
}
async function save() {
  if (!ready.value || (!dirty.value && !unavailable.value)) return;
  const result = await run<MarketDefaults>("defaults", busy, "/defaults", {
    method: "PATCH",
    body: JSON.stringify({ libraryIds: selected.value }),
  });
  if (!result) return;
  selected.value = result.libraryIds;
  saved.value = [...result.libraryIds];
  unavailable.value = 0;
  notice.value = `已保存 ${result.libraryIds.length} 个默认库，仅影响以后通过门户注册的新用户。`;
}
onMounted(load);
</script>
<template>
  <section class="vm-page" aria-label="新用户默认设置" :aria-busy="loading || settingsLoading || busy">
    <header class="vm-heading">
      <div>
        <h1>新用户默认启用的市场库</h1>
        <p>这里只设置新用户的初始选择。已有用户的订阅和管理员自己的播放器不受影响。</p>
      </div>
      <button type="button" :disabled="loading || settingsLoading || busy || dirty" @click="load">刷新</button>
    </header>
    <div class="vm-summary" aria-label="默认启用概况">
      <div class="vm-summary-item">
        <strong>{{ ready ? selected.length : "—" }}</strong
        ><span>新用户默认启用</span>
      </div>
      <div class="vm-summary-item">
        <strong>{{ ready ? libraries.length : "—" }}</strong
        ><span>当前可选择</span>
      </div>
    </div>
    <p v-if="error" class="vl-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="vm-feedback" role="status">{{ notice }}</p>
    <p v-if="unavailable" class="vm-feedback">
      原名单有 {{ unavailable }} 个库已下架或暂停分享，新用户会跳过它们；本次保存仅保留当前可用的选择。
    </p>
    <section class="vm-section">
      <div class="vm-section-head">
        <div>
          <h2>选择默认库</h2>
          <p>勾选后仍需保存，新用户随后可以自行关闭。</p>
        </div>
        <div class="vm-actions">
          <button
            type="button"
            :disabled="!ready || busy || selected.length === libraries.length"
            @click="selected = libraries.map((library) => library.id)"
          >
            全选
          </button>
          <button type="button" :disabled="!ready || busy || !selected.length" @click="selected = []">全部取消</button>
        </div>
      </div>
      <p v-if="loading || settingsLoading" class="vm-empty" role="status">正在读取设置…</p>
      <label
        v-for="library in libraries"
        :key="library.id"
        class="vm-default-row"
        :class="{ selected: selected.includes(library.id) }"
      >
        <input
          v-model="selected"
          type="checkbox"
          :aria-label="library.name"
          :value="library.id"
          :disabled="busy || !ready"
        />
        <VirtualLibraryCover
          class="vm-default-thumb"
          :name="library.name"
          :src="
            library.posterImageTag
              ? `/api/virtual-library-market/${encodeURIComponent(library.id)}/poster?tag=${encodeURIComponent(library.posterImageTag)}`
              : undefined
          "
        />
        <span
          ><strong>{{ library.name }}</strong
          ><small>{{ library.source === "tgtodrive" ? "系统自带" : `由${library.authorName}维护` }}</small></span
        >
        <span class="vm-status" :class="selected.includes(library.id) ? 'good' : 'muted'">{{
          selected.includes(library.id) ? "默认启用" : "默认不启用"
        }}</span>
      </label>
      <div v-if="ready && !libraries.length" class="vm-empty">
        <strong>还没有可选择的市场库</strong>
        <p>先在「我的虚拟库」上架，或等待其他作者上架。</p>
      </div>
    </section>
    <footer class="vm-savebar">
      <div>
        <span class="vm-status" :class="!ready ? 'muted' : dirty || unavailable ? 'warn' : 'good'">{{
          !ready ? "尚未读取设置" : dirty || unavailable ? "有未保存的更改" : "已保存"
        }}</span>
        <p>仅用于首次注册，不会为已有用户重新打开已关闭的库。</p>
      </div>
      <div class="vm-actions">
        <button v-if="dirty" type="button" :disabled="busy" @click="selected = [...saved]">撤销修改</button>
        <button
          type="button"
          class="vm-button-primary"
          :disabled="busy || !ready || (!dirty && !unavailable)"
          @click="save"
        >
          {{ busy ? "正在保存…" : "保存默认设置" }}
        </button>
      </div>
    </footer>
  </section>
</template>
