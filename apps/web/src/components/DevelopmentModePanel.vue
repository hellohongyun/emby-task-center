<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";
import { fetchJsonWithTimeout } from "../composables/request-timeout";

const props = defineProps<{ requireAuth?: () => void }>();
const emit = defineEmits<{ saved: [] }>();
interface Mode {
  enabled: boolean;
  emailForcedDisabled: boolean;
}
const mode = ref<Mode>({ enabled: false, emailForcedDisabled: false });
const loading = ref(true);
const saving = ref(false);
const loaded = ref(false);
const error = ref("");
const controller = new AbortController();
onBeforeUnmount(() => controller.abort());
async function request(values?: Record<string, boolean>) {
  const { response, body } = await fetchJsonWithTimeout<{
    developmentMode?: Mode;
    rejected?: { key: string; error: string }[];
  }>(
    fetch,
    "/api/settings",
    {
      credentials: "include",
      signal: controller.signal,
      ...(values
        ? { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ values }) }
        : {}),
    },
    15_000,
    true,
  );
  if (controller.signal.aborted) return false;
  if (response.status === 401) {
    props.requireAuth?.();
    throw new Error("登录已过期，请重新登录。");
  }
  if (!response.ok || body?.rejected?.length || !body?.developmentMode)
    throw new Error("无法保存或读取开发调试模式，请刷新后重试。");
  mode.value = body.developmentMode;
  loaded.value = true;
  return true;
}
async function load() {
  loading.value = true;
  error.value = "";
  try {
    await request();
  } catch (caught) {
    if (!controller.signal.aborted) error.value = (caught as Error).message;
  } finally {
    loading.value = false;
  }
}
async function toggle() {
  if (!loaded.value || loading.value || saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    if (await request({ "development.enabled": !mode.value.enabled })) emit("saved");
  } catch (caught) {
    if (!controller.signal.aborted) error.value = (caught as Error).message;
  } finally {
    saving.value = false;
  }
}
onMounted(load);
</script>

<template>
  <section class="development-mode" aria-labelledby="development-mode-title">
    <div class="mode-heading">
      <div>
        <h2 id="development-mode-title">开发调试模式</h2>
        <p>
          {{
            loading
              ? "正在读取…"
              : loaded
                ? mode.enabled
                  ? "已启用：自动写操作已暂停"
                  : "未启用：后台任务按原配置运行"
                : "暂未读取到当前状态"
          }}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        :aria-checked="mode.enabled"
        :disabled="loading || saving || !loaded"
        @click="toggle"
      >
        {{ saving ? "保存中…" : mode.enabled ? "关闭开发调试模式" : "启用开发调试模式" }}
      </button>
    </div>
    <p>
      启用后暂停邮件发送、自动停用／删除／冻结账号及 115
      自动转存；浏览与媒体扫描继续运行。原业务开关保留，关闭后恢复后台任务。
    </p>
    <p v-if="mode.emailForcedDisabled">当前运行环境强制禁发邮件，关闭开发调试模式也不会发送邮件。</p>
    <p v-if="error" role="alert">
      {{ error }} <button type="button" :disabled="loading || saving" @click="load">重新读取</button>
    </p>
  </section>
</template>

<style scoped>
.development-mode {
  max-width: 1136px;
  margin: 22px auto;
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--panel);
}
.mode-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
h2 {
  margin: 0;
  font-size: 18px;
  color: var(--text);
}
p {
  margin: 9px 0 0;
  font-size: 13px;
  color: var(--text-dim);
  line-height: 1.65;
}
button {
  min-height: 44px;
  padding: 10px 16px;
  border: 1px solid var(--line);
  border-radius: 9px;
  color: var(--text);
  background: var(--panel);
  cursor: pointer;
}
button[aria-checked="true"] {
  border-color: var(--accent);
  color: var(--accent);
}
button:disabled {
  opacity: 0.55;
  cursor: default;
}
[role="alert"] {
  color: #f39999;
}
@media (max-width: 700px) {
  .development-mode {
    margin: 16px 14px;
    padding: 16px;
  }
  .mode-heading {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
