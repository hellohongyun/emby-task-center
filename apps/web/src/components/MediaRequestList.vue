<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { MediaRequest, AdminMediaRequest } from "@emby-task-center/contracts/media-request";
import { useMediaRequestApi } from "../composables/media-request-api";
import { requestStatuses, requestStatusLabel } from "../composables/media-request-types";
import MediaRequestCard from "./MediaRequestCard.vue";
import { mediaRequestRetentionNotice } from "../composables/media-request-retention";

const props = defineProps<{ admin?: boolean; requireAuth?: () => void }>();
const api = useMediaRequestApi(props.admin, props.requireAuth);
const items = ref<Array<MediaRequest & Partial<Pick<AdminMediaRequest, "memberEmail">>>>([]);
const total = ref(0);
const page = ref(1);
const status = ref("");
const query = ref("");
const actionMessage = ref("");
const pageSize = 20;
const resultText = computed(() => {
  if (api.error.value) return "暂未取得当前结果";
  return api.busy.value.list ? "正在读取申请…" : `当前筛选共 ${total.value} 条`;
});
async function load(reset = false) {
  if (reset) page.value = 1;
  const params = new URLSearchParams({ page: String(page.value), pageSize: String(pageSize) });
  if (status.value) params.set("status", status.value);
  if (query.value.trim()) params.set("q", query.value.trim());
  const result = await api.run<{ items: typeof items.value; total: number }>(
    "list",
    `${props.admin ? "/api" : "/api/public"}/media-requests?${params}`,
  );
  if (result) {
    items.value = result.items;
    total.value = result.total;
    const lastPage = Math.max(1, Math.ceil(result.total / pageSize));
    if (page.value > lastPage) {
      page.value = lastPage;
      await load();
    }
  }
}
function filter(value: string) {
  actionMessage.value = "";
  status.value = value;
  items.value = [];
  void load(true);
}
function turn(offset: number) {
  page.value += offset;
  items.value = [];
  void load();
}
function applySaved(item?: MediaRequest & Partial<Pick<AdminMediaRequest, "memberEmail">>) {
  if (!item) return void load();
  // A list started before the write must not restore its older snapshot.
  api.cancel("list");
  api.error.value = "";
  actionMessage.value = `已更新《${item.title}》：${requestStatusLabel(item.status)}`;
  const index = items.value.findIndex((entry) => entry.id === item.id);
  if (index < 0) return void load();
  if (status.value && item.status !== status.value) {
    items.value = items.value.filter((entry) => entry.id !== item.id);
    total.value = Math.max(0, total.value - 1);
    const lastPage = Math.max(1, Math.ceil(total.value / pageSize));
    page.value = Math.min(page.value, lastPage);
    if (!items.value.length && total.value > 0) void load();
  } else {
    items.value = items.value.map((entry) => (entry.id === item.id ? item : entry));
  }
}
onMounted(() => void load());
defineExpose({ refresh: () => load(true) });
</script>

<template>
  <section
    class="request-list"
    :class="{ 'admin-list': admin }"
    :aria-label="admin ? '全部求片申请' : '我的求片申请'"
    :aria-busy="Boolean(api.busy.value.list)"
  >
    <header v-if="!admin" class="list-head">
      <div>
        <h2>我的申请</h2>
        <p>{{ resultText }}</p>
      </div>
      <div class="list-head-actions">
        <button class="refresh" type="button" :disabled="api.busy.value.list" @click="load()">刷新</button>
        <slot name="member-actions" />
      </div>
    </header>
    <p v-if="!admin" class="retention-note">{{ mediaRequestRetentionNotice }}</p>
    <div class="list-controls">
      <div class="status-filters" role="group" aria-label="处理状态筛选">
        <button type="button" :aria-pressed="status === ''" :class="{ active: status === '' }" @click="filter('')">
          全部
        </button>
        <button
          v-for="entry in requestStatuses"
          :key="entry.value"
          type="button"
          :data-status="entry.value"
          :aria-pressed="status === entry.value"
          :class="{ active: status === entry.value }"
          @click="filter(entry.value)"
        >
          <span class="status-dot" aria-hidden="true"></span>{{ entry.label }}
        </button>
      </div>
      <form class="filters" role="search" @submit.prevent="load(true)">
        <label
          ><span class="sr-only">{{ admin ? "搜索作品或会员邮箱" : "搜索申请作品" }}</span
          ><input
            v-model="query"
            type="search"
            maxlength="200"
            :placeholder="admin ? '搜索片名或会员邮箱' : '搜索我的申请'"
            enterkeyhint="search" /></label
        ><button type="submit">搜索</button>
      </form>
    </div>
    <header v-if="admin" class="admin-results">
      <h2 class="sr-only">全部申请</h2>
      <p class="result-count">{{ resultText }}</p>
      <p class="retention-note">{{ mediaRequestRetentionNotice }}</p>
      <button class="refresh" type="button" :disabled="api.busy.value.list" @click="load()">刷新</button>
    </header>
    <p v-if="api.error.value" class="error" role="alert">{{ api.error.value }}</p>
    <p v-if="actionMessage" class="action-result" role="status">{{ actionMessage }}</p>
    <p v-if="api.busy.value.list && !items.length" class="empty" role="status">正在加载申请…</p>
    <div v-else-if="!items.length && !api.error.value" class="empty">
      <strong>暂无符合条件的申请</strong>
      <p>
        {{
          status || query
            ? "试试其他状态或片名。"
            : admin
              ? "会员提交求片后，会在这里显示。"
              : "提交想看的作品后，可在这里查看进度。"
        }}
      </p>
    </div>
    <div class="cards">
      <MediaRequestCard
        v-for="item in items"
        :key="item.id"
        :item="item"
        :admin="admin"
        :require-auth="requireAuth"
        @saved="applySaved"
        @refresh="load()"
      />
    </div>
    <footer v-if="total > (admin ? 0 : pageSize) && !api.error.value" class="pagination">
      <span>第 {{ page }} / {{ Math.max(1, Math.ceil(total / pageSize)) }} 页</span>
      <div>
        <button type="button" :disabled="page <= 1 || api.busy.value.list" @click="turn(-1)">上一页</button
        ><button type="button" :disabled="page * pageSize >= total || api.busy.value.list" @click="turn(1)">
          下一页
        </button>
      </div>
    </footer>
  </section>
</template>

<style scoped src="./MediaRequestList.css"></style>
<style scoped src="./MediaRequestList.admin.css"></style>
