<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { MediaRequest, AdminMediaRequest } from "@emby-task-center/contracts/media-request";
import { formatRequestDate, requestStatusLabel } from "../composables/media-request-types";
import MediaRequestEditor from "./MediaRequestEditor.vue";
import MediaRequestQuickActions from "./MediaRequestQuickActions.vue";
import { mediaRequestRemovalTime } from "../composables/media-request-retention";

type RequestRow = MediaRequest & Partial<Pick<AdminMediaRequest, "memberEmail">>;

const props = defineProps<{
  item: RequestRow;
  admin?: boolean;
  requireAuth?: () => void;
}>();
const emit = defineEmits<{ saved: [item?: RequestRow]; refresh: [] }>();
const canonical = ref<RequestRow | null>(null);
const item = computed(() => canonical.value ?? props.item);
const removalTime = computed(() => mediaRequestRemovalTime(item.value));
watch(
  () => props.item,
  (incoming) => {
    if (!canonical.value || incoming.id !== canonical.value.id || incoming.updatedAt >= canonical.value.updatedAt)
      canonical.value = null;
  },
);
const editing = ref(false);
const posterFailed = ref(false);
const expanded = ref(false);
const feedbackExpanded = ref(false);
const season = computed(() =>
  item.value.mediaType === "movie" ? "电影整部" : `S${String(item.value.seasonNumber).padStart(2, "0")}`,
);
const canEdit = computed(() => ["pending", "processing"].includes(item.value.status));
const longDescription = computed(
  () => item.value.description.length > 36 || item.value.description.split("\n").length > 1,
);
const longFeedback = computed(() => item.value.adminNote.length > 36 || item.value.adminNote.split("\n").length > 1);
watch(
  () => item.value.posterUrl,
  () => {
    posterFailed.value = false;
  },
);
function saved(value?: RequestRow) {
  if (value) canonical.value = value;
  editing.value = false;
  emit("saved", value);
}
function refresh() {
  editing.value = false;
  emit("refresh");
}
</script>

<template>
  <article
    class="request-card"
    :class="{ 'admin-card': admin }"
    :aria-label="`${item.title} ${season} ${requestStatusLabel(item.status)}`"
  >
    <div class="work">
      <div class="poster" aria-hidden="true">
        <img
          v-if="item.posterUrl && !posterFailed"
          :src="item.posterUrl"
          alt=""
          loading="lazy"
          @error="posterFailed = true"
        />
        <span v-else class="poster-placeholder"
          ><span class="film-mark">▤</span>{{ item.mediaType === "movie" ? "电影" : "剧集" }}</span
        >
      </div>
      <div class="work-info">
        <div class="title-row">
          <h3 :title="item.title">{{ item.title }}</h3>
          <span class="status" :data-status="item.status">{{ requestStatusLabel(item.status) }}</span>
        </div>
        <div class="badges">
          <strong>{{ season }}</strong
          ><span>{{ item.kind === "supplement" ? "补集" : "求片" }}</span
          ><span>{{ item.releaseYear ?? "年份未知" }}</span>
        </div>
        <p v-if="admin" class="requester"><span>申请会员</span> {{ item.memberEmail }}</p>
        <p v-else class="submitted">{{ new Date(item.createdAt).toLocaleDateString() }} 提交</p>
      </div>
    </div>
    <div class="request-copy">
      <p class="copy-label">{{ item.kind === "supplement" ? "缺集说明" : "申请说明" }}</p>
      <p class="description" :class="{ clamped: !expanded && (!admin || longDescription) }">
        {{ item.description || "未填写申请说明" }}
      </p>
      <button
        v-if="longDescription"
        class="expand"
        type="button"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        {{ expanded ? "收起说明" : "展开说明" }}
      </button>
    </div>
    <div v-if="item.adminNote" class="feedback">
      <p class="copy-label">管理员反馈</p>
      <p :class="{ clamped: !feedbackExpanded && (!admin || longFeedback) }">{{ item.adminNote }}</p>
      <button
        v-if="longFeedback"
        class="expand"
        type="button"
        :aria-expanded="feedbackExpanded"
        @click="feedbackExpanded = !feedbackExpanded"
      >
        {{ feedbackExpanded ? "收起反馈" : "展开反馈" }}
      </button>
    </div>
    <footer :class="{ 'admin-footer': admin }">
      <details class="metadata">
        <summary>申请详情</summary>
        <dl>
          <dt>作品</dt>
          <dd>{{ item.title }}</dd>
          <template v-if="item.originalTitle && item.originalTitle !== item.title"
            ><dt>原名</dt>
            <dd>{{ item.originalTitle }}</dd></template
          >
          <dt>申请编号</dt>
          <dd>#{{ item.id }}</dd>
          <dt>TMDB</dt>
          <dd>{{ item.tmdbId }}</dd>
          <dt>提交时间</dt>
          <dd>{{ formatRequestDate(item.createdAt) }}</dd>
          <dt>更新时间</dt>
          <dd>{{ formatRequestDate(item.updatedAt) }}</dd>
          <template v-if="removalTime && item.availableAt">
            <dt>已入库时间</dt>
            <dd>{{ formatRequestDate(item.availableAt) }}</dd>
            <dt>自动删除时间</dt>
            <dd>{{ formatRequestDate(removalTime) }}</dd>
          </template>
        </dl>
      </details>
      <button v-if="!admin && canEdit" class="process" type="button" @click="editing = true">
        补充说明<span aria-hidden="true"> ›</span>
      </button>
      <MediaRequestQuickActions
        v-if="admin"
        :item="item"
        :disabled="editing"
        :require-auth="requireAuth"
        @saved="saved"
        @edit="editing = true"
        @refresh="refresh"
      />
    </footer>
    <MediaRequestEditor
      v-if="editing"
      :item="item"
      :admin="admin"
      :require-auth="requireAuth"
      @close="editing = false"
      @saved="saved"
      @refresh="refresh"
    />
  </article>
</template>

<style scoped src="./MediaRequestCard.css"></style>
<style scoped src="./MediaRequestCard.admin.css"></style>
