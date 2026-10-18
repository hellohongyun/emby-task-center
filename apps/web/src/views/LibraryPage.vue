<script setup lang="ts">
import { useAppServices } from "../state/app-services";
import LibraryView from "../components/LibraryView.vue";
const services = useAppServices();
</script>

<template>
  <LibraryView :library="services.library" />
</template>
