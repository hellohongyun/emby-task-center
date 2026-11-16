<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { useAppServices } from "../state/app-services";
import { useVirtualLibraries, type LibraryDraft } from "../composables/useVirtualLibraries";
import VirtualLibraryForm from "../components/virtual-libraries/VirtualLibraryForm.vue";
import VirtualLibraryItems from "../components/virtual-libraries/VirtualLibraryItems.vue";
import VirtualProxySettings from "../components/virtual-libraries/VirtualProxySettings.vue";
import VirtualSourcePicker from "../components/virtual-libraries/VirtualSourcePicker.vue";
import VirtualLibraryPoster from "../components/virtual-libraries/VirtualLibraryPoster.vue";
import VirtualLibraryCover from "../components/virtual-libraries/VirtualLibraryCover.vue";
import VirtualNameQueue from "../components/virtual-libraries/VirtualNameQueue.vue";
import VirtualLibraryPublication from "../components/virtual-libraries/VirtualLibraryPublication.vue";
import { useVirtualNameQueue } from "../composables/useVirtualNameQueue";
import type { VirtualLibrary } from "@emby-task-center/contracts/virtual-library";

const props = defineProps<{ personal?: boolean; requireAuth?: () => void }>();
const emit = defineEmits<{ "dirty-change": [value: boolean] }>();
const services = props.personal ? null : useAppServices();
const requireAuth = props.requireAuth ?? services?.requireAuth ?? (() => undefined);
const base = props.personal ? "/api/public/virtual-libraries" : "/api/virtual-libraries";
const api = useVirtualLibraries(requireAuth, base);
const queue = useVirtualNameQueue(api);
const { names: queueNames, index: queueIndex, busy: queueBusy, adding: queueAdding } = queue;
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
const publishedCount = computed(() => libraries.value.filter((library) => library.published).length);
watch(formOpen, (value) => emit("dirty-change", value));
onBeforeUnmount(() => emit("dirty-change", false));
watch(selectedId, () => {
  deleteConfirm.value = false;
  formOpen.value = false;
});
if (services?.ui?.authRequired)
  watch(services.ui.authRequired, (required) => {
    if (required) api.cancel();
  });
onMounted(() => {
  void api.load();
  if (!props.personal) void api.loadProxy();
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
  if (await queue.add()) notice.value = "已选内容已加入虚拟媒体库";
}
function updatePoster(library: VirtualLibrary) {
  notice.value = "";
  libraries.value = libraries.value.map((current) => (current.id === library.id ? library : current));
}
</script>

<template>
  <div class="vl-page">
    <header class="vl-page-head">
      <div>
        <h1>我的虚拟媒体库</h1>
        <p v-if="personal">自己的库始终可见；可上架市场供其他用户启用，在「我的媒体库顺序」自由调整位置。</p>
        <p v-if="personal">播放器需在本服务反代入口登录；已有登录态请退出后重新登录一次。</p>
        <p v-else>管理自己创建的库，上架后其他用户可自主启用，修改同步给所有启用者。</p>
      </div>
      <button class="vl-primary" type="button" :disabled="saving" @click="openForm()">＋ 新建虚拟媒体库</button>
    </header>
    <div class="vm-summary vl-library-summary" aria-label="我的虚拟库状态">
      <div class="vm-summary-item">
        <strong>{{ loading ? "—" : libraries.length }}</strong
        ><span>自己创建的库</span>
      </div>
      <div class="vm-summary-item">
        <strong>{{ loading ? "—" : publishedCount }}</strong
        ><span>已上架市场</span>
      </div>
      <div class="vm-summary-item">
        <strong>{{ loading ? "—" : libraries.length - publishedCount }}</strong
        ><span>仅自己可见</span>
      </div>
    </div>
    <p v-if="error" class="vl-error" role="alert">
      {{ error }}<button type="button" @click="error = ''">关闭提示</button>
    </p>
    <p v-if="notice && !error" class="vl-notice" role="status">{{ notice }}</p>
    <VirtualProxySettings
      v-if="!personal"
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
          :aria-label="`${library.name} ${library.collectionType === 'movies' ? '电影' : library.collectionType === 'tvshows' ? '剧集' : '混合'} · ${library.itemCount} 项内容 ${library.published ? '已上架市场' : '仅自己可见'}`"
          @click="api.selectLibrary(library.id)"
        >
          <VirtualLibraryCover
            class="vl-library-thumb"
            :name="library.name"
            :src="
              library.posterImageTag
                ? `${base}/${encodeURIComponent(library.id)}/poster?tag=${encodeURIComponent(library.posterImageTag)}`
                : undefined
            "
          />
          <div class="vl-library-card-text">
            <strong>{{ library.name }}</strong
            ><span
              >{{
                library.collectionType === "movies" ? "电影" : library.collectionType === "tvshows" ? "剧集" : "混合"
              }}
              · {{ library.itemCount }} 项内容</span
            ><small class="vm-status" :class="library.published ? 'good' : 'muted'">{{
              library.published ? "已上架市场" : "仅自己可见"
            }}</small>
          </div>
        </button>
      </aside>
      <div v-if="selectedLibrary" class="vl-main">
        <section class="vl-panel vl-section-head">
          <div>
            <h2>{{ selectedLibrary.name }}</h2>
            <p class="vl-muted">
              {{
                selectedLibrary.published
                  ? "市场正在展示这个库，修改会同步给所有启用者。"
                  : "这个库目前仅自己可见，可以在下方上架到市场。"
              }}
            </p>
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
        <VirtualLibraryPublication
          :key="`publication-${selectedLibrary.id}`"
          :library="selectedLibrary"
          :personal="personal"
          :require-auth="requireAuth"
          @saved="updatePoster"
        />
        <VirtualLibraryPoster
          :key="selectedLibrary.id"
          :library="selectedLibrary"
          :require-auth="requireAuth"
          :base="base"
          :auth-required="services?.ui?.authRequired?.value"
          @saved="updatePoster"
        />
        <VirtualLibraryItems
          :personal="personal"
          :items="items"
          :issues="issues"
          :collection-type="selectedLibrary.collectionType"
          :loading="itemLoading"
          :busy="saving"
          @remove="api.removeItem"
          @refresh="api.loadItems"
        />
        <VirtualNameQueue
          :names="queueNames"
          :index="queueIndex"
          :busy="queueBusy"
          @start="queue.start"
          @skip="queue.next"
          @stop="queue.stop"
        />
        <VirtualSourcePicker
          :personal="personal"
          :collection-type="selectedLibrary.collectionType"
          v-model:search="searchTerm"
          v-model:parent="parentId"
          :items="sourceItems"
          :roots="sourceLibraries"
          :selected="selectedItems"
          :added="addedIds"
          :loading="sourceLoading || itemLoading"
          :busy="saving || queueAdding"
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
