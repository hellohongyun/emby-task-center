<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import ConcurrencyPolicyPanel from "./ConcurrencyPolicyPanel.vue";

// 「全局通知收件人」随「任务更新通知」整条链删除（2026-09）：那条邮件链已无发送方，
// 后台不再需要（也不该）提供一个填了不会生效的收件人列表。

const props = defineProps<{
  status: { embyConfigured: boolean; emailConfigured: boolean; emailMissing?: string[] };
  loading: boolean;
  requireAuth?: () => void;
  error?: string;
  testEmby: () => Promise<{ serverName: string; version: string }>;
  testEmail: (email: string) => Promise<unknown>;
}>();
const emit = defineEmits<{ refresh: [] }>();
/**
 * 「未配置」时说清还缺什么：以前只回一个布尔值，配了 SMTP 仍是"未配置"，
 * 用户只能猜自己漏填了哪一项（用户名/口令其实不是必需项）。
 */
const missingEmailFieldsText = computed(() => {
  const missing = props.status.emailMissing ?? [];
  return missing.length > 0 ? missing.join("、") : "SMTP 服务器、SMTP 端口与发件人地址";
});

const message = ref("");
const testAddress = ref("");
const testingEmby = ref(false);
const testingEmail = ref(false);
let stopped = false;
let revision = 0;
onBeforeUnmount(() => {
  stopped = true;
  revision += 1;
});

onMounted(() => emit("refresh"));

// 注意：本地包装函数不能与同名 prop 重名（vue/no-dupe-keys：模板里会遮蔽 prop，调用语义含糊）。
async function runTestEmby() {
  if (testingEmby.value || stopped) return;
  testingEmby.value = true;
  const current = ++revision;
  try {
    const result = await props.testEmby();
    if (stopped || current !== revision) return;
    message.value = `Emby 连接成功：${result.serverName} ${result.version}`;
  } catch (error) {
    if (!stopped && current === revision && (error as Error).name !== "AbortError")
      message.value = `Emby 测试失败：${(error as Error).message}`;
  } finally {
    if (!stopped) testingEmby.value = false;
  }
}
async function runTestEmail() {
  if (!testAddress.value.trim() || testingEmail.value || stopped) return;
  const address = testAddress.value.trim();
  testingEmail.value = true;
  const current = ++revision;
  try {
    await props.testEmail(address);
    if (stopped || current !== revision) return;
    message.value = `测试邮件已发送到 ${address}`;
  } catch (error) {
    if (!stopped && current === revision && (error as Error).name !== "AbortError")
      message.value = `邮件测试失败：${(error as Error).message}`;
  } finally {
    if (!stopped) testingEmail.value = false;
  }
}
</script>

<template>
  <section class="settings-view" aria-labelledby="settings-title">
    <header>
      <div>
        <h2 id="settings-title">连接与自检</h2>
        <p>Emby / 邮件的连接状态与测试；密钥与参数在下面的「配置项」里维护。</p>
      </div>
      <button type="button" @click="emit('refresh')">刷新</button>
    </header>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <p v-if="message" class="notice" role="status">{{ message }}</p>

    <div class="credential-grid">
      <article>
        <small>Emby API</small>
        <strong :class="{ ok: status.embyConfigured }">{{ status.embyConfigured ? "已配置" : "未配置" }}</strong>
        <span>EMBY_API_KEY</span>
        <button type="button" :disabled="!status.embyConfigured || testingEmby" @click="runTestEmby">
          {{ testingEmby ? "测试中…" : "测试连接" }}
        </button>
      </article>
      <article>
        <small>邮件服务</small>
        <strong :class="{ ok: status.emailConfigured }">{{ status.emailConfigured ? "已配置" : "未配置" }}</strong>
        <span v-if="status.emailConfigured">SMTP 参数见下方「邮件通知」配置项</span>
        <span v-else class="missing-hint">还缺：{{ missingEmailFieldsText }}</span>
        <form class="mail-test" @submit.prevent="runTestEmail">
          <input v-model.trim="testAddress" type="email" required placeholder="测试收件邮箱" /><button
            type="submit"
            :disabled="!status.emailConfigured || testingEmail"
          >
            {{ testingEmail ? "发送中…" : "发送测试" }}
          </button>
        </form>
      </article>
      <article>
        <small>入库方式</small>
        <strong class="ok">媒体库以 Emby 为准</strong>
        <span>入库由外部流程完成，本应用只负责扫描 Emby 并发通知</span>
      </article>
    </div>

    <ConcurrencyPolicyPanel :require-auth="requireAuth" />
  </section>
</template>

<style scoped>
.settings-view {
  max-width: 1080px;
  margin: 0 auto;
}
.settings-view > header,
.section-title {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
}
.settings-view > header {
  margin: 10px 0 22px;
}
.settings-view > header span {
  color: #68bf6a;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.14em;
}
h1 {
  margin: 5px 0;
  font-size: 30px;
}
h2 {
  margin: 0;
  font-size: 18px;
}
p {
  color: #84929c;
}
.settings-view > header p,
.section-title p {
  margin: 3px 0 0;
}
.settings-view button {
  min-height: 42px;
  padding: 0 14px;
  border: 1px solid #31454f;
  border-radius: 7px;
  color: #cad3d8;
  background: #101d25;
  cursor: pointer;
}
.credential-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}
.credential-grid article {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 18px;
  border: 1px solid #20323c;
  border-radius: 10px;
  background: #0b161d;
}
.credential-grid small,
.credential-grid span {
  color: #82909a;
  font-size: 12px;
}
.credential-grid strong {
  font-size: 18px;
  color: #e4a46d;
}
.credential-grid strong.ok {
  color: #74cd77;
}
.credential-grid .missing-hint {
  color: #d9a45b;
}
.mail-test {
  display: flex;
  gap: 6px;
}
.mail-test input {
  min-width: 0;
  min-height: 40px;
  padding: 0 9px;
  border: 1px solid #2a3d48;
  border-radius: 6px;
  color: #eef2f4;
  background: #101e27;
}
.mail-test button {
  padding: 0 9px;
}
.list {
  margin-top: 14px;
  padding: 18px;
  border: 1px solid #20323c;
  border-radius: 10px;
  background: #0a151c;
}
@media (max-width: 700px) {
  .credential-grid {
    grid-template-columns: 1fr;
  }
  .settings-view > header {
    align-items: flex-start;
  }
  .list {
    padding: 14px;
  }
}
</style>
