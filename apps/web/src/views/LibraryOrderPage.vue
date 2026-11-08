<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import { mdiArrowDown, mdiArrowUp, mdiDragVertical, mdiRefresh, mdiSortVariant } from "@mdi/js";

import { accountLabel, formatTime, kindLabel, previewOrders, rowMessage, statusLabels } from "./LibraryOrderPageData";
import { useLibraryOrderPage } from "./LibraryOrderPageState";

const {
  libraryRows,
  hasSavedOrder,
  users,
  updatedAt,
  preview,
  results,
  operation,
  error,
  message,
  scope,
  testUserId,
  previewOnlyChanges,
  search,
  dragging,
  resultHeading,
  dirty,
  dirtyReason,
  filtering,
  filteredRows,
  syncAction,
  previewWarnings,
  previewRows,
  proxyStatus,
  isNew,
  clearPreview,
  load,
  save,
  previewOrder,
  apply,
  moveTo,
  resetOrder,
  dragStart,
  drop,
  onScopeChange,
} = useLibraryOrderPage();
</script>

<template>
  <section class="library-order-page" aria-label="媒体库顺序" :aria-busy="Boolean(operation)">
    <header class="page-head">
      <div class="page-title">
        <span class="title-icon" aria-hidden="true"><SvgIcon type="mdi" :path="mdiSortVariant" :size="22" /></span>
        <div>
          <h1>媒体库顺序</h1>
          <p>统一排列 Emby 媒体库和本项目虚拟库。确认同步后，直连和反代按账号可见范围展示。</p>
        </div>
      </div>
      <div class="head-actions">
        <button type="button" class="button ghost" :disabled="Boolean(operation)" @click="load">
          <SvgIcon type="mdi" :path="mdiRefresh" :size="18" />刷新
        </button>
        <button
          type="button"
          class="button primary"
          :disabled="Boolean(operation) || !libraryRows.length"
          @click="previewOrder"
        >
          {{ operation === "preview" ? "正在生成预览…" : "保存并预览" }}
        </button>
      </div>
    </header>

    <p v-if="message" class="message" role="status">{{ message }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div v-if="operation === 'load'" class="loading" role="status">正在读取 Emby 媒体库和账号…</div>

    <div v-if="libraryRows.length" class="layout">
      <section class="panel order-panel" aria-labelledby="order-heading">
        <header class="panel-head">
          <div>
            <h2 id="order-heading">全部媒体库</h2>
            <p class="muted">
              {{ libraryRows.length }} 个库 · {{ formatTime(updatedAt) }}
              <span v-if="dirty" class="dirty">{{ dirtyReason }}</span>
            </p>
          </div>
          <div class="panel-actions">
            <button
              type="button"
              class="button ghost compact"
              :disabled="Boolean(operation) || !dirty"
              @click="resetOrder"
            >
              撤销修改
            </button>
            <button
              type="button"
              class="button ghost compact"
              :disabled="Boolean(operation) || (!dirty && hasSavedOrder)"
              @click="save"
            >
              保存顺序
            </button>
          </div>
        </header>
        <div class="list-tools">
          <input v-model="search" type="search" placeholder="搜索媒体库名称" aria-label="搜索媒体库" />
          <span class="muted">{{ filteredRows.length }} / {{ libraryRows.length }}</span>
        </div>
        <p class="hint">
          拖动行，或使用上移、下移按钮调整顺序。保存为草稿，确认同步后生效。
          <span v-if="filtering">清空搜索后可继续排序。</span>
        </p>
        <p v-if="!filteredRows.length" class="muted no-match">没有匹配的媒体库。</p>
        <ol v-else class="library-list" role="list">
          <li
            v-for="entry in filteredRows"
            :key="entry.library.id"
            :class="{ dragging: dragging === entry.index }"
            :draggable="!filtering && !operation"
            @dragstart="dragStart(entry.index, $event)"
            @dragover.prevent
            @drop="drop(entry.index, $event)"
            @dragend="dragging = null"
          >
            <span class="drag-handle" aria-hidden="true"
              ><SvgIcon type="mdi" :path="mdiDragVertical" :size="20"
            /></span>
            <span class="order-index">{{ entry.index + 1 }}</span>
            <div class="library-meta">
              <strong>{{ entry.library.name }}</strong>
              <div class="tags">
                <span :class="['tag', entry.library.kind]">{{ kindLabel(entry.library.kind) }}</span>
                <span class="tag">{{ entry.library.visibleUsers }} 个账号可见</span>
                <span v-if="isNew(entry.library)" class="tag new">新增</span>
                <span v-if="entry.library.kind !== 'owned' && !entry.library.inOrderedViews" class="tag warn">
                  尚未写入 Emby 顺序
                </span>
              </div>
            </div>
            <div class="row-actions">
              <button
                type="button"
                class="icon-button"
                :aria-label="`上移 ${entry.library.name}`"
                :disabled="Boolean(operation) || filtering || entry.index === 0"
                @click="moveTo(entry.index, entry.index - 1)"
              >
                <SvgIcon type="mdi" :path="mdiArrowUp" :size="18" />
              </button>
              <button
                type="button"
                class="icon-button"
                :aria-label="`下移 ${entry.library.name}`"
                :disabled="Boolean(operation) || filtering || entry.index === libraryRows.length - 1"
                @click="moveTo(entry.index, entry.index + 1)"
              >
                <SvgIcon type="mdi" :path="mdiArrowDown" :size="18" />
              </button>
              <button
                type="button"
                class="text-button"
                :disabled="Boolean(operation) || filtering || entry.index === 0"
                @click="moveTo(entry.index, 0)"
              >
                置顶
              </button>
              <button
                type="button"
                class="text-button"
                :disabled="Boolean(operation) || filtering || entry.index === libraryRows.length - 1"
                @click="moveTo(entry.index, libraryRows.length - 1)"
              >
                置底
              </button>
            </div>
          </li>
        </ol>
      </section>

      <aside class="side">
        <section class="panel scope-panel" aria-labelledby="scope-heading">
          <h2 id="scope-heading">同步范围</h2>
          <label class="field">
            账号
            <select v-model="scope" :disabled="Boolean(operation)" @change="onScopeChange">
              <option value="all">全部账号（{{ users.length }}）</option>
              <option value="one">仅测试账号</option>
            </select>
          </label>
          <label v-if="scope === 'one'" class="field">
            测试账号
            <select v-model="testUserId" :disabled="Boolean(operation)" @change="onScopeChange">
              <option v-for="user in users" :key="user.id" :value="user.id">{{ accountLabel(user) }}</option>
            </select>
          </label>
          <p class="muted">测试账号只验证直连 Emby 的写入。确认同步全部账号后，管理员顺序在反代中优先显示。</p>
          <p class="muted">{{ proxyStatus }}。</p>
        </section>

        <section v-if="previewWarnings.length" class="panel warning-panel" aria-label="同步提示">
          <h2>同步提示</h2>
          <ul>
            <li v-for="(warning, index) in previewWarnings" :key="index">{{ warning }}</li>
          </ul>
        </section>
      </aside>
    </div>

    <section v-if="results" class="panel result-panel" aria-labelledby="result-heading">
      <header class="panel-head">
        <div>
          <h2 id="result-heading" ref="resultHeading" tabindex="-1">同步结果</h2>
          <p class="muted">原生 Emby 逐账号同步结果</p>
          <p v-if="results.proxyActivated" class="muted">反代已启用管理员顺序。</p>
          <p v-else-if="scope === 'one'" class="muted">本次为直连测试。反代继续使用当前设置。</p>
          <p v-else class="muted">{{ rowMessage(results.proxyReason ?? "library_order_proxy_save_failed") }}</p>
        </div>
        <button type="button" class="button ghost compact" @click="clearPreview">完成</button>
      </header>
      <ul class="counts" aria-label="结果汇总">
        <li
          v-for="status in ['updated', 'unchanged', 'skipped', 'failed'] as const"
          :key="status"
          :data-status="status"
        >
          {{ statusLabels[status] }} {{ results.users.filter((row) => row.status === status).length }}
        </li>
      </ul>
      <ul class="account-list">
        <li v-for="row in results.users" :key="row.id">
          <div class="account-line">
            <strong>{{ row.name }}</strong>
            <span v-if="row.isAdministrator" class="tag">管理员</span>
            <span v-if="row.isDisabled" class="tag">停用</span>
            <span :class="['status', row.status]">{{ statusLabels[row.status] }}</span>
          </div>
          <p v-if="row.reason" class="muted">{{ rowMessage(row.reason) }}</p>
        </li>
      </ul>
    </section>

    <section v-else-if="preview" class="panel preview-panel" aria-labelledby="preview-heading">
      <header class="panel-head">
        <div>
          <h2 id="preview-heading">同步预览</h2>
          <p class="muted">
            模板含 {{ preview.libraries.length }} 个库，预览 {{ preview.users.length }} 个原生 Emby 账号。
          </p>
          <p v-if="preview.proxyChanged" class="muted">确认后，反代将启用本次管理员顺序。</p>
          <p v-else-if="scope === 'one'" class="muted">仅测试直连 Emby，反代继续使用当前设置。</p>
          <p v-else class="muted">反代已使用本次管理员顺序。</p>
        </div>
        <button
          type="button"
          class="button primary"
          :disabled="!syncAction.enabled || Boolean(operation)"
          @click="apply"
        >
          {{ operation === "apply" ? "正在同步…" : syncAction.label }}
        </button>
      </header>
      <ul class="counts" aria-label="原生 Emby 预览汇总">
        <li v-for="status in ['change', 'unchanged', 'skipped', 'failed'] as const" :key="status" :data-status="status">
          {{ statusLabels[status] }} {{ preview.users.filter((row) => row.status === status).length }}
        </li>
      </ul>
      <div class="preview-filter-row">
        <label class="preview-filter">
          <input v-model="previewOnlyChanges" type="checkbox" />
          只看待同步
        </label>
        <span class="muted">共 {{ preview.users.length }} 个账号，显示 {{ previewRows.length }} 个</span>
      </div>
      <p v-if="!previewRows.length" class="muted">
        {{ previewOnlyChanges ? "没有待同步的账号。" : "没有可同步的账号。" }}
      </p>
      <ul v-else class="account-list preview-list">
        <li v-for="row in previewRows" :key="row.id">
          <div class="account-line">
            <strong>{{ row.name }}</strong>
            <span v-if="row.isAdministrator" class="tag">管理员</span>
            <span v-if="row.isDisabled" class="tag">停用</span>
            <span :class="['status', row.status]">{{ statusLabels[row.status] }}</span>
          </div>
          <p v-if="row.reason" class="muted">{{ rowMessage(row.reason) }}</p>
          <details v-for="order in previewOrders(row)" :key="order.label">
            <summary>{{ order.label }}</summary>
            <div class="comparison">
              <div>
                <h3>同步前</h3>
                <ol v-if="order.before?.length">
                  <li v-for="(library, index) in order.before" :key="index">{{ library }}</li>
                </ol>
                <p v-else class="muted">{{ order.before ? "没有可见媒体库" : "当前顺序待客户端核对" }}</p>
              </div>
              <div>
                <h3>同步后</h3>
                <ol v-if="order.after.length">
                  <li v-for="(library, index) in order.after" :key="index">{{ library }}</li>
                </ol>
                <p v-else class="muted">没有可见媒体库</p>
              </div>
            </div>
          </details>
        </li>
      </ul>
    </section>

    <p v-if="operation !== 'load' && !libraryRows.length && !error" class="empty">
      没有读到媒体库。请先在系统设置连接 Emby，或检查 Emby 地址和 API Key。
    </p>
  </section>
</template>

<style scoped src="./LibraryOrderPage.css"></style>
