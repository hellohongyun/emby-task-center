<script setup lang="ts">
import Share115Workspace from "../components/Share115Workspace.vue";
import { useAppServices } from "../state/app-services";

const services = useAppServices();
</script>

<template>
  <Share115Workspace admin :require-auth="services.requireAuth" />
</template>
