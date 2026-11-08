<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { AdminMediaRequest, MediaRequest } from "@emby-task-center/contracts/media-request";
import { useMediaRequestApi } from "../composables/media-request-api";
import { requestStatusLabel } from "../composables/media-request-types";

type RequestRow = MediaRequest & Partial<Pick<AdminMediaRequest, "memberEmail">>;
const props = defineProps<{ item: RequestRow; disabled?: boolean; requireAuth?: () => void }>();
const emit = defineEmits<{ saved: [item: RequestRow]; edit: []; refresh: [] }>();
const api = useMediaRequestApi(true, props.requireAuth);
const saving = computed(() => Boolean(api.busy.value.quick));
const blocked = computed(() => props.disabled || saving.value);
const next = computed(() =>
  props.item.status === "pending" ? "processing" : props.item.status === "processing" ? "available" : null,
);
const success = ref("");
const failure = computed(() => api.error.value.replace("请取消编辑并刷新，再重新编辑。", "请刷新申请后重试。"));
watch(
  () => props.item.updatedAt,
  () => {
    api.error.value = "";
    if (success.value !== `已更新为${requestStatusLabel(props.item.status)}`) success.value = "";
  },
);
function edit() {
  if (!blocked.value) emit("edit");
}
async function advance(event: MouseEvent) {
  if (blocked.value || !next.value || event.detail > 1) return;
  success.value = "";
  const result = await api.run<{ request: RequestRow }>("quick", `/api/media-requests/${props.item.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: next.value, adminNote: props.item.adminNote, updatedAt: props.item.updatedAt }),
  });
  if (!result) return;
  success.value = `已更新为${requestStatusLabel(result.request.status)}`;
  emit("saved", result.request);
}
</script>

<template>
  <div class="admin-actions">
    <div class="buttons">
      <button v-if="next" class="quick" type="button" :disabled="blocked" @click="advance">
        {{ saving ? "保存中…" : next === "processing" ? "开始处理" : "标为已入库" }}
      </button>
      <button class="edit" type="button" :disabled="blocked" @click="edit">
        处理申请<span aria-hidden="true"> ›</span>
      </button>
    </div>
    <p v-if="api.error.value" class="error" role="alert">{{ failure }}</p>
    <button v-if="api.error.value && !saving" class="refresh" type="button" @click="emit('refresh')">刷新申请</button>
    <p v-if="success && !api.error.value" class="success" role="status">{{ success }}</p>
  </div>
</template>

<style scoped src="./MediaRequestQuickActions.css"></style>
