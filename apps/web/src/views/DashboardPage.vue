<script setup lang="ts">
import DashboardView from "../components/DashboardView.vue";
import { useAppServices } from "../state/app-services";

const services = useAppServices();
</script>

<template>
  <DashboardView :require-auth="services.requireAuth" @navigate="services.ui.goToView" />
</template>
