<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { useAppServices } from "../state/app-services";
import { useVirtualLibraries, type LibraryDraft } from "../composables/useVirtualLibraries";
import VirtualLibraryForm from "../components/virtual-libraries/VirtualLibraryForm.vue";
import VirtualLibraryItems from "../components/virtual-libraries/VirtualLibraryItems.vue";
import VirtualProxySettings from "../components/virtual-libraries/VirtualProxySettings.vue";
import VirtualSourcePicker from "../components/virtual-libraries/VirtualSourcePicker.vue";
import VirtualLibraryPoster from "../components/virtual-libraries/VirtualLibraryPoster.vue";
import type { VirtualLibrary } from "@emby-task-center/contracts/virtual-library";

const services = useAppServices();
const api = useVirtualLibraries(services.requireAuth);
const {
  libraries,
  selectedId,
  selectedLibrary,
  items,
  issues,
  sourceItems,
  sourceLibraries,
  selectedItems,
  addedIds,
  total,
  searchTerm,
  parentId,
  startIndex,
  limit,
  loading,
  itemLoading,
  sourceLoading,
  saving,
  proxyLoading,
  proxySaving,
  proxy,
  error,
} = api;
const formOpen = ref(false);
const editingId = ref<string>();
const draft = ref<LibraryDraft>({ name: "", collectionType: "mixed", sortOrder: 0 });
const deleteConfirm = ref(false);
const notice = ref("");
watch(selectedId, () => {
  deleteConfirm.value = false;
  formOpen.value = false;
});
if (services.ui?.authRequired)
  watch(services.ui.authRequired, (required) => {
    if (required) api.cancel();
  });
onMounted(() => {
  void api.load();
  void api.loadProxy();
  void api.loadSourceLibraries();
  void api.loadSources();
});

function openForm(edit = false) {
  const library = edit ? selectedLibrary.value : null;
  editingId.value = library?.id;
  draft.value = library
    ? { name: library.name, collectionType: library.collectionType, sortOrder: library.sortOrder }
    : { name: "", collectionType: "mixed", sortOrder: libraries.value.length };
  formOpen.value = true;
  notice.value = "";
}
async function saveLibrary(value: LibraryDraft) {
  if (await api.saveLibrary(value, editingId.value)) {
    formOpen.value = false;
    notice.value = "虚拟媒体库已保存";
  }
}
async function removeLibrary() {
  if (await api.deleteLibrary(selectedId.value)) {
    deleteConfirm.value = false;
    notice.value = "虚拟媒体库已删除";
  }
}
async function addItems() {
  if (await api.addItems()) notice.value = "已选内容已加入虚拟媒体库";
}
function updatePoster(library: VirtualLibrary) {
  libraries.value = libraries.value.map((current) => (current.id === library.id ? library : current));
}
</script>

<template>
  <div class="vl-page">
    <header class="vl-page-head">
      <div>
        <h1>虚拟媒体库</h1>
        <p>将 Emby 已有影片或剧集映射到新媒体库，在客户端与原有媒体库一起展示。</p>
      </div>
      <button class="vl-primary" type="button" :disabled="saving" @click="openForm()">＋ 新建虚拟媒体库</button>
    </header>
    <p v-if="error" class="vl-error" role="alert">
      {{ error }}<button type="button" @click="error = ''">关闭提示</button>
    </p>
    <p v-if="notice && !error" class="vl-notice" role="status">{{ notice }}</p>
    <VirtualProxySettings
      :state="proxy"
      :loading="proxyLoading"
      :busy="proxySaving"
      @save="api.saveProxy"
      @refresh="api.loadProxy"
    />
    <VirtualLibraryForm
      v-if="formOpen"
      :initial="draft"
      :editing="!!editingId"
      :busy="saving"
      :items="editingId ? items : []"
      :items-loading="itemLoading"
      @save="saveLibrary"
      @cancel="formOpen = false"
    />
    <div class="vl-layout">
      <aside class="vl-panel vl-libraries" aria-label="虚拟媒体库列表">
        <div class="vl-section-head">
          <h2>
            我的虚拟库 <span>{{ libraries.length }}</span>
          </h2>
          <button type="button" :disabled="loading || saving" @click="api.load">刷新</button>
        </div>
        <p v-if="loading" class="vl-empty" role="status">正在加载媒体库…</p>
        <p v-else-if="!libraries.length" class="vl-empty">还没有虚拟媒体库。新建一个库后即可添加内容。</p>
        <button
          v-for="library in libraries"
          :key="library.id"
          type="button"
          class="vl-library-card"
          :class="{ active: selectedId === library.id }"
          :disabled="saving"
          :aria-pressed="selectedId === library.id"
          @click="api.selectLibrary(library.id)"
        >
          <strong>{{ library.name }}</strong
          ><span
            >{{
              library.collectionType === "movies" ? "电影" : library.collectionType === "tvshows" ? "剧集" : "混合"
            }}
            · {{ library.itemCount }} 项内容</span
          ><small>排序 {{ library.sortOrder }}</small>
        </button>
      </aside>
      <div v-if="selectedLibrary" class="vl-main">
        <section class="vl-panel vl-section-head">
          <div>
            <h2>{{ selectedLibrary.name }}</h2>
            <p class="vl-muted">保留原影片资料、播放进度与客户端原有功能。</p>
          </div>
          <div class="vl-actions">
            <button type="button" :disabled="saving" @click="openForm(true)">编辑媒体库</button
            ><button class="vl-danger" type="button" :disabled="saving" @click="deleteConfirm = !deleteConfirm">
              删除虚拟库
            </button>
          </div>
        </section>
        <section v-if="deleteConfirm" class="vl-panel vl-confirm" aria-label="确认删除虚拟库">
          <p>删除“{{ selectedLibrary.name }}”及其中的映射关联？Emby 中的原影片会保留。</p>
          <div class="vl-actions">
            <button class="vl-danger" type="button" :disabled="saving" @click="removeLibrary">确认删除虚拟库</button
            ><button type="button" :disabled="saving" @click="deleteConfirm = false">取消</button>
          </div>
        </section>
        <VirtualLibraryPoster
          :key="selectedLibrary.id"
          :library="selectedLibrary"
          :require-auth="services.requireAuth"
          :auth-required="services.ui?.authRequired?.value"
          @saved="updatePoster"
        />
        <VirtualLibraryItems
          :items="items"
          :issues="issues"
          :collection-type="selectedLibrary.collectionType"
          :loading="itemLoading"
          :busy="saving"
          @remove="api.removeItem"
          @refresh="api.loadItems"
        />
        <VirtualSourcePicker
          :collection-type="selectedLibrary.collectionType"
          v-model:search="searchTerm"
          v-model:parent="parentId"
          :items="sourceItems"
          :roots="sourceLibraries"
          :selected="selectedItems"
          :added="addedIds"
          :loading="sourceLoading || itemLoading"
          :busy="saving"
          :total="total"
          :start="startIndex"
          :limit="limit"
          @search="api.loadSources(true)"
          @toggle="api.toggleItem"
          @add="addItems"
          @page="api.page"
        />
      </div>
      <section v-else class="vl-panel vl-empty">新建或选择一个虚拟媒体库，开始映射 Emby 内容。</section>
    </div>
  </div>
</template>

<style src="../components/virtual-libraries/virtual-libraries.css"></style>
<style src="../components/virtual-libraries/virtual-library-responsive.css"></style>
