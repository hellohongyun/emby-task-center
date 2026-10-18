<script setup lang="ts">
import { computed } from "vue";

import type { ReasonBucket } from "../library/work-groups";

/** 未匹配原因分析（可折叠；数据由父组件算好）。 */
const props = defineProps<{ report: ReasonBucket[] }>();

const totalGroups = computed(() => props.report.reduce((sum, row) => sum + row.count, 0));
</script>

<template>
  <details class="unmatched-report">
    <summary>未匹配原因分析（{{ totalGroups }} 组）</summary>
    <div class="report-grid">
      <div v-for="row in report" :key="row.label" class="report-row">
        <span class="report-head"
          ><b>{{ row.label }}</b
          ><em>{{ row.count }} 组</em></span
        >
        <small>{{ row.sample.join(" / ") }}</small>
      </div>
    </div>
  </details>
</template>

<style scoped src="./LibraryUnmatchedReport.css"></style>
<style scoped src="./library-shared.css"></style>
