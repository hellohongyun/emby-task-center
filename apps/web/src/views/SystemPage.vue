<script setup lang="ts">
import { onBeforeUnmount } from "vue";
import { useAppServices } from "../state/app-services";
import SystemView from "../components/SystemView.vue";

/** 系统状态视图（P4：路由页面）。 */
const services = useAppServices();
onBeforeUnmount(() => services.system.cancel());
</script>

<template>
  <SystemView
    :status="services.system.status.value"
    :activity="services.system.activity.value"
    :loading="services.system.loading.value"
    :error="services.system.error.value"
    @refresh="services.system.load"
    @logout="services.ui.handleLogout"
  />
</template>
