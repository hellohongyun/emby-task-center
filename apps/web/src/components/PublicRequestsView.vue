<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import {
  mdiClipboardTextOutline,
  mdiFilmstrip,
  mdiPlaylistPlus,
  mdiTelevisionPlay,
  mdiTextBoxPlusOutline,
} from "@mdi/js";
import { nextTick, ref } from "vue";
import MediaRequestForm from "./MediaRequestForm.vue";
import MediaRequestList from "./MediaRequestList.vue";

const list = ref<InstanceType<typeof MediaRequestList> | null>(null);
const form = ref<InstanceType<typeof MediaRequestForm> | null>(null);
const tabs = ref<HTMLElement | null>(null);
const active = ref<"submit" | "records">("submit");
const recordsLoaded = ref(false);
const guide = [
  { icon: mdiFilmstrip, title: "电影", description: "每条申请对应一部电影。" },
  { icon: mdiTelevisionPlay, title: "剧集", description: "每次申请一季，不同季可分别提交。" },
  { icon: mdiTextBoxPlusOutline, title: "补集", description: "选择对应分季，写明缺少的集号或内容。" },
];

async function focusActiveTab() {
  await nextTick();
  tabs.value?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
}
function openRecords() {
  active.value = "records";
  recordsLoaded.value = true;
}
function showRecords() {
  openRecords();
  void focusActiveTab();
}
async function onSubmitted() {
  if (!recordsLoaded.value) recordsLoaded.value = true;
  else await list.value?.refresh();
}
function switchTab(event: KeyboardEvent) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  if (event.key === "Home") active.value = "submit";
  else if (event.key === "End") openRecords();
  else if (active.value === "submit") openRecords();
  else active.value = "submit";
  void focusActiveTab();
}
function newRequest() {
  form.value?.startNew();
  active.value = "submit";
  void focusActiveTab();
}
</script>

<template>
  <div class="member-requests-page">
    <div class="page-top">
      <header class="page-header">
        <p class="page-kicker">会员服务</p>
        <h1>求片与补集</h1>
        <p class="page-intro">申请未入库的电影或剧集，也可以补齐缺少的集数。</p>
      </header>
      <div ref="tabs" class="request-tabs" role="tablist" aria-label="求片功能" @keydown="switchTab">
        <button
          id="request-submit-tab"
          type="button"
          role="tab"
          :aria-selected="active === 'submit'"
          :tabindex="active === 'submit' ? 0 : -1"
          aria-controls="request-submit-panel"
          @click="active = 'submit'"
        >
          <SvgIcon type="mdi" :path="mdiPlaylistPlus" :size="18" aria-hidden="true" />
          提交申请
        </button>
        <button
          id="request-records-tab"
          type="button"
          role="tab"
          :aria-selected="active === 'records'"
          :tabindex="active === 'records' ? 0 : -1"
          aria-controls="request-records-panel"
          @click="openRecords"
        >
          <SvgIcon type="mdi" :path="mdiClipboardTextOutline" :size="17" aria-hidden="true" />
          我的申请
        </button>
      </div>
    </div>
    <div
      id="request-submit-panel"
      v-show="active === 'submit'"
      class="request-workspace"
      role="tabpanel"
      aria-labelledby="request-submit-tab"
    >
      <MediaRequestForm ref="form" @submitted="onSubmitted" @view-records="showRecords" />
      <aside class="request-guide" aria-labelledby="request-guide-heading">
        <h2 id="request-guide-heading">申请指南</h2>
        <dl>
          <div v-for="item in guide" :key="item.title">
            <dt><SvgIcon type="mdi" :path="item.icon" :size="18" aria-hidden="true" />{{ item.title }}</dt>
            <dd>{{ item.description }}</dd>
          </div>
        </dl>
        <p>资源由管理员人工处理，可在「我的申请」查看进度。</p>
      </aside>
    </div>
    <div
      id="request-records-panel"
      v-show="active === 'records'"
      class="records-panel"
      role="tabpanel"
      aria-labelledby="request-records-tab"
    >
      <MediaRequestList v-if="recordsLoaded" ref="list">
        <template #member-actions>
          <button class="record-new" type="button" @click="newRequest">+ 提交申请</button>
        </template>
      </MediaRequestList>
    </div>
  </div>
</template>

<style scoped src="./PublicRequestsView.css"></style>
