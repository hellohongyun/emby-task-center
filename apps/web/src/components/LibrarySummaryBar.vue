<script setup lang="ts">
import type { LibrarySummary } from "../library/work-groups";

/**
 * 媒体库统计条（作品数 / 媒体库数 / 条目数 / 海报 / 题材）。
 *
 * 以前这里显示"已匹配 TMDB / 未匹配 TMDB / TMDB 匹配率"——那是本地 STRM 文件要跟 TMDB
 * 条目配对的年代留下的指标；媒体库改由 Emby 驱动后，元数据（含 TMDB Id、海报、题材）本来就由
 * Emby 提供，用"匹配率"当门面指标会误导。现在显示真正反映库质量的：海报覆盖率与缺题材数。
 */
defineProps<{
  summary: LibrarySummary;
  /** 已配置目录数（父组件持有 roots，只传数量）。 */
  rootCount: number;
}>();
</script>

<template>
  <div class="library-summary">
    <div>
      <strong>{{ summary.workCount }}</strong
      ><span>作品数量</span>
    </div>
    <div>
      <strong>{{ rootCount }}</strong
      ><span>媒体库</span>
    </div>
    <div>
      <strong>{{ summary.totalFiles }}</strong
      ><span>媒体条目</span>
    </div>
    <div>
      <strong>{{ summary.posterFiles }}</strong
      ><span>有海报</span>
    </div>
    <div>
      <strong>{{ summary.missingGenreFiles }}</strong
      ><span>缺题材</span>
    </div>
    <div class="match-summary">
      <strong>{{ summary.posterRatio }}%</strong><span>海报覆盖率</span>
      <div class="match-bar" aria-hidden="true"><i :style="{ width: `${summary.posterRatio}%` }" /></div>
    </div>
  </div>
</template>

<style scoped src="./LibrarySummaryBar.css"></style>
<style scoped src="./library-shared.css"></style>
