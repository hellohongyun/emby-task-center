<script setup lang="ts">
import { EMAIL_SCENES, type EmailScene } from "@emby-task-center/contracts/email-scenes";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { EmailPreview } from "../composables/useIntegrations";

const props = defineProps<{
  scene: EmailScene;
  previewEmail: (scene: EmailScene) => Promise<EmailPreview>;
  cancelEmailPreview: () => void;
}>();

const preview = ref<EmailPreview | null>(null);
const loading = ref(false);
const error = ref("");
let revision = 0;

const previewPolicy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">`;
const previewDocument = computed(() => {
  const html = preview.value?.html ?? "";
  const head = /<head(?:\s[^>]*)?>/i;
  return head.test(html) ? html.replace(head, (tag) => tag + previewPolicy) : previewPolicy + html;
});

function reset() {
  revision += 1;
  props.cancelEmailPreview();
  preview.value = null;
  loading.value = false;
  error.value = "";
}

watch(() => props.scene, reset, { flush: "sync" });
onBeforeUnmount(reset);

async function loadPreview() {
  if (loading.value) return;
  const current = ++revision;
  preview.value = null;
  error.value = "";
  loading.value = true;
  try {
    const result = await props.previewEmail(props.scene);
    if (current === revision) preview.value = result;
  } catch (caught) {
    if (current === revision && (caught as Error).name !== "AbortError") {
      error.value = "无法加载邮件预览，请重试。";
    }
  } finally {
    if (current === revision) loading.value = false;
  }
}
</script>

<template>
  <section class="email-preview" aria-labelledby="email-preview-heading" :aria-busy="loading">
    <header>
      <div>
        <h3 id="email-preview-heading">邮件模板预览</h3>
        <p>使用示例数据预览「{{ EMAIL_SCENES[scene] }}」。</p>
      </div>
      <div class="email-preview-actions">
        <button type="button" :disabled="loading" @click="loadPreview">
          {{ loading ? "预览加载中…" : preview ? "重新预览" : "预览邮件" }}
        </button>
        <button v-if="preview || loading" type="button" @click="reset">关闭预览</button>
      </div>
    </header>
    <p v-if="error" class="email-preview-error" role="alert">{{ error }}</p>
    <div v-if="preview" class="email-preview-result">
      <p><strong>邮件主题</strong> {{ preview.subject }}</p>
      <iframe
        :key="scene"
        title="邮件 HTML 预览"
        sandbox=""
        referrerpolicy="no-referrer"
        :srcdoc="previewDocument"
      ></iframe>
      <details>
        <summary>查看纯文本</summary>
        <pre>{{ preview.text }}</pre>
      </details>
    </div>
  </section>
</template>

<style scoped>
.email-preview {
  margin-top: 12px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}
h3 {
  margin: 0;
  font-size: 16px;
}
p {
  margin: 4px 0 0;
  color: var(--text-dim);
}
.email-preview-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
button {
  min-height: 42px;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  color: var(--text);
  background: var(--surface-hi);
}
button:not(:disabled) {
  cursor: pointer;
}
button:first-child:not(:disabled),
summary {
  color: var(--accent-strong);
}
.email-preview-error {
  color: var(--danger);
}
.email-preview-result {
  display: grid;
  gap: 12px;
  margin-top: 12px;
  overflow-wrap: anywhere;
}
strong {
  margin-right: 8px;
  color: var(--text);
}
iframe {
  width: 100%;
  height: clamp(360px, 65vh, 680px);
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg);
}
summary {
  cursor: pointer;
}
pre {
  margin: 8px 0 0;
  color: var(--text);
  font: inherit;
  white-space: pre-wrap;
}
</style>
