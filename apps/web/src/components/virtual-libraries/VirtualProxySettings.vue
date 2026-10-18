<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import type { ProxyState } from "../../composables/useVirtualLibraries";
const props = defineProps<{ state: ProxyState | null; loading: boolean; busy: boolean }>();
const emit = defineEmits<{ save: [config: ProxyState["config"]]; refresh: [] }>();
const config = reactive<ProxyState["config"]>({ enabled: false, upstream: "", port: 8097 });
watch(
  () => props.state,
  (state) => {
    if (state) Object.assign(config, state.config);
  },
  { immediate: true },
);
const address = computed(() => {
  const port = props.state?.status.port;
  return port ? `http://${window.location.hostname}:${port}` : "";
});
</script>

<template>
  <details class="vl-panel vl-proxy" open>
    <summary>
      客户端连接与反代
      <span class="vl-badge" :class="{ running: state?.status.running }">{{
        loading ? "加载中" : state?.status.running ? "运行中" : "未运行"
      }}</span>
    </summary>
    <form @submit.prevent="emit('save', { ...config, upstream: config.upstream.trim() })">
      <p class="vl-muted">客户端连接本服务的反代端口，即可在原有媒体库旁看到新增的虚拟媒体库。</p>
      <div class="vl-fields">
        <label class="vl-upstream"
          >TgtoDrive 的 Emby 反代地址<input
            v-model="config.upstream"
            type="url"
            placeholder="http://你的 TgtoDrive 地址:端口"
            :disabled="loading || !state"
          /><small>填写 Emby 访问地址；留空使用系统设置中的 Emby 地址。</small></label
        >
        <label
          >监听端口<input
            v-model.number="config.port"
            type="number"
            min="1"
            max="65535"
            required
            :disabled="loading || !state"
        /></label>
      </div>
      <label class="vl-checkbox"
        ><input v-model="config.enabled" type="checkbox" :disabled="loading || !state" />启用客户端反代</label
      >
      <p v-if="address" class="vl-address">
        客户端连接地址：<code>{{ address }}</code>
      </p>
      <p v-if="state?.status.error" class="vl-error" role="alert">{{ state.status.error }}</p>
      <p class="vl-muted">跨设备访问时使用服务器局域网 IP 或域名；通过 HTTPS 网关访问时使用网关地址。</p>
      <div class="vl-actions">
        <button class="vl-primary" :disabled="busy || loading || !state">{{ busy ? "保存中…" : "保存反代设置" }}</button
        ><button type="button" :disabled="busy || loading" @click="emit('refresh')">刷新状态</button>
      </div>
    </form>
  </details>
</template>
