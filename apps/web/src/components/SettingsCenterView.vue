<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import { mdiAlertOutline, mdiContentSaveOutline, mdiRefresh, mdiShieldKeyOutline } from "@mdi/js";
import { computed, onMounted, onScopeDispose, reactive, ref } from "vue";

import { parseSettingInput, settingToInput, useSettings } from "../composables/useSettings";
import type { PublicSettingEntry } from "../types";

const props = defineProps<{ requireAuth?: (() => void) | undefined }>();
/** 有配置真的写进去了就通知外层刷新「连接与自检」：SMTP 保存后状态应立即变"已配置"。 */
const emit = defineEmits<{ saved: [] }>();

const settings = useSettings(props.requireAuth);
const draft = reactive<Record<string, string>>({});
const password = reactive({ current: "", next: "", confirm: "" });
const rejected = ref<Record<string, string>>({});
let active = true;
let reloadRevision = 0;
onScopeDispose(() => {
  active = false;
  reloadRevision += 1;
});

/** 需要重启的键 → 注册表里的中文标签，提示里直接说人话而不是键名。 */
const restartLabels = computed(() =>
  settings.restartRequired.value.map((key) => settings.entries.value.find((entry) => entry.key === key)?.label ?? key),
);

onMounted(async () => {
  await reload();
});

async function reload() {
  const current = ++reloadRevision;
  if ((await settings.load()) && active && current === reloadRevision) syncDraft();
}

function syncDraft() {
  if (!active) return;
  for (const entry of settings.entries.value) {
    // 密钥只回掩码：输入框留空表示"不修改"，绝不把 "****" 填进去。
    draft[entry.key] = entry.secret ? "" : settingToInput(entry);
  }
}

/** 只有真正改动过的项才提交；密钥留空代表"不修改"。 */
const dirty = computed<Record<string, unknown>>(() => {
  const values: Record<string, unknown> = {};
  for (const entry of settings.entries.value) {
    // <input type="number"> 的 v-model 会把值转成 number，这里统一成字符串再比较/解析。
    const rawValue = draft[entry.key];
    const raw = rawValue === undefined || rawValue === null ? "" : String(rawValue);
    if (entry.secret) {
      if (raw.trim() !== "") values[entry.key] = raw;
      continue;
    }
    if (raw === settingToInput(entry)) continue;
    values[entry.key] = parseSettingInput(entry, raw);
  }
  return values;
});
const dirtyCount = computed(() => Object.keys(dirty.value).length);

async function save() {
  if (!active || settings.saving.value) return;
  reloadRevision += 1;
  rejected.value = {};
  const submitted = dirty.value;
  const result = await settings.save(submitted);
  if (!active) return;
  for (const item of result) rejected.value[item.key] = item.error;
  if (result.length === 0) syncDraft();
  // 至少有一项真的落库 → 让外层重新拉一次连接状态（保存即生效，不必重启、也不用手动点刷新）。
  if (result.length < Object.keys(submitted).length) emit("saved");
}

async function submitPassword() {
  if (!active || settings.saving.value) return;
  if (password.next !== password.confirm) {
    rejected.value["admin.passwordHash"] = "两次输入的新口令不一致";
    return;
  }
  rejected.value = {};
  reloadRevision += 1;
  const failure = await settings.changePassword(password.current, password.next);
  if (!active) return;
  if (!failure) {
    password.current = "";
    password.next = "";
    password.confirm = "";
    syncDraft();
  }
}

function sourceLabel(entry: PublicSettingEntry): string {
  if (entry.source === "db") return "后台已保存";
  if (entry.source === "env") return "来自首次启动的环境变量";
  return "默认值";
}
function isBoolean(entry: PublicSettingEntry): boolean {
  return typeof entry.value === "boolean";
}
function isNumber(entry: PublicSettingEntry): boolean {
  return typeof entry.value === "number";
}
function isList(entry: PublicSettingEntry): boolean {
  return Array.isArray(entry.value);
}
/** 多行长文本（邮件正文/提示文案）：一行 input 里改多行文案太难用。 */
function isMultiline(entry: PublicSettingEntry): boolean {
  return entry.multiline === true && !entry.secret && !isBoolean(entry) && !isNumber(entry);
}
/** 有候选项的数组设置：渲染成一组开关，而不是让用户手写逗号分隔。 */
function isMultiChoice(entry: PublicSettingEntry): boolean {
  return isList(entry) && Array.isArray(entry.choices) && entry.choices.length > 0;
}
/** 当前草稿里选中的候选项集合（草稿是逗号分隔字符串，见 draft 同步逻辑）。 */
function selectedValues(entry: PublicSettingEntry): string[] {
  return String(draft[entry.key] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
function toggleChoice(entry: PublicSettingEntry, value: string, checked: boolean): void {
  const next = new Set(selectedValues(entry));
  if (checked) next.add(value);
  else next.delete(value);
  draft[entry.key] = [...next].join(",");
}
</script>

<template>
  <section class="settings-center" aria-labelledby="settings-center-title">
    <div class="heading">
      <div>
        <h2 id="settings-center-title">配置项</h2>
        <p class="hint">
          所有配置保存在数据库里，不再依赖 .env 文件；<strong>密钥只会显示掩码</strong>，留空表示保持原值。
        </p>
      </div>
      <button type="button" class="refresh" :disabled="settings.loading.value || settings.saving.value" @click="reload">
        <SvgIcon type="mdi" :path="mdiRefresh" :size="17" />{{ settings.loading.value ? "读取中…" : "重新读取" }}
      </button>
    </div>

    <p v-if="settings.admin.value.mustChangePassword" class="banner warning" role="status">
      <SvgIcon type="mdi" :path="mdiAlertOutline" :size="18" />
      管理员 {{ settings.admin.value.username }} 仍在使用初始化默认口令，建议立即在下方修改。
    </p>
    <p v-if="settings.error.value" class="banner error" role="alert">{{ settings.error.value }}</p>
    <p v-else-if="settings.message.value" class="banner ok" role="status">{{ settings.message.value }}</p>
    <p v-if="settings.restartRequired.value.length" class="banner warning" role="status">
      <SvgIcon type="mdi" :path="mdiAlertOutline" :size="18" />
      以下配置需要<strong>重启应用</strong>后生效：{{ restartLabels.join("、") }}。
    </p>
    <p v-if="settings.warnings.value.length" class="banner warning" role="status">
      {{ settings.warnings.value.join("；") }}
    </p>

    <article class="card">
      <h3><SvgIcon type="mdi" :path="mdiShieldKeyOutline" :size="17" />管理员口令</h3>
      <div class="grid password-grid">
        <label>
          <span>当前口令</span>
          <input v-model="password.current" type="password" autocomplete="current-password" />
        </label>
        <label>
          <span>新口令（至少 8 位）</span>
          <input v-model="password.next" type="password" autocomplete="new-password" />
        </label>
        <label>
          <span>确认新口令</span>
          <input v-model="password.confirm" type="password" autocomplete="new-password" />
        </label>
      </div>
      <p v-if="rejected['admin.passwordHash']" class="field-error" role="alert">
        {{ rejected["admin.passwordHash"] }}
      </p>
      <button
        type="button"
        class="primary"
        :disabled="settings.saving.value || !password.current || !password.next"
        @click="submitPassword"
      >
        修改口令
      </button>
    </article>

    <p v-if="settings.loading.value && !settings.loaded.value" class="empty" role="status">正在读取配置…</p>

    <article v-for="section in settings.groups.value" :key="section.group" class="card">
      <h3>{{ section.label }}</h3>
      <div class="grid">
        <label v-for="entry in section.settings" :key="entry.key">
          <span class="field-label">
            {{ entry.label }}
            <em v-if="entry.secret" class="tag secret">{{ entry.hasValue ? "密钥·已配置" : "密钥·未配置" }}</em>
            <em class="tag source">{{ sourceLabel(entry) }}</em>
          </span>
          <template v-if="isBoolean(entry)">
            <select v-model="draft[entry.key]">
              <option value="true">启用</option>
              <option value="false">停用</option>
            </select>
          </template>
          <template v-else-if="isMultiChoice(entry)">
            <div class="choice-grid">
              <label v-for="choice in entry.choices" :key="choice.value" class="choice">
                <input
                  type="checkbox"
                  :checked="selectedValues(entry).includes(choice.value)"
                  @change="toggleChoice(entry, choice.value, ($event.target as HTMLInputElement).checked)"
                />
                <span>{{ choice.label }}</span>
                <small v-if="choice.help">{{ choice.help }}</small>
              </label>
            </div>
          </template>
          <template v-else-if="entry.secret">
            <input
              v-model="draft[entry.key]"
              type="password"
              autocomplete="new-password"
              :placeholder="entry.hasValue ? '已配置（留空表示不修改）' : '未配置'"
            />
          </template>
          <template v-else-if="isMultiline(entry)">
            <textarea v-model="draft[entry.key]" rows="6" spellcheck="false" />
          </template>
          <template v-else>
            <input
              v-model="draft[entry.key]"
              :type="isNumber(entry) ? 'number' : 'text'"
              :placeholder="isList(entry) ? '逗号分隔，例如 115,magnet' : ''"
            />
          </template>
          <small v-if="entry.help" class="help">{{ entry.help }}</small>
          <small v-if="rejected[entry.key]" class="field-error" role="alert">{{ rejected[entry.key] }}</small>
          <code class="key">{{ entry.key }}</code>
        </label>
      </div>
    </article>

    <div class="actions">
      <button type="button" class="primary" :disabled="settings.saving.value || dirtyCount === 0" @click="save">
        <SvgIcon type="mdi" :path="mdiContentSaveOutline" :size="17" />
        {{ settings.saving.value ? "保存中…" : `保存修改（${dirtyCount}）` }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.settings-center {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.heading h2 {
  margin: 0;
  font-size: 20px;
}
.hint {
  margin: 6px 0 0;
  color: #8b98a3;
  font-size: 13px;
}
.refresh {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 38px;
  padding: 0 12px;
  border: 1px solid #22333d;
  border-radius: 8px;
  color: #cbd5db;
  background: #101c24;
  cursor: pointer;
}
.banner {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 13px;
}
.banner.warning {
  color: #f4d58a;
  background: #2a2314;
  border: 1px solid #4a3d1c;
}
.banner.error {
  color: #f6a5a5;
  background: #2a1616;
  border: 1px solid #4a2020;
}
.banner.ok {
  color: #9fd6a4;
  background: #14251a;
  border: 1px solid #24492e;
}
.card {
  padding: 14px 16px;
  border: 1px solid #1b2a33;
  border-radius: 10px;
  background: #0d171e;
}
.card h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 12px;
  font-size: 15px;
  color: #e6edf1;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
}
.password-grid {
  margin-bottom: 10px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}
.field-label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #c3ced6;
}
.tag {
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 11px;
  font-style: normal;
}
.tag.secret {
  color: #f4d58a;
  background: #2a2314;
}
.tag.source {
  color: #8b98a3;
  background: #16242c;
}
input,
select,
textarea {
  min-height: 38px;
  padding: 0 10px;
  border: 1px solid #22333d;
  border-radius: 8px;
  color: #e6edf1;
  background: #0a141a;
}
/* 多行文案（邮件正文等）：保留手动换行、允许竖向拉伸，改长文案时看得清整段。 */
textarea {
  padding: 8px 10px;
  font: inherit;
  font-size: 12.5px;
  line-height: 1.7;
  resize: vertical;
}
input:focus,
select:focus,
textarea:focus {
  outline: 2px solid #2f6f8f;
  outline-offset: 1px;
}
.help,
.key {
  color: #7d8a94;
  font-size: 11px;
}
.field-error {
  color: #f6a5a5;
  font-size: 12px;
}
.actions {
  position: sticky;
  bottom: 12px;
  display: flex;
  justify-content: flex-end;
}
.primary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 40px;
  padding: 0 16px;
  border: 0;
  border-radius: 8px;
  color: #04121a;
  background: #6ac46d;
  font-weight: 600;
  cursor: pointer;
}
.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.empty {
  color: #8b98a3;
  font-size: 13px;
}
</style>
