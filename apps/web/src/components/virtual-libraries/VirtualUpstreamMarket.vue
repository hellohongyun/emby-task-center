<script setup lang="ts">
import { computed, ref } from "vue";
import type { UpstreamMarketCatalog, UpstreamMarketLibrary } from "@emby-task-center/contracts/virtual-library-market";
import { virtualLibraryRequests } from "../../composables/virtual-library-requests";
import VirtualLibraryCover from "./VirtualLibraryCover.vue";

const props = defineProps<{ requireAuth: () => void; disabled?: boolean }>();
const emit = defineEmits<{ changed: [] }>();
const { run, error } = virtualLibraryRequests(props.requireAuth, "/api/virtual-library-market/upstream");
const expanded = ref(false);
const ready = ref(false);
const busy = ref(false);
const action = ref("");
const notice = ref("");
const selected = ref<string[]>([]);
const catalog = ref<UpstreamMarketCatalog>({ configured: false, libraries: [], candidates: [], lastSyncedAt: null });
const candidates = computed(() => catalog.value.candidates.filter((item) => !item.imported));
const locked = computed(() => busy.value || props.disabled);
const synced = computed(() => {
  if (!catalog.value.lastSyncedAt) return "尚未同步";
  const date = new Date(catalog.value.lastSyncedAt);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { hour12: false });
});
function apply(value: UpstreamMarketCatalog) {
  catalog.value = value;
  ready.value = true;
  const ids = new Set(candidates.value.map((item) => item.sourceId));
  selected.value = selected.value.filter((id) => ids.has(id));
}
async function load() {
  const result = await run<UpstreamMarketCatalog>("catalog", busy, "");
  if (result) apply(result);
}
async function expand() {
  expanded.value = !expanded.value;
  if (expanded.value && !ready.value && !busy.value) await load();
}
async function sync() {
  if (locked.value) return;
  notice.value = "";
  action.value = "sync";
  const result = await run<UpstreamMarketCatalog>("catalog", busy, "/sync", { method: "POST" }, { timeoutMs: 120_000 });
  if (result) {
    apply(result);
    notice.value = result.error ? "同步未完成，请检查提示后重试。" : "来源列表已同步，选择要接入市场的虚拟库。";
    emit("changed");
  }
  action.value = "";
}
async function importSelected() {
  if (locked.value || !selected.value.length) return;
  notice.value = "";
  action.value = "import";
  const count = selected.value.length;
  const result = await run<UpstreamMarketCatalog>(
    "catalog",
    busy,
    "/import",
    {
      method: "POST",
      body: JSON.stringify({ sourceIds: [...selected.value] }),
    },
    { timeoutMs: 120_000 },
  );
  if (result) {
    apply(result);
    notice.value = `已接入 ${count} 个虚拟库，用户现在可以在市场选择启用。`;
    emit("changed");
  }
  action.value = "";
}
async function publish(library: UpstreamMarketLibrary) {
  if (locked.value) return;
  notice.value = "";
  action.value = library.id;
  const result = await run<{ library: UpstreamMarketLibrary }>(
    "catalog",
    busy,
    `/${encodeURIComponent(library.id)}/publication`,
    {
      method: "PUT",
      body: JSON.stringify({ published: !library.published }),
    },
  );
  if (result) {
    catalog.value.libraries = catalog.value.libraries.map((item) => (item.id === library.id ? result.library : item));
    notice.value = result.library.published
      ? `「${library.name}」已上架市场。`
      : `「${library.name}」已下架，重新上架后需用户再次启用。`;
    emit("changed");
  }
  action.value = "";
}
</script>

<template>
  <section class="vm-section vm-upstream" aria-label="系统自带媒体库接入" :aria-busy="busy">
    <div class="vm-section-head">
      <div>
        <h2>系统自带媒体库接入</h2>
        <p>接入后由用户按需启用，内容、名称和海报随来源同步更新。</p>
      </div>
      <button type="button" :aria-expanded="expanded" @click="expand">
        {{ expanded ? "收起接入设置" : "管理接入" }}
      </button>
    </div>
    <div v-if="expanded" class="vm-upstream-body">
      <div class="vm-toolbar">
        <span class="vm-status" :class="ready && catalog.configured ? 'good' : 'muted'">{{
          !ready ? (busy ? "正在读取" : "状态未读取") : catalog.configured ? "已配置来源" : "来源未配置"
        }}</span>
        <span class="vm-upstream-time">上次同步：{{ synced }}</span>
        <button type="button" :disabled="locked || !ready || !catalog.configured" @click="sync">
          {{ action === "sync" ? "正在同步…" : "同步来源列表" }}
        </button>
        <button v-if="!ready || !catalog.configured" type="button" :disabled="locked" @click="load">
          重新读取配置
        </button>
      </div>
      <p v-if="error || catalog.error" class="vm-feedback error" role="alert">{{ error || catalog.error }}</p>
      <p v-if="notice" class="vm-feedback" role="status">{{ notice }}</p>
      <p v-if="catalog.initializationPending" class="vm-feedback">
        仍有 {{ catalog.initializationPending }} 个账号的初始启用待核对。再次同步可继续，不会覆盖用户已保存的开关。
      </p>
      <p v-if="ready && !catalog.configured" class="vm-feedback">
        请先检查反代上游是否填写 TgtoDrive 的 Emby 反代入口，再重新读取配置。
      </p>
      <section v-if="ready" class="vm-upstream-section" aria-label="可接入的虚拟库">
        <div class="vm-section-head">
          <div>
            <h3>待接入 {{ candidates.length }} 个</h3>
            <p>仅列出已识别的上游虚拟库，不包含 Emby 实体库。</p>
          </div>
          <div class="vm-actions">
            <button
              type="button"
              :disabled="locked || !candidates.length"
              @click="selected = candidates.map((item) => item.sourceId)"
            >
              全选待接入</button
            ><button type="button" :disabled="locked || !selected.length" @click="selected = []">清空选择</button>
          </div>
        </div>
        <p v-if="!candidates.length" class="vm-empty">
          暂无待接入虚拟库。已接入的库列在下方；如尚未发现，请检查反代上游是否填写 TgtoDrive 的 Emby
          反代入口，并同步来源列表。
        </p>
        <label v-for="item in candidates" :key="item.sourceId" class="vm-upstream-row">
          <input
            v-model="selected"
            type="checkbox"
            :value="item.sourceId"
            :aria-label="`接入 ${item.name}`"
            :disabled="locked"
          />
          <VirtualLibraryCover class="vm-upstream-thumb" :name="item.name" />
          <span class="vm-upstream-name"
            ><strong>{{ item.name }}</strong
            ><small>系统自带 · 待接入</small></span
          >
        </label>
        <div v-if="candidates.length" class="vm-actions">
          <button
            class="vm-button-primary"
            type="button"
            :disabled="locked || !selected.length"
            @click="importSelected"
          >
            {{ action === "import" ? "正在接入…" : `接入选中的 ${selected.length} 个库` }}
          </button>
        </div>
      </section>
      <section v-if="ready" class="vm-upstream-section" aria-label="已接入的虚拟库">
        <h3>已接入 {{ catalog.libraries.length }} 个</h3>
        <p v-if="!catalog.libraries.length" class="vm-empty">还没有接入系统自带媒体库。</p>
        <article
          v-for="library in catalog.libraries"
          :key="library.id"
          class="vm-upstream-row"
          :aria-label="library.name"
        >
          <VirtualLibraryCover
            class="vm-upstream-thumb"
            :name="library.name"
            :src="
              library.posterImageTag
                ? `/api/virtual-library-market/${encodeURIComponent(library.id)}/poster?tag=${encodeURIComponent(library.posterImageTag)}`
                : undefined
            "
          />
          <div class="vm-upstream-name">
            <strong>{{ library.name }}</strong
            ><span class="vm-status" :class="library.available && library.published ? 'good' : 'warn'">{{
              !library.available ? "来源不可用" : library.published ? "已上架市场" : "已下架"
            }}</span>
          </div>
          <button
            type="button"
            :disabled="locked || (!library.available && !library.published)"
            :aria-label="`${library.published ? '下架' : '上架'} ${library.name}`"
            @click="publish(library)"
          >
            {{ action === library.id ? "正在保存…" : library.published ? "下架" : "上架" }}
          </button>
        </article>
      </section>
    </div>
  </section>
</template>

<style scoped>
.vm-upstream {
  margin-bottom: 6px;
}
.vm-upstream-body,
.vm-upstream-section {
  display: grid;
  gap: 14px;
  min-width: 0;
}
.vm-upstream-section {
  border-top: 1px solid var(--line);
  padding-top: 18px;
}
.vm-upstream-time,
.vm-upstream-name small {
  color: var(--text-dim);
  font-size: 12px;
}
.vm-upstream-row {
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px;
  min-width: 0;
}
.vm-upstream-name {
  display: grid;
  gap: 6px;
  min-width: 0;
  flex: 1;
  overflow-wrap: anywhere;
}
.vm-upstream-thumb {
  width: 88px;
  flex: 0 0 auto;
}
.vm-upstream-row button {
  flex: 0 0 auto;
}
@media (max-width: 600px) {
  .vm-upstream .vm-section-head {
    flex-wrap: wrap;
  }
  .vm-upstream-thumb {
    width: 64px;
  }
  .vm-upstream-row {
    gap: 8px;
    padding: 10px;
  }
  .vm-upstream-row button {
    padding-inline: 9px;
  }
}
</style>
