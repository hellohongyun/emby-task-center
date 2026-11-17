<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { MarketLibrary, MarketLibraryDetails } from "@emby-task-center/contracts/virtual-library-market";
import { useDialogFocus } from "../../composables/useDialogFocus";
import { virtualLibraryRequests } from "../../composables/virtual-library-requests";
import { friendlyError } from "../../composables/portal-member";
import VirtualLibraryCover from "./VirtualLibraryCover.vue";
import VirtualLibraryAuthor from "./VirtualLibraryAuthor.vue";
import VirtualReadonlyFilms from "./VirtualReadonlyFilms.vue";
const props = defineProps<{ library: MarketLibrary; base: string; requireAuth: () => void }>();
const emit = defineEmits<{ close: [] }>();
const focus = useDialogFocus(() => emit("close"));
const surface = focus.surface;
const { run, error } = virtualLibraryRequests(props.requireAuth, props.base);
const loading = ref(false);
const result = ref<MarketLibraryDetails | null>(null);
const startIndex = ref(0);
const limit = 40;
const current = computed(() => result.value?.library ?? props.library);
const endpoint = `${props.base}/${encodeURIComponent(props.library.id)}`;
const kind = computed(
  () => ({ movies: "电影库", tvshows: "剧集库", mixed: "混合库" })[current.value.collectionType] ?? "媒体库",
);
const errorMessages: Record<string, string> = {
  virtual_library_not_found: "该媒体库已下架、被移除或无权查看，请关闭详情并刷新市场。",
  upstream_catalog_unavailable: "媒体库来源暂时无法读取，请稍后重试。",
  invalid_upstream_catalog: "媒体库来源返回的内容格式异常，请稍后重试或联系管理员。",
  emby_not_configured: "管理员尚未配置 Emby 服务，暂时无法读取此媒体库。",
  emby_account_required: "请先绑定 Emby 账号，再查看此媒体库。",
};
const failure = computed(() => {
  const message = error.value;
  if (!message) return "";
  const translated = Object.entries(errorMessages).find(([code]) => friendlyError(code) === message)?.[1];
  return (
    errorMessages[message] ??
    translated ??
    (/^[a-z][a-z0-9_]*$/i.test(message) ? "媒体库内容暂时无法读取，请稍后重试。" : message)
  );
});
async function load(offset = startIndex.value) {
  if (result.value) surface.value?.querySelector<HTMLButtonElement>("button")?.focus();
  startIndex.value = offset;
  result.value = null;
  const response = await run<MarketLibraryDetails>(
    "details",
    loading,
    `/${encodeURIComponent(props.library.id)}/details?startIndex=${offset}&limit=${limit}`,
  );
  if (response) result.value = response;
}
const previousOverflow = document.body.style.overflow;
onMounted(() => {
  focus.activate();
  document.body.style.overflow = "hidden";
  void load(0);
});
onBeforeUnmount(() => {
  document.body.style.overflow = previousOverflow;
  focus.deactivate();
});
</script>
<template>
  <Teleport to="body">
    <div ref="surface" class="vmd-backdrop" @click.self="emit('close')" @keydown="focus.onKeydown">
      <section class="vmd-dialog vul-page vm-page" role="dialog" aria-modal="true" :aria-label="`${library.name} 详情`">
        <header class="vmd-heading">
          <h2>媒体库详情</h2>
          <button type="button" aria-label="关闭媒体库详情" @click="emit('close')">关闭</button>
        </header>
        <div class="vmd-scroll">
          <header class="vmd-summary">
            <VirtualLibraryCover
              :name="current.name"
              :src="
                current.posterImageTag
                  ? `${endpoint}/poster?tag=${encodeURIComponent(current.posterImageTag)}`
                  : undefined
              "
            />
            <div>
              <h3>{{ current.name }}</h3>
              <VirtualLibraryAuthor :library="current" />
              <p>
                {{ kind }}<span v-if="result"> · {{ result.total }} 项内容</span>
              </p>
              <p class="vmd-hint">浏览内容不会改变启用状态。</p>
            </div>
          </header>
          <div :aria-busy="loading">
            <p v-if="loading" class="vul-state" role="status">正在读取媒体库内容…</p>
            <div v-else-if="failure" class="vul-state" role="alert">
              <strong>内容读取失败</strong>
              <p>{{ failure }}</p>
              <button type="button" @click="load()">重试读取内容</button>
            </div>
            <template v-else-if="result">
              <VirtualReadonlyFilms
                :key="startIndex"
                :library-id="library.id"
                :items="result.items"
                :poster-base="endpoint"
                :empty-hint="current.source === 'tgtodrive' ? '来源暂未返回影片，请稍后重试。' : undefined"
                paginated
              />
              <nav v-if="result.total > limit" class="vmd-pagination" aria-label="库内影片分页">
                <button type="button" :disabled="startIndex === 0" @click="load(Math.max(0, startIndex - limit))">
                  上一页
                </button>
                <span
                  >{{ Math.floor(startIndex / limit) + 1 }} / {{ Math.ceil(result.total / limit) }} 页 ·
                  {{ result.total }} 项</span
                >
                <button type="button" :disabled="startIndex + limit >= result.total" @click="load(startIndex + limit)">
                  下一页
                </button>
              </nav>
            </template>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>
<style src="./virtual-user-libraries.css"></style>
<style src="./virtual-user-picker.css"></style>
<style src="./virtual-market-details.css"></style>
