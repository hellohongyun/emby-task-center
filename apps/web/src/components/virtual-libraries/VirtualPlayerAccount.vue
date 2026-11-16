<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { MarketDefaults } from "@emby-task-center/contracts/virtual-library-market";
import { virtualLibraryRequests } from "../../composables/virtual-library-requests";

const props = defineProps<{ requireAuth: () => void; pendingChanges?: boolean }>();
const emit = defineEmits<{ saved: [] }>();
const api = virtualLibraryRequests(props.requireAuth, "/api/virtual-library-market");
const accounts = virtualLibraryRequests(props.requireAuth, "/api/emby");
const loading = ref(false);
const accountsLoading = ref(false);
const busy = ref(false);
const ready = ref(false);
const expanded = ref(false);
const selected = ref<string | null>(null);
const saved = ref<string | null>(null);
const users = ref<{ id: string; name: string }[]>([]);
const notice = ref("");
const dirty = computed(() => selected.value !== saved.value);
const name = computed(() => users.value.find((user) => user.id === saved.value)?.name ?? "当前绑定账号");
async function load() {
  ready.value = false;
  const [settings, result] = await Promise.all([
    api.run<MarketDefaults>("binding", loading, "/defaults"),
    accounts.run<{ users: { id: string; name: string }[] }>("users", accountsLoading, "/users"),
  ]);
  if (result) users.value = result.users;
  if (settings) {
    saved.value = selected.value = settings.adminEmbyUserId;
    ready.value = true;
  }
}
async function save() {
  if (!ready.value || !dirty.value || props.pendingChanges) return;
  const result = await api.run<MarketDefaults>("binding", busy, "/defaults", {
    method: "PATCH",
    body: JSON.stringify({ adminEmbyUserId: selected.value }),
  });
  if (!result) return;
  saved.value = selected.value = result.adminEmbyUserId;
  notice.value = saved.value ? "播放器账号已绑定，相关列表已重新读取。" : "已解除绑定，其他用户的设置保持不变。";
  expanded.value = false;
  emit("saved");
}
onMounted(load);
</script>

<template>
  <section class="vm-section vm-account" aria-label="管理员播放器账号" :aria-busy="loading || busy">
    <div class="vm-section-head">
      <div>
        <span class="vm-status" :class="ready && saved ? 'good' : 'warn'">{{
          loading ? "读取中" : !ready ? "状态未读取" : saved ? "已绑定" : "尚未绑定"
        }}</span>
        <strong
          >管理员播放器账号<span v-if="ready && saved"> · {{ name }}</span></strong
        >
        <p>
          {{
            ready && saved
              ? "我的订阅和个人顺序会应用到这个 Emby 账号。"
              : "先绑定 Emby 账号，管理员自己的库、订阅和排序才能对应到播放器。"
          }}
        </p>
      </div>
      <button type="button" :aria-expanded="expanded" :disabled="loading || busy" @click="expanded = !expanded">
        {{ expanded ? "收起" : saved ? "更换账号" : "绑定账号" }}
      </button>
    </div>
    <div v-if="expanded" class="vm-account-form">
      <label class="vm-field"
        >用于播放器的 Emby 账号<select v-model="selected" :disabled="loading || accountsLoading || busy || !ready">
          <option :value="null">未绑定</option>
          <option v-if="selected && !users.some((user) => user.id === selected)" :value="selected">当前绑定账号</option>
          <option v-for="user in users" :key="user.id" :value="user.id">{{ user.name }}</option>
        </select></label
      >
      <p>此设置只对应管理员自己的播放器，不改变新用户默认库，也不授予他人私人库的访问权。</p>
      <p v-if="pendingChanges" class="vm-feedback" role="status">
        当前页面有未保存的更改，请先保存或撤销，再更换播放器账号。
      </p>
      <div class="vm-actions">
        <button
          class="vm-button-primary"
          type="button"
          :disabled="!ready || !dirty || loading || busy || pendingChanges"
          @click="save"
        >
          {{ busy ? "正在保存…" : "保存播放器账号" }}
        </button>
        <button type="button" :disabled="loading || busy || dirty" @click="load">重新读取</button>
        <button v-if="dirty" type="button" :disabled="busy" @click="selected = saved">撤销选择</button>
      </div>
    </div>
    <p v-if="api.error.value || accounts.error.value" class="vl-error" role="alert">
      {{ api.error.value || accounts.error.value }}
    </p>
    <p v-if="notice" class="vm-feedback" role="status">{{ notice }}</p>
  </section>
</template>
