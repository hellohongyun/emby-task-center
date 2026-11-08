<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from "vue";
import type { MediaRequest, AdminMediaRequest, MediaRequestStatus } from "@emby-task-center/contracts/media-request";
import { useMediaRequestApi } from "../composables/media-request-api";
import { useDialogFocus } from "../composables/useDialogFocus";
import { requestStatuses } from "../composables/media-request-types";

const props = defineProps<{
  item: MediaRequest & Partial<Pick<AdminMediaRequest, "memberEmail">>;
  admin?: boolean;
  requireAuth?: () => void;
}>();
const emit = defineEmits<{
  close: [];
  saved: [item?: MediaRequest & Partial<Pick<AdminMediaRequest, "memberEmail">>];
  refresh: [];
}>();
const api = useMediaRequestApi(props.admin, props.requireAuth);
const status = ref<MediaRequestStatus>(props.item.status);
const note = ref(props.admin ? props.item.adminNote : props.item.description);
const expected = props.item.updatedAt;
const titleId = `request-editor-${props.item.id}`;
const season = computed(() =>
  props.item.mediaType === "movie" ? "电影整部" : `S${String(props.item.seasonNumber).padStart(2, "0")}`,
);
const saving = computed(() => Boolean(api.busy.value.save));
const descriptionExpanded = ref(false);
function close() {
  if (!saving.value) emit("close");
}
const focus = useDialogFocus(close);
const surface = focus.surface;
let previousOverflow = "";
onMounted(() => {
  previousOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  focus.activate();
});
onBeforeUnmount(() => {
  document.body.style.overflow = previousOverflow;
  focus.deactivate();
});
async function save() {
  if (saving.value) return;
  const result = await api.run<{ request: MediaRequest & Partial<Pick<AdminMediaRequest, "memberEmail">> }>(
    "save",
    `${props.admin ? "/api" : "/api/public"}/media-requests/${props.item.id}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        props.admin
          ? { status: status.value, adminNote: note.value, updatedAt: expected }
          : { description: note.value, updatedAt: expected },
      ),
    },
  );
  if (result) emit("saved", result.request);
}
</script>

<template>
  <Teleport to="body">
    <div class="request-dialog-backdrop" @click.self="close">
      <section
        ref="surface"
        class="request-dialog"
        :class="{ 'admin-editor': admin }"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        @keydown="focus.onKeydown"
      >
        <header class="dialog-header">
          <div>
            <p>{{ admin ? "处理申请" : "补充说明" }} · {{ season }}</p>
            <h2 :id="titleId">{{ item.title }}</h2>
          </div>
          <button class="close" type="button" aria-label="关闭申请编辑" :disabled="saving" @click="close">×</button>
        </header>
        <form @submit.prevent="save">
          <div class="dialog-body">
            <div class="context">
              <p v-if="admin" class="member-context"><span>申请会员</span> {{ item.memberEmail }}</p>
              <p :class="{ 'description-preview': admin && !descriptionExpanded }">
                <span>{{ item.kind === "supplement" ? "缺集说明" : "申请说明" }}</span>
                {{ item.description || "未填写说明" }}
              </p>
              <button
                v-if="admin && item.description"
                type="button"
                class="expand-description"
                :aria-expanded="descriptionExpanded"
                @click="descriptionExpanded = !descriptionExpanded"
              >
                {{ descriptionExpanded ? "收起说明" : "展开说明" }}
              </button>
              <small v-if="!admin"
                >{{ item.releaseYear ?? "年份未知" }} · {{ item.kind === "supplement" ? "补集" : "求片" }} · TMDB
                {{ item.tmdbId }} · #{{ item.id }}</small
              >
            </div>
            <fieldset :disabled="saving">
              <legend class="sr-only">{{ admin ? "更新处理结果" : "修改申请说明" }}</legend>
              <fieldset v-if="admin" class="status-choices">
                <legend>处理状态</legend>
                <div class="status-grid">
                  <label
                    v-for="entry in requestStatuses"
                    :key="entry.value"
                    :class="['status-choice', { selected: status === entry.value }]"
                  >
                    <input v-model="status" type="radio" :name="`request-status-${item.id}`" :value="entry.value" />
                    <span>{{ entry.label }}</span>
                  </label>
                </div>
              </fieldset>
              <label
                >{{ admin ? "给会员的反馈" : "申请说明"
                }}<textarea
                  v-model="note"
                  :rows="admin ? 3 : 4"
                  maxlength="2000"
                  :required="!admin && item.kind === 'supplement'"
                  :placeholder="admin ? '例如已补齐，或说明暂无法提供的原因' : '填写集号、版本或其他需要补充的内容'"
                />
              </label>
            </fieldset>
            <details v-if="admin" class="request-details">
              <summary>作品与申请详情</summary>
              <dl>
                <div>
                  <dt>作品</dt>
                  <dd>{{ item.title }}</dd>
                </div>
                <div v-if="item.originalTitle">
                  <dt>原名</dt>
                  <dd>{{ item.originalTitle }}</dd>
                </div>
                <div>
                  <dt>范围</dt>
                  <dd>
                    {{ season }} · {{ item.releaseYear ?? "年份未知" }} ·
                    {{ item.kind === "supplement" ? "补集" : "求片" }}
                  </dd>
                </div>
                <div>
                  <dt>标识</dt>
                  <dd>TMDB {{ item.tmdbId }} · 申请 #{{ item.id }}</dd>
                </div>
              </dl>
            </details>
            <p v-if="api.error.value" class="error" role="alert">{{ api.error.value }}</p>
            <button v-if="api.error.value && !saving" class="recover" type="button" @click="emit('refresh')">
              取消编辑并刷新
            </button>
          </div>
          <footer class="dialog-actions">
            <button type="button" :disabled="saving" @click="close">取消</button
            ><button class="primary" type="submit" :disabled="saving">{{ saving ? "保存中…" : "保存" }}</button>
          </footer>
        </form>
      </section>
    </div>
  </Teleport>
</template>

<style scoped src="./MediaRequestEditor.css"></style>
<style scoped src="./MediaRequestEditor.status.css"></style>
