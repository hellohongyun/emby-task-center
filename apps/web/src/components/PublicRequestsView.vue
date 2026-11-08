<script setup lang="ts">
import { nextTick, ref } from "vue";
import MediaRequestForm from "./MediaRequestForm.vue";
import MediaRequestList from "./MediaRequestList.vue";
const list = ref<InstanceType<typeof MediaRequestList> | null>(null);
const form = ref<InstanceType<typeof MediaRequestForm> | null>(null);
const active = ref<"submit" | "records">("submit");
const recordsLoaded = ref(false);
const submitted = ref(false);
function newRequest() {
  form.value?.startNew();
  active.value = "submit";
}
function openRecords() {
  active.value = "records";
  recordsLoaded.value = true;
}
async function onSubmitted() {
  submitted.value = true;
  if (!recordsLoaded.value) recordsLoaded.value = true;
  else await list.value?.refresh();
}
async function switchTab(event: KeyboardEvent) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const tabs = event.currentTarget as HTMLElement | null;
  if (event.key === "Home") active.value = "submit";
  else if (event.key === "End") openRecords();
  else if (active.value === "submit") openRecords();
  else active.value = "submit";
  await nextTick();
  tabs?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
}
</script>

<template>
  <div class="member-requests-page">
    <header class="page-header">
      <h1>求片与补集<span aria-hidden="true">.</span></h1>
      <p>提交想看的作品，或申请补齐缺少的剧集。</p>
    </header>
    <div class="request-tabs" role="tablist" aria-label="求片功能" @keydown="switchTab">
      <button
        id="request-submit-tab"
        type="button"
        role="tab"
        :aria-selected="active === 'submit'"
        :tabindex="active === 'submit' ? 0 : -1"
        aria-controls="request-submit-panel"
        @click="active = 'submit'"
      >
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
        我的申请
      </button>
    </div>
    <div id="request-submit-panel" v-show="active === 'submit'" role="tabpanel" aria-labelledby="request-submit-tab">
      <MediaRequestForm ref="form" @submitted="onSubmitted" @view-records="openRecords" />
    </div>
    <div id="request-records-panel" v-show="active === 'records'" role="tabpanel" aria-labelledby="request-records-tab">
      <div class="records-intro"><button type="button" @click="newRequest">+ 提交申请</button></div>
      <p v-if="submitted" class="submitted-notice" role="status">
        <span aria-hidden="true">✓</span> 申请已保存，可在下方查看状态。后续进度由管理员更新。
      </p>
      <MediaRequestList v-if="recordsLoaded" ref="list" />
    </div>
    <p class="page-footnote">资源由管理员人工寻找与处理，提交申请不代表一定能够提供。</p>
  </div>
</template>

<style scoped src="./PublicRequestsView.css"></style>
