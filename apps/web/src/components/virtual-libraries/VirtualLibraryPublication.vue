<script setup lang="ts">
import { ref } from "vue";
import type { VirtualLibrary } from "@emby-task-center/contracts/virtual-library";
import { virtualLibraryRequests } from "../../composables/virtual-library-requests";
const props = defineProps<{ library: VirtualLibrary; personal?: boolean; requireAuth: () => void }>();
const emit = defineEmits<{ saved: [library: VirtualLibrary] }>();
const busy = ref(false);
const notice = ref("");
const base = props.personal ? "/api/public/virtual-library-market" : "/api/virtual-library-market";
const { run, error } = virtualLibraryRequests(props.requireAuth, base);
async function toggle() {
  const result = await run<{ library: VirtualLibrary }>(
    "publication",
    busy,
    `/owned/${encodeURIComponent(props.library.id)}/publication`,
    {
      method: "PUT",
      body: JSON.stringify({ published: !props.library.published }),
    },
  );
  if (result) {
    notice.value = result.library.published
      ? "已上架，其他用户可以在市场选择启用。"
      : "已下架，其他用户的访问已撤销，你自己的库保留。";
    emit("saved", result.library);
  }
}
</script>
<template>
  <section
    class="vl-panel vm-publication"
    :class="{ published: library.published }"
    aria-label="市场分享"
    :aria-busy="busy"
  >
    <div class="vl-section-head">
      <div>
        <span class="vm-status" :class="library.published ? 'good' : 'muted'">{{
          library.published ? "公开分享已开启" : "公开分享已关闭"
        }}</span>
        <h3>{{ library.published ? "已上架市场" : "未上架，仅自己使用" }}</h3>
      </div>
      <button :class="library.published ? 'vl-danger' : 'vl-primary'" type="button" :disabled="busy" @click="toggle">
        {{ busy ? "正在保存…" : library.published ? "下架市场" : "上架市场" }}
      </button>
    </div>
    <p class="vl-muted">
      {{
        library.published
          ? "名称、海报和影片修改会同步给所有启用者。下架后，其他用户立即失去访问，你自己的库和影片关联保留。"
          : "只有自己能在播放器看到。上架后，其他用户可以自主启用，仍不能修改你的库。"
      }}
    </p>
    <p v-if="notice" class="vm-feedback" role="status">{{ notice }}</p>
    <p v-if="error" class="vl-error" role="alert">{{ error }}</p>
  </section>
</template>
