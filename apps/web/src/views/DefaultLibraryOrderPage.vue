<script setup lang="ts">
import PersonalLibraryOrder from "../components/virtual-libraries/PersonalLibraryOrder.vue";
import VirtualPlayerAccount from "../components/virtual-libraries/VirtualPlayerAccount.vue";
import { ref } from "vue";
import { useAppServices } from "../state/app-services";
const { requireAuth } = useAppServices();
const dirty = ref(false);
const revision = ref(0);
</script>
<template>
  <div class="vm-workspace">
    <VirtualPlayerAccount
      :require-auth="requireAuth"
      :pending-changes="dirty"
      @saved="revision++"
    /><PersonalLibraryOrder :key="revision" defaults :require-auth="requireAuth" @dirty-change="dirty = $event" />
  </div>
</template>
<style src="../components/virtual-libraries/virtual-market.css"></style>
<style src="../components/virtual-libraries/virtual-market-workspace.css"></style>
