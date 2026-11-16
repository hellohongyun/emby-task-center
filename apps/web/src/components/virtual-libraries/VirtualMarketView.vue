<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { MarketLibrary } from "@emby-task-center/contracts/virtual-library-market";
import { virtualLibraryRequests } from "../../composables/virtual-library-requests";
import VirtualLibraryCover from "./VirtualLibraryCover.vue";
import VirtualUpstreamMarket from "./VirtualUpstreamMarket.vue";
const props = defineProps<{ personal?: boolean; requireAuth: () => void }>();
const base = props.personal ? "/api/public/virtual-library-market" : "/api/virtual-library-market";
const { run, error } = virtualLibraryRequests(props.requireAuth, base);
const libraries = ref<MarketLibrary[]>([]);
const pending = ref(new Set<string>());
const failures = ref<Record<string, string>>({});
const loading = ref(false);
const loadFailure = ref("");
const notice = ref("");
const search = ref("");
const filter = ref<"all" | "enabled" | "disabled">("all");
const selfOwned = (library: MarketLibrary) => library.owned || library.canSubscribe === false;
const enabledCount = computed(() => libraries.value.filter((library) => !selfOwned(library) && library.enabled).length);
const disabledCount = computed(
  () => libraries.value.filter((library) => !selfOwned(library) && !library.enabled).length,
);
const ownCount = computed(() => libraries.value.filter(selfOwned).length);
const filters = computed(() => [
  { id: "all" as const, label: "全部", count: libraries.value.length },
  { id: "enabled" as const, label: "已启用", count: enabledCount.value },
  { id: "disabled" as const, label: "未启用", count: disabledCount.value },
]);
const visible = computed(() =>
  libraries.value.filter((library) => {
    if (filter.value !== "all" && selfOwned(library)) return false;
    if ((filter.value === "enabled" && !library.enabled) || (filter.value === "disabled" && library.enabled))
      return false;
    const query = search.value.trim().toLocaleLowerCase();
    return !query || `${library.name} ${library.authorName}`.toLocaleLowerCase().includes(query);
  }),
);
async function load() {
  if (pending.value.size) return;
  notice.value = "";
  loadFailure.value = "";
  const result = await run<{ libraries: MarketLibrary[] }>("list", loading, "");
  if (result) {
    libraries.value = result.libraries;
    failures.value = {};
  } else loadFailure.value = error.value || "市场读取失败，请重试。";
}
async function toggle(library: MarketLibrary) {
  if (selfOwned(library) || pending.value.has(library.id) || loading.value) return;
  pending.value = new Set([...pending.value, library.id]);
  failures.value = { ...failures.value, [library.id]: "" };
  notice.value = "";
  const result = await run<{ enabled: boolean }>(
    `subscription:${library.id}`,
    ref(false),
    `/${encodeURIComponent(library.id)}/subscription`,
    {
      method: "PUT",
      body: JSON.stringify({ enabled: !library.enabled }),
    },
  );
  const nextPending = new Set(pending.value);
  nextPending.delete(library.id);
  pending.value = nextPending;
  if (result) {
    library.enabled = result.enabled;
    notice.value = result.enabled
      ? `已启用「${library.name}」，播放器刷新后显示。`
      : `已关闭「${library.name}」，仅影响自己的媒体库。`;
  } else failures.value = { ...failures.value, [library.id]: error.value || "修改失败，请重试。" };
}
onMounted(load);
</script>
<template>
  <section class="vm-page" aria-label="媒体库市场" :aria-busy="loading">
    <header class="vm-heading">
      <div>
        <h1>虚拟媒体库市场</h1>
        <p>启用后显示在自己的播放器中，关闭只影响自己。作者更新内容时会同步给所有启用者。</p>
      </div>
      <button type="button" :disabled="loading || pending.size > 0" @click="load">刷新市场</button>
    </header>
    <VirtualUpstreamMarket
      v-if="!personal"
      :require-auth="requireAuth"
      :disabled="loading || pending.size > 0"
      @changed="load"
    />
    <p v-if="loadFailure" class="vm-feedback error" role="alert">{{ loadFailure }}</p>
    <p v-if="notice" class="vm-feedback good" role="status">{{ notice }}</p>
    <div class="vm-summary" aria-label="市场状态概览">
      <div class="vm-summary-item">
        <strong>{{ libraries.length }}</strong
        ><span>市场媒体库</span>
      </div>
      <div class="vm-summary-item">
        <strong>{{ enabledCount }}</strong
        ><span>已启用</span>
      </div>
      <div class="vm-summary-item">
        <strong>{{ ownCount }}</strong
        ><span>账号自有 · 始终可见</span>
      </div>
    </div>
    <div class="vm-toolbar">
      <div class="vm-filters" role="group" aria-label="按启用状态筛选">
        <button
          v-for="item in filters"
          :key="item.id"
          type="button"
          :aria-pressed="filter === item.id"
          @click="filter = item.id"
        >
          {{ item.label }} <span>{{ item.count }}</span>
        </button>
      </div>
      <label class="vm-search"
        ><span>搜索市场</span><input v-model="search" type="search" placeholder="媒体库名称或作者"
      /></label>
    </div>
    <p v-if="loading" role="status">正在读取市场…</p>
    <div v-else-if="!loadFailure && !visible.length" class="vm-empty">
      <h2>{{ libraries.length ? "没有匹配的媒体库" : "市场里还没有媒体库" }}</h2>
      <p>{{ libraries.length ? "尝试其他名称、作者或切换筛选条件。" : "可以先在「我的虚拟库」创建并上架一个库。" }}</p>
    </div>
    <div class="vm-grid">
      <article
        v-for="library in visible"
        :key="library.id"
        class="vm-card"
        :aria-busy="pending.has(library.id)"
        :aria-label="library.name"
      >
        <VirtualLibraryCover
          :name="library.name"
          :src="
            library.posterImageTag
              ? `${base}/${encodeURIComponent(library.id)}/poster?tag=${encodeURIComponent(library.posterImageTag)}`
              : undefined
          "
        />
        <div class="vm-card-body">
          <span class="vm-status" :class="selfOwned(library) || library.enabled ? 'good' : 'muted'">{{
            library.owned
              ? "自己创建"
              : library.canSubscribe === false
                ? "账号自有"
                : library.enabled
                  ? "已启用"
                  : "未启用"
          }}</span>
          <h2>{{ library.name }}</h2>
          <span v-if="library.source === 'tgtodrive'" class="vm-status muted">系统自带</span>
          <p class="vm-card-author">{{ library.authorName }}</p>
          <p v-if="library.source === 'tgtodrive'" class="vm-card-hint">
            系统自带媒体库，内容、名称和海报更新后同步展示。
          </p>
          <p v-if="library.owned" class="vm-card-hint">自己创建的库始终可见，可在「我的虚拟库」维护。</p>
          <p v-else-if="library.canSubscribe === false" class="vm-card-hint">当前账号自有媒体库，始终可见。</p>
          <button
            v-else
            type="button"
            :class="library.enabled ? 'vm-button-secondary' : 'vm-button-primary'"
            :disabled="pending.has(library.id) || loading"
            :aria-pressed="library.enabled"
            :aria-label="`${library.enabled ? '关闭媒体库' : '启用媒体库'}`"
            @click="toggle(library)"
          >
            {{ pending.has(library.id) ? "正在保存…" : library.enabled ? "关闭媒体库" : "启用媒体库" }}
          </button>
          <p v-if="failures[library.id]" class="vm-feedback error" role="alert">{{ failures[library.id] }}</p>
        </div>
      </article>
    </div>
  </section>
</template>
