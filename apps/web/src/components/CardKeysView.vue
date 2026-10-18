<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import {
  mdiAutoFix,
  mdiCheck,
  mdiClipboardOutline,
  mdiDelete,
  mdiGiftOutline,
  mdiPencilOutline,
  mdiPlus,
  mdiRefresh,
  mdiTicketConfirmationOutline,
} from "@mdi/js";
import { computed, onMounted, onScopeDispose, ref } from "vue";

import type { CardRow } from "../composables/useCardKeys";
import { useCardKeys } from "../composables/useCardKeys";
import CardExpiryCalendar from "./CardExpiryCalendar.vue";

const props = defineProps<{ requireAuth?: (() => void) | undefined }>();

const c = useCardKeys(props.requireAuth);
let stopped = false;
let aiRevision = 0;
onScopeDispose(() => {
  stopped = true;
  aiRevision += 1;
});
const kind = ref<"trial" | "month" | "year" | "custom">("month");
/**
 * 自定义卡的两种玩法：
 *  - days  按天数（自定义卡的**老行为**，保留下来：10 天 / 15 天这类档位月卡年卡覆盖不到）
 *  - date  按固定到期日（新行为：谁什么时候兑换都到同一天，如"国庆卡密 10/8 统一到期"）
 */
const customMode = ref<"days" | "date">("date");
const customDays = ref(30);
const customExpiresAt = ref("");
const cardName = ref("");
const expiryLabel = ref("");
const blessing = ref("");
const count = ref(10);
const generated = ref<string[]>([]);
/** AI 帮写的额外要求（"押韵一点""更口语"），留给管理员补一句。 */
const aiHint = ref("");
/** AI 的反馈（成功示例 / 失败原因），只在这一块显示，不污染全局 error。 */
const aiNotice = ref("");

const copied = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
function copyCard(code: string) {
  void navigator.clipboard?.writeText(code);
  copied.value = code;
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copied.value = null;
  }, 1800);
}

const bulkCopied = ref<"all" | "unused" | null>(null);
let bulkTimer: ReturnType<typeof setTimeout> | null = null;
function copyBulk(scope: "all" | "unused") {
  const cards = c.cards.value;
  const codes = (scope === "unused" ? cards.filter((card) => card.status === "unused") : cards).map(
    (card) => card.code,
  );
  if (!codes.length) return;
  void navigator.clipboard?.writeText(codes.join("\n"));
  bulkCopied.value = scope;
  if (bulkTimer) clearTimeout(bulkTimer);
  bulkTimer = setTimeout(() => {
    bulkCopied.value = null;
  }, 1800);
}
const unusedCount = computed(() => c.cards.value.filter((card) => card.status === "unused").length);

const isCustom = computed(() => kind.value === "custom");
const usesFixedDate = computed(() => kind.value === "custom" && customMode.value === "date");

onMounted(() => void c.load());

function pickKind(next: "trial" | "month" | "year" | "custom") {
  kind.value = next;
  // 切到"按固定到期日"时给个不早于今天的默认值，免得管理员一进来就被"日期不能为空"挡住
  if (next === "custom" && customMode.value === "date" && !customExpiresAt.value) customExpiresAt.value = defaultDate();
  aiNotice.value = "";
}

function defaultDate(days = 30): string {
  const target = new Date();
  const date = new Date(target.getFullYear(), target.getMonth(), target.getDate() + days);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** AI 帮写的场景提示：优先用卡密名称（"国庆节卡密"），没起名字就用类型。 */
function occasion(): string {
  return cardName.value.trim() || { trial: "试用卡", month: "月卡", year: "年卡", custom: "自定义卡" }[kind.value];
}

async function writeWithAi() {
  const current = ++aiRevision;
  aiNotice.value = "";
  const text = await c.draftBlessing({ occasion: occasion(), hint: aiHint.value.trim() || undefined });
  if (stopped || current !== aiRevision) return;
  if (!text) {
    aiNotice.value = c.aiError.value;
    return;
  }
  // 覆盖前先让人看清是"AI 写的"，避免手写内容被无声顶掉
  blessing.value = text;
  aiNotice.value = "已由 AI 写入下方文案，可继续改或再换一条。";
}

async function testAiConnection() {
  const current = ++aiRevision;
  aiNotice.value = "测试中…";
  const result = await c.testAi();
  if (!stopped && current === aiRevision) aiNotice.value = result || c.aiError.value;
}

async function create() {
  const payload = {
    kind: kind.value,
    count: count.value,
    name: cardName.value.trim() || undefined,
    blessing: blessing.value.trim() || undefined,
  } as Parameters<typeof c.create>[0];
  if (isCustom.value) {
    if (usesFixedDate.value) {
      if (!customExpiresAt.value) {
        aiNotice.value = "";
        return;
      }
      payload.expiresAt = customExpiresAt.value;
      payload.expiryLabel = expiryLabel.value.trim() || undefined;
    } else {
      payload.days = customDays.value;
    }
  }
  const codes = await c.create(payload);
  if (!stopped) generated.value = codes;
}

function copyAll() {
  if (generated.value.length) void navigator.clipboard?.writeText(generated.value.join("\n"));
  generated.value.forEach((code) => copyCard(code));
}

function dateLabel(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function statTone(key: "total" | "unused" | "used"): string {
  return { total: "blue", unused: "green", used: "gray" }[key];
}

/* ------------------------------- 行内编辑 ------------------------------- */
/** 批量生成后常常只想给某一张换个名字 / 改一句话，重新生成一批会把已发出去的卡打乱。 */
const editingId = ref<number | null>(null);
const editForm = ref({ name: "", expiryLabel: "", blessing: "" });
const savingEdit = ref(false);
let editRevision = 0;

function startEdit(card: CardRow) {
  editRevision += 1;
  editingId.value = card.id;
  editForm.value = { name: card.name ?? "", expiryLabel: card.expiryLabel ?? "", blessing: card.blessing ?? "" };
}

function cancelEdit() {
  editRevision += 1;
  editingId.value = null;
}

async function saveEdit(card: CardRow) {
  if (savingEdit.value) return;
  savingEdit.value = true;
  const current = editRevision;
  const ok = await c.update({
    ids: [card.id],
    name: editForm.value.name.trim(),
    // 相对天数卡没有"到期时间名称"这回事，不给人一个存了也不生效的输入框
    ...(card.expiresAt ? { expiryLabel: editForm.value.expiryLabel.trim() } : {}),
    blessing: editForm.value.blessing.trim(),
  });
  if (stopped) return;
  savingEdit.value = false;
  if (ok && current === editRevision && editingId.value === card.id) editingId.value = null;
}

async function useAiForEdit() {
  const current = ++aiRevision;
  const selected = editRevision;
  const text = await c.draftBlessing({ occasion: editForm.value.name.trim() || "会员卡密" });
  if (!stopped && current === aiRevision && selected === editRevision && text) editForm.value.blessing = text;
}
</script>

<template>
  <section class="card-keys" aria-labelledby="card-keys-title">
    <!-- 标题 + 统计 -->
    <header class="heading">
      <div class="heading-main">
        <h2 id="card-keys-title">卡密</h2>
        <p class="hint">创建、分发卡密，管理会员有效期。</p>
        <details class="usage-guide">
          <summary>查看开户说明</summary>
          <p class="hint">
            新邮箱在首页通过「邮箱 → 卡密 → 验证码」开通会员，并自动创建 Emby 账号；已有会员使用邮箱和验证码登录。
          </p>
        </details>
      </div>
      <div class="stats">
        <span v-for="key in ['total', 'unused', 'used'] as const" :key="key" class="stat-pill" :class="statTone(key)">
          <b>{{ c.stats.value[key] }}</b
          >{{ { total: "全部", unused: "未用", used: "已用" }[key] }}
        </span>
      </div>
      <button type="button" class="ghost refresh-cards" :disabled="c.loading.value" @click="c.load()">
        <SvgIcon type="mdi" :path="mdiRefresh" :size="15" />{{ c.loading.value ? "刷新中…" : "刷新" }}
      </button>
    </header>

    <p v-if="c.error.value" class="error" role="alert">{{ c.error.value }}</p>

    <!-- 创建卡密 -->
    <section class="create-card" role="group" aria-label="创建卡密">
      <header class="card-head">
        <span class="card-icon"><SvgIcon type="mdi" :path="mdiTicketConfirmationOutline" :size="18" /></span>
        <div>
          <h3>创建卡密</h3>
          <p>设置有效期与数量，生成后复制分发。</p>
        </div>
      </header>

      <div class="create-form">
        <label
          >类型
          <select :value="kind" @change="pickKind(($event.target as HTMLSelectElement).value as typeof kind)">
            <option value="trial">试用卡（10 天）</option>
            <option value="month">月卡（30 天）</option>
            <option value="year">年卡（365 天）</option>
            <option value="custom">自定义</option>
          </select>
        </label>

        <label
          >卡密名称
          <input v-model="cardName" type="text" maxlength="40" placeholder="如：国庆节卡密（留空按类型显示）" />
        </label>

        <label v-if="isCustom"
          >自定义方式
          <select v-model="customMode">
            <option value="date">按到期日期</option>
            <option value="days">按天数</option>
          </select>
        </label>

        <label v-if="isCustom && customMode === 'days'"
          >天数<input v-model.number="customDays" type="number" min="1" max="3650"
        /></label>

        <div v-if="usesFixedDate" class="field-block">
          <span class="field-label">到期时间</span>
          <CardExpiryCalendar v-model="customExpiresAt" />
        </div>

        <label v-if="usesFixedDate"
          >到期时间名称
          <input v-model="expiryLabel" type="text" maxlength="60" placeholder="如：2027 年春节结束到期" />
        </label>

        <label>数量<input v-model.number="count" type="number" min="1" max="200" /></label>
      </div>

      <p v-if="usesFixedDate" class="mode-note">
        固定到期日：<b>不论用户什么时候兑换，都在 {{ customExpiresAt || "所选日期" }} 到期</b>（当天
        23:59）；已有会员若原到期更晚，则保持原到期、不会缩短。
      </p>
      <p v-else-if="isCustom" class="mode-note">按天数：从**兑换那一刻**起算 {{ customDays }} 天。</p>
      <p v-else class="mode-note">
        月卡 / 年卡 / 试用卡是相对天数卡：从兑换那一刻起算 N 天，不设固定到期日，也无法设置到期时间名称。
      </p>

      <!-- 彩蛋祝福文案 -->
      <div class="blessing-block">
        <div class="blessing-head">
          <span class="field-label">
            <SvgIcon type="mdi" :path="mdiGiftOutline" :size="14" />彩蛋祝福文案（选填）
          </span>
          <div class="blessing-actions">
            <input
              v-model="aiHint"
              class="ai-hint"
              aria-label="AI 文案要求"
              type="text"
              maxlength="60"
              placeholder="给 AI 补一句要求，如：押韵一点"
            />
            <button type="button" class="ghost" :disabled="c.aiBusy.value" @click="writeWithAi">
              <SvgIcon type="mdi" :path="mdiAutoFix" :size="14" />{{ c.aiBusy.value ? "生成中…" : "AI 帮写" }}
            </button>
            <button
              type="button"
              class="ghost"
              :disabled="c.aiBusy.value"
              title="验证接口地址 / Key / 模型"
              @click="testAiConnection"
            >
              测试连接
            </button>
          </div>
        </div>
        <textarea
          v-model="blessing"
          aria-label="彩蛋祝福文案（选填）"
          rows="2"
          maxlength="200"
          placeholder="用户在注册或续期时点「验证卡密」，就会弹出这句话。留空则不弹窗。"
        />
        <p v-if="aiNotice" class="ai-notice" role="status">{{ aiNotice }}</p>
      </div>

      <div class="create-actions">
        <button
          type="button"
          class="primary"
          :disabled="c.busy.value || count < 1 || (usesFixedDate && !customExpiresAt)"
          @click="create"
        >
          <SvgIcon type="mdi" :path="mdiPlus" :size="16" />{{ c.busy.value ? "生成中…" : "生成卡密" }}
        </button>
      </div>

      <div v-if="generated.length" class="generated" role="status">
        <div class="generated-head">
          <span>已生成 {{ generated.length }} 张</span
          ><button type="button" class="link" @click="copyAll">
            <SvgIcon type="mdi" :path="copied ? mdiCheck : mdiClipboardOutline" :size="13" />{{
              copied ? "已复制全部 ✓" : "复制全部"
            }}
          </button>
        </div>
        <div class="codes">
          <button
            v-for="(code, i) in generated"
            :key="i"
            type="button"
            class="code-chip"
            title="点击复制"
            @click="copyCard(code)"
          >
            <code>{{ code }}</code
            ><SvgIcon type="mdi" :path="copied === code ? mdiCheck : mdiClipboardOutline" :size="12" />
          </button>
        </div>
      </div>
    </section>

    <!-- 卡密列表 -->
    <section class="table-card">
      <header class="card-head">
        <span class="card-icon dim"><SvgIcon type="mdi" :path="mdiTicketConfirmationOutline" :size="18" /></span>
        <div>
          <h3>
            卡密列表 <em>({{ c.cards.value.length }})</em>
          </h3>
          <p>点击卡密即可复制；已使用的会记录使用者与时间；🎁 表示配了彩蛋祝福。</p>
        </div>
        <div class="bulk-actions">
          <button
            v-if="unusedCount > 0"
            type="button"
            class="ghost"
            title="复制所有未使用卡密"
            @click="copyBulk('unused')"
          >
            <SvgIcon type="mdi" :path="bulkCopied === 'unused' ? mdiCheck : mdiClipboardOutline" :size="14" />{{
              bulkCopied === "unused" ? "已复制 ✓" : `复制未用（${unusedCount}）`
            }}
          </button>
          <button v-if="c.cards.value.length" type="button" class="ghost" title="复制全部卡密" @click="copyBulk('all')">
            <SvgIcon type="mdi" :path="bulkCopied === 'all' ? mdiCheck : mdiClipboardOutline" :size="14" />{{
              bulkCopied === "all" ? "已复制 ✓" : "复制全部"
            }}
          </button>
        </div>
      </header>
      <!-- 只有"还没有任何数据"时才整块显示加载态：一旦有数据，刷新/删除都必须保持表格在位，
           否则每次删除都会闪一下"正在读取…"，那段时间一个按钮都点不了。 -->
      <div v-if="c.loading.value && !c.cards.value.length" class="empty">正在读取…</div>
      <div v-else-if="!c.cards.value.length" class="empty">暂无卡密，先在上方生成。</div>
      <div v-else class="table-wrap">
        <table class="cards-table" role="table" aria-label="卡密列表">
          <thead role="rowgroup">
            <tr role="row">
              <th>卡密（点击复制）</th>
              <th>名称</th>
              <th>类型</th>
              <th>到期</th>
              <th>状态</th>
              <th>使用者</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            <template v-for="card in c.cards.value" :key="card.id">
              <tr class="card-row" role="row">
                <td class="code-column" data-label="卡密 · 点击复制" role="cell">
                  <button type="button" class="code-cell" title="点击复制" @click="copyCard(card.code)">
                    <code>{{ card.code }}</code>
                    <span class="copy-icon"
                      ><SvgIcon type="mdi" :path="copied === card.code ? mdiCheck : mdiClipboardOutline" :size="13"
                    /></span>
                  </button>
                </td>
                <td class="name-column" data-label="名称" role="cell">
                  <span class="name-cell">
                    {{ card.displayName }}
                    <SvgIcon v-if="card.blessing" type="mdi" :path="mdiGiftOutline" :size="12" class="gift" />
                  </span>
                </td>
                <td class="kind-column" data-label="类型" role="cell">
                  <span class="kind-tag">{{ card.kindLabel }}</span>
                </td>
                <td class="expiry-cell" data-label="到期" role="cell">
                  <!-- 名称优先：管理员写的到期时间名称就是用户看到的那句话，真实日期退到小字 -->
                  <span :class="{ expired: card.expired }">{{ card.expiryText }}</span>
                  <small v-if="card.expiryDate && card.expiryLabel">{{ card.expiryDate }}</small>
                  <small v-else-if="card.expiresAt">{{ card.days }} 天</small>
                  <small v-else>{{ card.days }} 天</small>
                </td>
                <td class="status-column" data-label="状态" role="cell">
                  <div class="status-badges">
                    <span class="status" :class="card.status === 'unused' ? 'ok' : 'dim'">{{ card.statusLabel }}</span>
                    <span v-if="card.expired" class="status warn">已过期</span>
                  </div>
                </td>
                <td class="dim user-cell" data-label="使用者" role="cell">
                  {{ card.usedByEmail ?? "—" }}<small v-if="card.usedAt">使用于 {{ dateLabel(card.usedAt) }}</small>
                </td>
                <td class="dim created-column" data-label="创建时间" role="cell">{{ dateLabel(card.createdAt) }}</td>
                <td class="actions-column" role="cell">
                  <div class="row-actions">
                    <button
                      type="button"
                      class="ghost icon"
                      :aria-label="editingId === card.id ? '收起编辑' : '编辑名称 / 到期时间名称 / 祝福文案'"
                      :title="editingId === card.id ? '收起编辑' : '编辑名称 / 到期时间名称 / 祝福文案'"
                      @click="editingId === card.id ? cancelEdit() : startEdit(card)"
                    >
                      <SvgIcon type="mdi" :path="mdiPencilOutline" :size="14" />
                      <span class="mobile-action-label">{{ editingId === card.id ? "收起编辑" : "编辑" }}</span>
                    </button>
                    <button
                      type="button"
                      class="danger"
                      :aria-label="c.deletingIds.value.includes(card.id) ? '删除中…' : '删除卡密'"
                      :disabled="c.deletingIds.value.includes(card.id)"
                      :title="c.deletingIds.value.includes(card.id) ? '删除中…' : '删除卡密'"
                      @click="c.remove([card.id])"
                    >
                      <SvgIcon type="mdi" :path="mdiDelete" :size="15" />
                      <span class="mobile-action-label">{{
                        c.deletingIds.value.includes(card.id) ? "删除中…" : "删除"
                      }}</span>
                    </button>
                  </div>
                </td>
              </tr>
              <tr v-if="editingId === card.id" class="edit-row" role="row">
                <td colspan="8" role="cell">
                  <div class="edit-form">
                    <label
                      >卡密名称<input v-model="editForm.name" type="text" maxlength="40" placeholder="留空按类型显示"
                    /></label>
                    <label v-if="card.expiresAt"
                      >到期时间名称<input
                        v-model="editForm.expiryLabel"
                        type="text"
                        maxlength="60"
                        placeholder="如：国庆假期结束到期"
                    /></label>
                    <label class="wide"
                      >彩蛋祝福文案
                      <textarea v-model="editForm.blessing" rows="2" maxlength="200" placeholder="留空则不弹窗" />
                    </label>
                    <div class="edit-actions">
                      <button type="button" class="ghost" :disabled="c.aiBusy.value" @click="useAiForEdit">
                        <SvgIcon type="mdi" :path="mdiAutoFix" :size="14" />AI 帮写
                      </button>
                      <button type="button" class="primary" :disabled="savingEdit" @click="saveEdit(card)">
                        {{ savingEdit ? "保存中…" : "保存" }}
                      </button>
                      <button type="button" class="ghost" @click="cancelEdit">取消</button>
                    </div>
                  </div>
                  <p v-if="card.expiresAt === null" class="edit-note">
                    这是相对天数卡（兑换后 {{ card.days }} 天），没有绝对到期日，"到期时间名称"对它不适用。
                  </p>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </section>
  </section>
</template>

<style scoped>
.card-keys {
  padding: 4px 2px 20px;
  color: #dbe3e8;
  display: grid;
  gap: 16px;
  max-width: 1180px;
  margin: 0 auto;
}

/* ===== 标题 + 统计 ===== */
.heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.heading-main h2 {
  margin: 0 0 4px;
  color: #f4f6f7;
  font-size: 22px;
}
.hint {
  margin: 0;
  color: #8a97a1;
  font-size: 13px;
  line-height: 1.6;
}
.stats {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.stat-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 11px;
  border: 1px solid;
}
.stat-pill b {
  font-size: 14px;
  font-weight: 800;
}
.stat-pill.blue {
  color: #8fb7e8;
  border-color: rgb(90 140 190 / 28%);
  background: rgb(30 55 80 / 22%);
}
.stat-pill.green {
  color: #7fd08a;
  border-color: rgb(93 175 93 / 28%);
  background: rgb(20 48 28 / 22%);
}
.stat-pill.gray {
  color: #9aa6ae;
  border-color: #2a3c46;
  background: #0f1a22;
}
button.ghost {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 11px;
  border: 1px solid #2a3c46;
  border-radius: 8px;
  color: #c9d3da;
  background: #101d25;
  cursor: pointer;
  font-size: 12px;
  transition:
    border-color 0.16s,
    color 0.16s;
}
button.ghost:hover:not(:disabled) {
  border-color: #3f5a6b;
  color: #eef2f4;
}
button.ghost.icon {
  padding: 0;
  min-width: 32px;
  justify-content: center;
}
button:disabled {
  opacity: 0.55;
  cursor: default;
}
.error {
  margin: 0;
  padding: 10px 14px;
  border: 1px solid #4a2e30;
  border-radius: 8px;
  color: #f0b7b7;
  background: #241416;
  font-size: 12px;
}

/* ===== 卡片 ===== */
.create-card,
.table-card {
  padding: 18px;
  border: 1px solid #1f313d;
  border-radius: 14px;
  background: linear-gradient(180deg, #0c171f, #0a141b 80%);
  box-shadow: 0 8px 22px rgb(0 0 0 / 16%);
  display: grid;
  gap: 14px;
}
.card-head {
  display: flex;
  align-items: flex-start;
  gap: 11px;
}
.card-icon {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  color: #7fd08a;
  background: rgb(93 175 93 / 12%);
  flex: none;
}
.card-icon.dim {
  color: #8fb7e8;
  background: rgb(60 120 180 / 12%);
}
.card-head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 740;
  color: #eef2f4;
}
.card-head h3 em {
  font-style: normal;
  color: #63727d;
  font-size: 12px;
}
.card-head p {
  margin: 3px 0 0;
  color: #7d8794;
  font-size: 11.5px;
}
.bulk-actions {
  margin-left: auto;
  display: inline-flex;
  gap: 8px;
  flex-wrap: wrap;
}

/* ===== 创建区 ===== */
.create-form {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}
.create-form label,
.edit-form label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: #8d9ba4;
  font-size: 12px;
}
.field-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: #8d9ba4;
  font-size: 12px;
}
.field-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #8d9ba4;
  font-size: 12px;
}
.create-form select,
.create-form input,
.edit-form input {
  min-height: 40px;
  padding: 0 10px;
  border: 1px solid #283b47;
  border-radius: 9px;
  color: #eef2f4;
  background: #0e1a23;
  outline: 0;
  font-size: 13px;
}
.create-form select:focus,
.create-form input:focus,
.create-form textarea:focus,
.edit-form input:focus,
.edit-form textarea:focus {
  border-color: #5aa95a;
  box-shadow: 0 0 0 3px rgb(93 175 93 / 14%);
}
.create-form label:has(input[type="text"]) input {
  min-width: 200px;
}
.mode-note {
  margin: 0;
  padding: 8px 11px;
  border-left: 2px solid #2a3c46;
  color: #7d8794;
  font-size: 11.5px;
  line-height: 1.6;
}
.mode-note b {
  color: #9fd3a4;
}

/* ===== 彩蛋文案 ===== */
.blessing-block {
  display: grid;
  gap: 7px;
}
.blessing-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.blessing-actions {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}
.ai-hint {
  min-height: 34px;
  min-width: 210px;
  padding: 0 10px;
  border: 1px solid #283b47;
  border-radius: 8px;
  color: #eef2f4;
  background: #0e1a23;
  outline: 0;
  font-size: 12px;
}
.ai-hint:focus {
  border-color: #5aa95a;
}
.create-form textarea,
.edit-form textarea {
  padding: 9px 10px;
  border: 1px solid #283b47;
  border-radius: 9px;
  color: #eef2f4;
  background: #0e1a23;
  outline: 0;
  font-size: 13px;
  font-family: inherit;
  resize: vertical;
}
.ai-notice {
  margin: 0;
  color: #8fb7e8;
  font-size: 11.5px;
  line-height: 1.6;
}
.create-actions {
  display: flex;
  gap: 10px;
}
button.primary {
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 16px;
  border: 0;
  border-radius: 9px;
  color: #07120d;
  background: linear-gradient(180deg, #74c574, #5aa95a);
  font-weight: 760;
  cursor: pointer;
  box-shadow: 0 8px 18px rgb(93 175 93 / 22%);
  transition:
    transform 0.16s,
    box-shadow 0.16s;
}
button.primary:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 11px 24px rgb(93 175 93 / 30%);
}
button.link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 0;
  color: #7fd08a;
  background: transparent;
  cursor: pointer;
  font-size: 12px;
}

/* ===== 生成结果 ===== */
.generated {
  padding: 12px;
  border: 1px solid #2e4630;
  border-radius: 10px;
  background: #0e1c14;
}
.generated-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: #9fd3a4;
  font-size: 12px;
  margin-bottom: 8px;
}
.codes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.code-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 9px;
  border: 1px solid #2a3c46;
  border-radius: 7px;
  color: #cfe8cf;
  background: #0c151c;
  cursor: pointer;
  font-size: 12px;
}
.code-chip:hover {
  border-color: #3f5a6b;
}
.code-chip code {
  font-family: ui-monospace, monospace;
}

/* ===== 列表 ===== */
.table-wrap {
  overflow-x: auto;
}
.cards-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.cards-table th {
  padding: 9px 10px;
  border-bottom: 1px solid #20313c;
  color: #74838d;
  font-size: 11px;
  font-weight: 700;
  text-align: left;
  white-space: nowrap;
}
.cards-table td {
  padding: 10px;
  border-bottom: 1px solid #16232b;
  vertical-align: middle;
}
.cards-table tbody tr:hover {
  background: rgb(255 255 255 / 2%);
}
.code-cell {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px dashed #2a3c46;
  border-radius: 8px;
  color: #eef2f4;
  background: #0b141b;
  cursor: pointer;
  font-family: ui-monospace, monospace;
  font-size: 12.5px;
  transition:
    border-color 0.16s,
    background-color 0.16s;
}
.code-cell:hover {
  border-color: #5aa95a;
  background: #0f1e16;
}
.copy-icon {
  color: #63727d;
  display: inline-flex;
}
.code-cell:hover .copy-icon,
.code-cell:hover .copy-icon:hover {
  color: #7fd08a;
}
.name-cell {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #eef2f4;
}
.name-cell .gift {
  color: #d9b26a;
}
.expiry-cell {
  min-width: 150px;
  color: #cfe8cf;
}
.expiry-cell span.expired {
  color: #f0b7b7;
  text-decoration: line-through;
}
.kind-tag {
  padding: 2px 9px;
  border-radius: 999px;
  color: #8fb7e8;
  background: rgb(30 55 80 / 24%);
  font-size: 11px;
}
.status {
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 750;
}
.status.ok {
  color: #7fd08a;
  background: #10241a;
  border: 1px solid rgb(93 175 93 / 22%);
}
.status.dim {
  color: #9aa6ae;
  background: #1a252d;
  border: 1px solid #2a3c46;
}
.status.warn {
  margin-left: 5px;
  color: #f0b7b7;
  background: #241416;
  border: 1px solid #4a2e30;
}
.dim {
  color: #8a97a1;
}
.user-cell {
  min-width: 150px;
}
.dim small,
.expiry-cell small {
  display: block;
  color: #5f6974;
  font-size: 10px;
  margin-top: 2px;
}
.row-actions {
  display: inline-flex;
  gap: 6px;
}
button.danger {
  min-width: 32px;
  min-height: 32px;
  border: 1px solid #4a2e30;
  border-radius: 8px;
  color: #f0b7b7;
  background: #241416;
  cursor: pointer;
  display: inline-grid;
  place-items: center;
}
button.danger:hover {
  border-color: #7a4444;
  background: #2c1719;
}

/* ===== 行内编辑 ===== */
.edit-row td {
  padding: 12px 10px 14px;
  background: #0b141b;
}
.edit-form {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}
.edit-form label.wide {
  flex: 1 1 320px;
}
.edit-actions {
  display: inline-flex;
  gap: 8px;
  margin-left: auto;
}
.edit-note {
  margin: 8px 0 0;
  color: #63727d;
  font-size: 11px;
}
.empty {
  padding: 22px;
  color: #63727d;
  font-size: 13px;
  text-align: center;
}
</style>
<style scoped src="./CardKeysView.polish.css"></style>
<style scoped src="./CardKeysView.mobile.css"></style>
