<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { MarketUserLibrary } from "@emby-task-center/contracts/virtual-library-market";
import type { VirtualLibraryItem } from "@emby-task-center/contracts/virtual-library";
import { virtualLibraryRequests } from "../../composables/virtual-library-requests";
import VirtualLibraryCover from "./VirtualLibraryCover.vue";
import VirtualLibraryAuthor from "./VirtualLibraryAuthor.vue";
import VirtualReadonlyFilms from "./VirtualReadonlyFilms.vue";
const props = defineProps<{ requireAuth: () => void }>();
const base = "/api/virtual-library-market";
const lists = virtualLibraryRequests(props.requireAuth, base);
const content = virtualLibraryRequests(props.requireAuth, base);
const libraries = ref<MarketUserLibrary[]>([]);
const items = ref<VirtualLibraryItem[]>([]);
const selected = ref("");
const search = ref("");
const pickerExpanded = ref(false);
const loading = ref(false);
const itemLoading = ref(false);
const itemsReady = ref(false);
let revision = 0;
const visible = computed(() =>
  libraries.value.filter((library) =>
    `${library.ownerEmail ?? library.authorName} ${library.name}`
      .toLowerCase()
      .includes(search.value.trim().toLowerCase()),
  ),
);
const current = computed(() => libraries.value.find((library) => library.id === selected.value));
const poster = (library: MarketUserLibrary) =>
  library.posterImageTag
    ? `${base}/user-libraries/${encodeURIComponent(library.id)}/poster?tag=${encodeURIComponent(library.posterImageTag)}`
    : undefined;
async function select(library: MarketUserLibrary) {
  pickerExpanded.value = false;
  const request = ++revision;
  selected.value = library.id;
  items.value = [];
  itemsReady.value = false;
  const result = await content.run<{ items: VirtualLibraryItem[] }>(
    "items",
    itemLoading,
    `/user-libraries/${encodeURIComponent(library.id)}/items`,
  );
  if (result && request === revision && selected.value === library.id) {
    items.value = result.items;
    itemsReady.value = true;
  }
}
async function load() {
  const result = await lists.run<{ libraries: MarketUserLibrary[] }>("libraries", loading, "/user-libraries");
  if (!result) return;
  libraries.value = result.libraries;
  const next = libraries.value.find((library) => library.id === selected.value) ?? libraries.value[0];
  if (next) await select(next);
  else {
    revision++;
    selected.value = "";
    items.value = [];
    itemsReady.value = false;
  }
}
onMounted(load);
</script>
<template>
  <section class="vm-page vul-page" aria-label="用户媒体库只读查看">
    <header class="vul-heading">
      <div>
        <h1>用户媒体库查看</h1>
        <p>查看用户的选片与海报，全部操作仅供只读浏览。</p>
      </div>
      <div class="vm-actions">
        <span class="vm-status muted">后台只读</span
        ><button type="button" :disabled="loading" @click="load">刷新</button>
      </div>
    </header>
    <p v-if="lists.error.value" class="vm-feedback error" role="alert">{{ lists.error.value }}</p>
    <div class="vul-layout">
      <aside class="vul-picker" :class="{ expanded: pickerExpanded }" aria-label="用户媒体库列表">
        <div class="vul-picker-heading">
          <div class="vul-picker-label">
            <h2>用户媒体库</h2>
            <strong class="vul-picker-current">{{ current?.name ?? "选择媒体库" }}</strong>
            <span>{{ loading ? "读取中…" : `${libraries.length} 个库` }}</span>
          </div>
          <button
            class="vul-picker-toggle"
            type="button"
            :aria-expanded="pickerExpanded"
            aria-controls="vul-picker-options"
            @click="pickerExpanded = !pickerExpanded"
          >
            {{ pickerExpanded ? "收起选择" : "切换媒体库" }}
          </button>
        </div>
        <div id="vul-picker-options" class="vul-picker-body">
          <label class="vul-search"
            >搜索用户或媒体库<input v-model="search" type="search" placeholder="库名称或用户邮箱"
          /></label>
          <p v-if="loading && !libraries.length" role="status">正在读取用户库…</p>
          <div class="vul-library-list">
            <button
              v-for="library in visible"
              :key="library.id"
              type="button"
              class="vul-library"
              :aria-pressed="selected === library.id"
              :aria-label="`${library.name} ${library.ownerEmail ?? library.authorName}`"
              @click="select(library)"
            >
              <VirtualLibraryCover class="vul-library-thumb" :name="library.name" :src="poster(library)" />
              <span class="vul-library-info"
                ><strong>{{ library.name }}</strong
                ><VirtualLibraryAuthor :library="library" /><small v-if="library.ownerEmail">{{
                  library.ownerEmail
                }}</small
                ><span>{{ library.itemCount }} 项 · {{ library.published ? "已上架" : "未公开" }}</span></span
              >
            </button>
          </div>
          <p v-if="!loading && !lists.error.value && !visible.length" class="vul-empty-picker">
            {{ libraries.length ? "没有匹配的用户库，试试其他名称或邮箱。" : "还没有用户创建媒体库。" }}
          </p>
        </div>
      </aside>
      <article v-if="current" class="vul-content" :aria-label="`${current.name}内容`">
        <header class="vul-current">
          <VirtualLibraryCover class="vul-current-thumb" :name="current.name" :src="poster(current)" />
          <div>
            <h2>{{ current.name }}</h2>
            <p><VirtualLibraryAuthor :library="current" /></p>
            <p v-if="current.ownerEmail">{{ current.ownerEmail }}</p>
            <span class="vm-status" :class="current.published ? 'good' : 'muted'">{{
              current.published ? "作者已上架" : "未公开分享"
            }}</span>
          </div>
          <span class="vul-current-count">{{ itemsReady ? items.length : current.itemCount }} 项内容</span>
        </header>
        <p v-if="itemLoading" class="vul-state" role="status">正在读取内容…</p>
        <div v-else-if="content.error.value" class="vul-state" role="alert">
          <strong>内容读取失败</strong>
          <p>{{ content.error.value }}</p>
          <button type="button" @click="select(current)">重试读取内容</button>
        </div>
        <VirtualReadonlyFilms v-else-if="itemsReady" :key="current.id" :library-id="current.id" :items="items" />
      </article>
      <div v-else class="vul-state">
        <strong>选择一个用户库查看</strong>
        <p>这里仅查看资料和影片关联，不能代替作者修改。</p>
      </div>
    </div>
  </section>
</template>
<style src="./virtual-user-libraries.css"></style>
<style src="./virtual-user-picker.css"></style>
