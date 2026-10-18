<script setup lang="ts">
import { ref } from "vue";
import type { MissingMetadataIssue } from "../types";
withDefaults(defineProps<{ issues: MissingMetadataIssue[]; scopeLabel?: string }>(), { scopeLabel: "全库" });
const expanded = ref(false);
function dateText(value: string | null) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "尚无完整结果";
}
</script>

<template>
  <section v-if="issues.length" class="metadata-notice" aria-label="检测数据不完整">
    <strong>{{ issues.length }} 部剧的 TMDB 数据未完整刷新</strong>
    <p>这些条目使用上次完整的 TMDB 数据；没有完整数据的条目暂不判定缺集。当前合计不能代表{{ scopeLabel }}已齐。</p>
    <button type="button" :aria-expanded="expanded" @click="expanded = !expanded">
      {{ expanded ? "收起详情" : "查看失败详情" }}
    </button>
    <ul v-if="expanded">
      <li v-for="issue in issues.slice(0, 50)" :key="issue.mediaItemId">
        <b>{{ issue.title }}</b>
        <span
          >{{ issue.error === "tmdb_partial_unavailable" ? "部分季读取失败" : "TMDB 暂时不可用"
          }}<template v-if="issue.failedSeasons.length"
            >（{{ issue.failedSeasons.map((season) => `S${season}`).join("、") }}）</template
          ></span
        >
        <span v-if="issue.unavailableSeasons.length"
          >尚无分集缓存：{{ issue.unavailableSeasons.map((season) => `S${season}`).join("、") }}</span
        >
        <span
          >上次完整结果：{{ dateText(issue.lastCompleteAt)
          }}<template v-if="issue.expiresAt">；缓存有效至 {{ dateText(issue.expiresAt) }}</template></span
        >
        <span>最早 {{ dateText(issue.retryAt) }} 可重试；之后下一次检测会重新拉取。</span>
      </li>
    </ul>
    <p v-if="expanded && issues.length > 50">仅展开前 50 部，共 {{ issues.length }} 部待完整检测。</p>
  </section>
</template>

<style scoped>
.metadata-notice {
  margin: 16px 0;
  padding: 16px;
  border: 1px solid #705330;
  border-radius: 10px;
  color: #edcd99;
  background: #241d13;
}
p,
ul {
  margin: 8px 0;
}
li {
  display: grid;
  gap: 4px;
  margin: 12px 0;
}
span {
  font-size: 13px;
}
button {
  padding: 6px 12px;
  color: inherit;
  background: transparent;
  border: 1px solid #705330;
  border-radius: 6px;
}
</style>
