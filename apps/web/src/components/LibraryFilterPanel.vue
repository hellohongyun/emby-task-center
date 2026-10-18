<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import { mdiClose, mdiMagnify } from "@mdi/js";
import { ref, useId } from "vue";

import FilterChipRow from "./FilterChipRow.vue";
import type { LibraryFilterValues } from "../library/filters";
import type { FilterOption } from "../types";

/**
 * 媒体库筛选面板（P4：从 LibraryView 的模板拆出）。
 *
 * 受控组件：筛选值通过 v-model 双向绑定，选项与计数是纯输入，清除筛选走事件。
 * 筛选值由父级控制，组件只保留移动端面板的展开状态。
 */
const model = defineModel<LibraryFilterValues>({ required: true });
const query = defineModel<string>("query", { required: true });
const filtersExpanded = ref(false);
const rowsId = useId();

defineProps<{
  typeOptions: FilterOption[];
  statusOptions: FilterOption[];
  sortOptions: FilterOption[];
  resolutionOptions: FilterOption[];
  codecOptions: FilterOption[];
  genreOptions: FilterOption[];
  yearOptions: FilterOption[];
  /** 当前筛选后可见的作品数（父组件按各目录合计）。 */
  visibleGroupCount: number;
  activeFilterCount: number;
  hasActiveFilters: boolean;
}>();

const emit = defineEmits<{ clear: [] }>();

/** 只改一个字段，其余保持（父组件的 computed setter 会把值写回各 ref）。 */
function patch(partial: Partial<LibraryFilterValues>): void {
  model.value = { ...model.value, ...partial };
}
</script>

<template>
  <div class="filter-shell" role="search" aria-label="作品筛选">
    <div class="filter-top">
      <label class="filter-search">
        <SvgIcon type="mdi" :path="mdiMagnify" :size="18" aria-hidden="true" />
        <input v-model="query" type="search" placeholder="搜索片名 / 别名…" aria-label="搜索片名" />
      </label>
      <div class="filter-actions">
        <span class="filter-count" role="status">
          {{ visibleGroupCount }} 个作品<template v-if="hasActiveFilters"> 匹配</template>
        </span>
        <button v-if="hasActiveFilters" type="button" class="clear-filters" @click="emit('clear')">
          <SvgIcon type="mdi" :path="mdiClose" :size="14" aria-hidden="true" />清除筛选（{{ activeFilterCount }}）
        </button>
        <button
          type="button"
          class="filter-toggle"
          :aria-expanded="filtersExpanded"
          :aria-controls="rowsId"
          @click="filtersExpanded = !filtersExpanded"
        >
          {{ filtersExpanded ? "收起筛选" : "展开筛选"
          }}<span v-if="hasActiveFilters">（{{ activeFilterCount }}）</span>
        </button>
      </div>
    </div>
    <div :id="rowsId" class="filter-rows" :class="{ 'is-expanded': filtersExpanded }">
      <div class="filter-row">
        <span class="field-label">类型</span>
        <div class="filter-controls">
          <FilterChipRow
            :model-value="model.type"
            :options="typeOptions"
            all-label="全部"
            @update:model-value="patch({ type: $event as LibraryFilterValues['type'] })"
          />
        </div>
      </div>
      <div class="filter-row">
        <span class="field-label">状态</span>
        <div class="filter-controls">
          <FilterChipRow
            :model-value="model.status"
            :options="statusOptions"
            all-label="全部"
            @update:model-value="patch({ status: $event as LibraryFilterValues['status'] })"
          />
        </div>
      </div>
      <div class="filter-row">
        <span class="field-label">排序</span>
        <div class="filter-controls">
          <FilterChipRow
            :model-value="model.sort"
            :options="sortOptions"
            all-label="默认"
            :show-all="false"
            @update:model-value="patch({ sort: $event as LibraryFilterValues['sort'] })"
          />
        </div>
      </div>
      <div class="filter-row">
        <span class="field-label">画质</span>
        <div class="filter-controls">
          <FilterChipRow
            :model-value="model.resolution"
            :options="resolutionOptions"
            all-label="全部画质"
            @update:model-value="patch({ resolution: $event })"
          />
        </div>
      </div>
      <div class="filter-row">
        <span class="field-label">规格</span>
        <div class="filter-controls">
          <FilterChipRow
            :model-value="model.codec"
            :options="codecOptions"
            all-label="全部规格"
            scrollable
            @update:model-value="patch({ codec: $event })"
          />
        </div>
      </div>
      <div class="filter-row">
        <span class="field-label">题材</span>
        <div class="filter-controls">
          <FilterChipRow
            :model-value="model.genre"
            :options="genreOptions"
            all-label="全部题材"
            scrollable
            @update:model-value="patch({ genre: $event })"
          />
        </div>
      </div>
      <div class="filter-row">
        <span class="field-label">年份</span>
        <div class="filter-controls">
          <FilterChipRow
            :model-value="model.year"
            :options="yearOptions"
            all-label="全部年份"
            scrollable
            @update:model-value="patch({ year: $event })"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped src="./LibraryFilterPanel.css"></style>
<style scoped src="./library-shared.css"></style>
