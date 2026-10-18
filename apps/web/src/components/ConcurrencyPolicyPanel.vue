<script setup lang="ts">
import { onMounted, onScopeDispose, reactive, ref, watch } from "vue";
import { createConcurrencyPolicyRequests } from "../composables/concurrency-policy-requests";

const props = defineProps<{ requireAuth?: () => void }>();

interface ConcurrencyPolicy {
  enabled: boolean;
  remindAfterMinutes: number;
  disableAfterMinutes: number;
  disableForHours: number;
  adminEmail: string | null;
  /** 超限时直接中断多出来的播放（先到先得）。 */
  interruptStreams: boolean;
  /** 未登记会员的默认并发路数（0 = 不限）。 */
  defaultStreamLimit: number;
  /** 允许会员在门户自助解冻（冻结邮件里给出入口）。 */
  unfreezeEnabled: boolean;
  /** 每月自助解冻次数上限（0 = 不允许），按自然月统计。 */
  unfreezeMonthlyLimit: number;
  /** 自助解冻强制等待秒数（服务端同样校验）。 */
  unfreezeWaitSeconds: number;
  /** 弹窗标题（留空回落默认文案）。 */
  unfreezeTitle: string;
  /** 弹窗正文（留空回落默认文案；支持占位符）。 */
  unfreezeNotice: string;
  /** 平台地址：冻结邮件里"登录平台"的链接。 */
  portalUrl: string;
}

const policy = reactive<ConcurrencyPolicy>({
  enabled: true,
  remindAfterMinutes: 2,
  disableAfterMinutes: 5,
  disableForHours: 1,
  adminEmail: null,
  interruptStreams: true,
  defaultStreamLimit: 1,
  unfreezeEnabled: true,
  unfreezeMonthlyLimit: 2,
  unfreezeWaitSeconds: 60,
  unfreezeTitle: "申请提前解冻",
  unfreezeNotice: "",
  portalUrl: "",
});
const loading = ref(false);
const saving = ref(false);
const message = ref("");

let draftRevision = 0;
watch(
  policy,
  () => {
    draftRevision += 1;
  },
  { flush: "sync" },
);
const { load, save, stop } = createConcurrencyPolicyRequests(
  fetch,
  {
    draft: policy,
    draftRevision: () => draftRevision,
    loading,
    saving,
    message,
  },
  () => props.requireAuth?.(),
);
onScopeDispose(stop);

onMounted(load);
</script>

<template>
  <section class="panel">
    <div class="section-title">
      <div>
        <h2>并发超限升级</h2>
        <p>
          同一账号同时在线播放超过上限（登记的会员用登记值，未登记的会员按下面的默认路数；<b
            >只处理会员，Emby 管理员不受影响</b
          >）。超限时先直接中断多出来的播放，同时开始<b>累计超限时长</b>：累计到下面的时间线就邮件提醒、
          <b>到点直接冻结账号</b>（冻结会立刻中断该账号所有设备，并踢掉设备，到期自动恢复）。累计只在真正超限时增长，
          中途短暂回落不会清零，所以只偶尔重叠一次不会攒到阈值。
        </p>
      </div>
    </div>
    <p v-if="message" class="msg" role="status">{{ message }}</p>
    <div v-if="loading" class="empty">正在读取…</div>
    <div v-else class="form-grid">
      <label class="row-check">
        <input v-model="policy.interruptStreams" type="checkbox" :disabled="saving" />
        <span
          ><b>超限直接中断多出来的播放</b
          ><small
            >先到先得：保留看得更久的那台，第二路播放会被真的停掉：先请客户端停止，不听话就直接断开该会话（有播放时每秒检查）</small
          ></span
        >
      </label>
      <label class="field"
        >未登记会员的默认并发路数
        <input v-model.number="policy.defaultStreamLimit" type="number" min="0" max="20" />
        （0 = 不限；Emby 管理员不受限）</label
      >
      <label class="row-check">
        <input v-model="policy.enabled" type="checkbox" :disabled="saving" />
        <span><b>启用超限升级</b><small>关闭 = 只做"立即拦截 + 中断"，不提醒不冻结账号</small></span>
      </label>
      <label class="field"
        >累计超限满
        <input v-model.number="policy.remindAfterMinutes" type="number" min="0" max="120" /> 分钟发送提醒邮件（0 =
        不提醒，到点直接冻结）</label
      >
      <label class="field"
        >累计超限满
        <input v-model.number="policy.disableAfterMinutes" type="number" min="1" max="720" />
        分钟则冻结账号（冻结 = 立即断开该账号全部设备 + 停用 Emby 账号）</label
      >
      <label class="field"
        >冻结时长
        <input v-model.number="policy.disableForHours" type="number" min="1" max="720" />
        小时（到期自动恢复，期间可在会员列表手动恢复）</label
      >
      <label class="field wide"
        >管理员抄送邮箱（可选，提醒/冻结邮件同时抄送）<input
          v-model.trim="policy.adminEmail"
          type="email"
          placeholder="admin@example.com"
      /></label>

      <!-- 会员自助解冻：冻结邮件 + 门户「我的」的解冻入口，文案与口径都在这里配 -->
      <div class="sub-title">
        <b>会员自助解冻</b>
        <small
          >被冻结的会员可登录平台自己解冻（不必干等到期）：冻结邮件里给出入口，门户「我的」显示「申请解冻」按钮，
          弹出提示并强制等待倒计时结束后才能确认解冻。等待秒数由服务端校验，改接口绕不过去。</small
        >
      </div>
      <label class="row-check">
        <input v-model="policy.unfreezeEnabled" type="checkbox" :disabled="saving" />
        <span
          ><b>允许会员自助解冻</b
          ><small>关闭 = 冻结邮件不提自助解冻、门户也不显示解冻按钮（只能等到期自动恢复或管理员手动恢复）</small></span
        >
      </label>
      <label class="field"
        >每月自助解冻次数上限
        <input v-model.number="policy.unfreezeMonthlyLimit" type="number" min="0" max="10" />
        （0 = 不允许；按自然月统计，等到期自动恢复不占次数）</label
      >
      <label class="field"
        >强制等待
        <input v-model.number="policy.unfreezeWaitSeconds" type="number" min="0" max="600" />
        秒后才能点「确认解冻」</label
      >
      <label class="field wide"
        >弹窗标题<input v-model.trim="policy.unfreezeTitle" type="text" maxlength="120" placeholder="申请提前解冻"
      /></label>
      <label class="field wide"
        >弹窗正文（会员点「申请解冻」后强制显示）
        <textarea v-model="policy.unfreezeNotice" rows="9" placeholder="留空则使用默认文案"></textarea>
        <small class="hint" v-pre
          >可用占位符：{{ email }} {{ unfreezeAt }} {{ remaining }} {{ maxStreams }} {{ monthlyLimit }}
          {{ usedThisMonth }} {{ remainingChances }} {{ remainingAfterThis }} {{ platformUrl }}（{{
            remainingChances
          }}
          = 本月还剩几次；{{ remainingAfterThis }} = 本次解冻后还剩几次）</small
        >
      </label>
      <label class="field wide"
        >平台地址（冻结邮件里"登录平台"的链接）<input
          v-model.trim="policy.portalUrl"
          type="text"
          maxlength="300"
          placeholder="https://movie.example.com"
        /><small class="hint">留空则冻结邮件里只写「登录平台」，不给可点击链接。</small></label
      >
      <button type="button" class="primary" :disabled="saving" @click="save">
        {{ saving ? "保存中…" : "保存并生效" }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.panel {
  margin-top: 14px;
  padding: 20px;
  border: 1px solid #20323c;
  border-radius: 12px;
  background: #0a151c;
  color: #dbe3e8;
}
.section-title h2 {
  margin: 0;
  font-size: 18px;
  color: #f4f6f7;
}
.section-title p {
  margin: 4px 0 0;
  color: #84929c;
  font-size: 13px;
  line-height: 1.6;
}
.msg {
  margin: 12px 0 0;
  color: #e6c06a;
  font-size: 13px;
}
.empty {
  padding: 20px;
  color: #63727d;
  font-size: 13px;
  text-align: center;
}
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-top: 18px;
  align-items: end;
}
.form-grid .row-check {
  grid-column: 1 / -1;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 7px;
  color: #9aa6ae;
  font-size: 12px;
  font-weight: 600;
}
.field.wide {
  grid-column: 1 / -1;
}
.field input {
  min-height: 42px;
  padding: 0 12px;
  border: 1px solid #2a3d48;
  border-radius: 7px;
  outline: 0;
  color: #eef2f4;
  background: #101e27;
}
.field input:focus {
  border-color: #63b868;
}
/* 自助解冻分组：标题 + 说明整行铺开，和上面的超限升级参数分开看 */
.sub-title {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
  padding-top: 14px;
  border-top: 1px solid #1e3038;
}
.sub-title b {
  color: #eef2f4;
  font-size: 14px;
}
.sub-title small {
  color: #7e8d96;
  font-size: 12px;
  line-height: 1.6;
}
.field textarea {
  padding: 10px 12px;
  border: 1px solid #2a3d48;
  border-radius: 7px;
  outline: 0;
  color: #eef2f4;
  background: #101e27;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.7;
  resize: vertical;
}
.field textarea:focus {
  border-color: #63b868;
}
.field .hint {
  color: #6f7d86;
  font-size: 12px;
  font-weight: 400;
  line-height: 1.6;
}
.row-check {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 12px 14px;
  border: 1px solid #24404c;
  border-radius: 9px;
  background: #0d1a24;
}
.row-check input {
  width: 18px;
  height: 18px;
  margin-top: 1px;
  accent-color: #5aa95a;
}
.row-check span {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.row-check b {
  color: #eef2f4;
  font-size: 13px;
}
.row-check small {
  color: #7e8d96;
  font-size: 12px;
}
button.primary {
  min-height: 44px;
  padding: 0 18px;
  border: 1px solid #4d9b51;
  border-radius: 8px;
  color: #07120d;
  background: #58ad5c;
  font-weight: 700;
  cursor: pointer;
}
button.primary:disabled {
  opacity: 0.55;
  cursor: default;
}
@media (max-width: 720px) {
  .form-grid {
    grid-template-columns: 1fr;
  }
}
</style>
