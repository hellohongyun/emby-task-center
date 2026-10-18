<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";

import MissingEpisodesView from "../components/MissingEpisodesView.vue";
import { useMissingEpisodes } from "../composables/useMissingEpisodes";
import { useAppServices } from "../state/app-services";

/** 缺集总览页（只读 + 批量删除）：数据来自后台全库检测快照，删除调 Emby 接口。 */
const services = useAppServices();
const {
  payload,
  selectedRootId,
  loading,
  deleting,
  scanStarting,
  error,
  actionMessage,
  load,
  deleteShows,
  triggerScan,
  startAutoRefresh,
  cancel,
} = useMissingEpisodes({ requireAuth: services.requireAuth });
onMounted(() => startAutoRefresh());
onBeforeUnmount(cancel);
</script>

<template>
  <MissingEpisodesView
    :payload="payload"
    :selected-root-id="selectedRootId"
    :loading="loading"
    :deleting="deleting"
    :scan-starting="scanStarting"
    :error="error"
    :action-message="actionMessage"
    :delete-shows="deleteShows"
    :trigger-scan="triggerScan"
    @refresh="load()"
    @select-library="load($event)"
  />
</template>
