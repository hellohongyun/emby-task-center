<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import { mdiCheckDecagram, mdiEmailOutline, mdiLogout, mdiTicketConfirmationOutline } from "@mdi/js";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import UnfreezeModal from "./UnfreezeModal.vue";
import CardBlessingModal, { type CardBlessingInfo } from "./CardBlessingModal.vue";
import type { CardCheckInfo } from "../composables/usePortalSession";
import { usePortalSession } from "../composables/usePortalSession";
import { portalFetch } from "../composables/portal-access";

const s = usePortalSession();

/** 自助解冻弹窗：冻结时点「申请解冻」打开（弹窗自己负责记申请时刻与倒计时）。 */
const unfreezeModal = ref<InstanceType<typeof UnfreezeModal> | null>(null);
/** 现在能不能自助解冻：冻结中 + 后台开着开关 + 本月还有次数（都由服务端判定）。 */
const canSelfUnfreeze = computed(() =>
  Boolean(s.memberStatus.value !== "expired" && s.memberConcurrency.value?.disabled && s.memberUnfreeze.value?.enabled),
);
const unfreezeBlockedByQuota = computed(() =>
  Boolean(s.memberConcurrency.value?.disabled && s.memberUnfreeze.value?.reason === "limit_reached"),
);

function openUnfreeze() {
  unfreezeModal.value?.open();
}

/** 冻结剩余时长（小时/分钟，够用）。 */
function remainingLabel(ms: number | null): string {
  if (!ms || ms <= 0) return "即将解冻";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours > 0) return `${hours} 小时${minutes > 0 ? ` ${minutes} 分` : ""}`;
  return `${Math.max(1, minutes)} 分`;
}

/** 解冻时刻（本地时间）。 */
function unfreezeLabel(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const renewCode = ref("");
const renewCard = ref("");
const renewBusy = ref(false);
const renewMsg = ref("");
const renewSending = ref(false);
const renewCooldown = ref(0);
/** 卡密是否已通过验证：没通过就不让发验证码（与服务端的卡密闸门保持一致）。 */
const renewCardChecked = ref(false);
const renewChecking = ref(false);
const renewCardInfo = ref<CardCheckInfo | null>(null);
/** 彩蛋弹窗内容；null = 不弹（这张卡没配祝福文案）。 */
const blessingCard = ref<CardBlessingInfo | null>(null);
let renewTimer: ReturnType<typeof setInterval> | null = null;

// 改了卡密，上一次的验证结果立即作废，避免「换了卡密却沿用旧结果」。
watch(renewCard, () => {
  if (!renewCardChecked.value) return;
  renewCardChecked.value = false;
  renewCardInfo.value = null;
  blessingCard.value = null;
  renewMsg.value = "";
});

/** 发验证码之前先验证卡密（只校验、不消耗）。 */
async function checkRenewCard() {
  if (renewChecking.value || !renewCard.value.trim()) return;
  renewChecking.value = true;
  renewMsg.value = "";
  const result = await s.checkCard(s.loggedInEmail.value, renewCard.value.trim());
  renewChecking.value = false;
  if (!result) {
    renewMsg.value = s.error.value || "卡密验证失败。";
    return;
  }
  renewCardChecked.value = true;
  renewCardInfo.value = result.card;
  // 续期这一步同样要显示**卡密名称与到期时间**（不是类型与天数），并与注册页口径一致
  renewMsg.value = result.card
    ? `卡密有效：${result.card.name} · ${result.card.expiryText}，可以发送验证码了。`
    : "卡密有效，可以发送验证码了。";
  blessingCard.value = result.card?.blessing
    ? {
        name: result.card.name,
        expiryText: result.card.expiryText,
        expiryDetail: result.card.expiryDetail,
        expiryDays: result.card.expiryDays,
        blessing: result.card.blessing,
      }
    : null;
}

async function sendRenewCode() {
  if (renewSending.value || renewCooldown.value > 0 || !renewCardChecked.value) return;
  renewSending.value = true;
  renewMsg.value = "";
  const res = await s.sendCode(s.loggedInEmail.value, renewCard.value.trim());
  renewSending.value = false;
  if (res) {
    renewMsg.value = `验证码已发送至 ${s.loggedInEmail.value}，请查收。`;
    renewCooldown.value = 60;
    if (renewTimer) clearInterval(renewTimer);
    renewTimer = setInterval(() => {
      renewCooldown.value -= 1;
      if (renewCooldown.value <= 0) {
        if (renewTimer) clearInterval(renewTimer);
        renewTimer = null;
      }
    }, 1000);
  } else {
    renewMsg.value = s.error.value || "验证码发送失败。";
  }
}

const embyAccount = ref<{ embyUserId: string | null; embyUsername: string | null } | null>(null);
const embyPassword = ref("");
const embySaving = ref(false);
const embyMsg = ref("");

onMounted(async () => {
  const ok = await s.loadMember();
  if (ok && s.contentAllowed.value) {
    embyAccount.value = await s.getEmbyAccount();
  }
  void loadMailPrefs();
  void loadArticles();
});

interface ArticleItem {
  code: string;
  title: string;
  content: string;
}
const articles = ref<ArticleItem[]>([]);
const openArticle = ref<string | null>(null);
async function loadArticles() {
  try {
    const response = await portalFetch("/api/public/articles", { credentials: "include" });
    if (response.ok) {
      const body = (await response.json()) as { articles: ArticleItem[] };
      articles.value = body.articles ?? [];
      const announcement = articles.value.find((a) => a.code === "announcement");
      if (announcement) openArticle.value = announcement.code;
    }
  } catch {
    /* 忽略 */
  }
}

interface MailTypeItem {
  key: string;
  label: string;
  desc?: string;
}
const mailTypes = ref<MailTypeItem[]>([]);
const mailEffective = ref<Record<string, boolean>>({});
const mailOverridden = ref<Record<string, boolean>>({});
const mailSaving = ref<string | null>(null);
async function loadMailPrefs() {
  try {
    const response = await portalFetch("/api/public/mail-preferences", { credentials: "include" });
    if (response.ok) {
      const body = (await response.json()) as {
        mailTypes: MailTypeItem[];
        defaults: Record<string, boolean>;
        userPrefs: Record<string, boolean | null>;
        effective: Record<string, boolean>;
      };
      mailTypes.value = body.mailTypes ?? [];
      mailEffective.value = body.effective ?? {};
      mailOverridden.value = Object.fromEntries(
        Object.entries(body.userPrefs ?? {}).filter(([, v]) => v != null),
      ) as Record<string, boolean>;
    }
  } catch {
    /* 忽略 */
  }
}
async function toggleMail(type: string) {
  mailSaving.value = type;
  try {
    const current = mailEffective.value[type];
    await portalFetch("/api/public/mail-preferences", {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mailType: type, enabled: !current }),
    });
    await loadMailPrefs();
  } finally {
    mailSaving.value = null;
  }
}
async function resetMail(type: string) {
  mailSaving.value = type;
  try {
    await portalFetch("/api/public/mail-preferences", {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mailType: type, enabled: null }),
    });
    await loadMailPrefs();
  } finally {
    mailSaving.value = null;
  }
}

function memberStatusText(status: string): string {
  return { active: "有效", expiring: "即将到期", expired: "已过期", none: "未开通" }[status] ?? status;
}

async function submitRenew() {
  if (!renewCardChecked.value) {
    renewMsg.value = "请先验证卡密。";
    return;
  }
  renewBusy.value = true;
  renewMsg.value = "";
  const ok = await s.activate(s.loggedInEmail.value, renewCode.value.trim(), renewCard.value.trim());
  renewBusy.value = false;
  if (ok) {
    renewCode.value = "";
    renewCard.value = "";
    renewCardChecked.value = false;
    renewCardInfo.value = null;
    renewMsg.value = "续费/开通成功，会员有效期已更新。";
  } else renewMsg.value = s.error.value || "兑换失败";
}

async function saveEmbyPassword() {
  if (embyPassword.value.length < 6) {
    embyMsg.value = "密码至少 6 位。";
    return;
  }
  embySaving.value = true;
  embyMsg.value = "";
  const ok = await s.changeEmbyPassword(embyPassword.value);
  embySaving.value = false;
  embyMsg.value = ok ? "Emby 密码已更新。" : s.error.value || "修改失败。";
  if (ok) embyPassword.value = "";
}

onBeforeUnmount(() => {
  if (renewTimer) clearInterval(renewTimer);
});
</script>

<template>
  <section class="profile">
    <!-- 未登录 -->
    <div v-if="!s.loggedInEmail.value" class="empty-profile" role="status">
      <div class="empty-icon">👤</div>
      <strong>个人中心</strong>
      <p>登录后查看会员状态、续费兑换与 Emby 账号。</p>
      <button type="button" class="primary" @click="s.loadMember()">重新加载</button>
    </div>

    <template v-else>
      <!-- 账户头卡 -->
      <header class="hero">
        <div class="hero-avatar">{{ s.loggedInEmail.value.slice(0, 1).toUpperCase() }}</div>
        <div class="hero-main">
          <h1>{{ s.loggedInEmail.value }}</h1>
          <div class="hero-meta">
            <span class="member-badge" :class="s.memberStatus.value">{{ memberStatusText(s.memberStatus.value) }}</span>
            <span class="meta-dot"
              >有效期至 <b>{{ s.memberExpiryText.value }}</b>
              <small v-if="s.memberExpiryNote.value">（{{ s.memberExpiryNote.value }}）</small></span
            >
            <span v-if="s.memberEmbyMaxStreams.value" class="meta-dot"
              >同时播放上限 <b>{{ s.memberEmbyMaxStreams.value }}</b> 路</span
            >
          </div>
          <p v-if="s.memberStatus.value === 'expired'" class="expired-note">
            会员已到期，请使用本页卡密续费后浏览影视内容。
          </p>
        </div>
        <button type="button" class="logout" @click="s.logout()">
          <SvgIcon type="mdi" :path="mdiLogout" :size="14" />退出登录
        </button>
      </header>

      <!-- 并发超限：会员进来必须能自己看到"为什么播不了、什么时候解冻"，而不是只看到"有效" -->
      <div v-if="s.memberConcurrency.value?.disabled" class="freeze-note" role="status">
        <strong>账号已因多设备同时播放被暂时冻结</strong>
        <p>
          解冻时间 <b>{{ unfreezeLabel(s.memberConcurrency.value.disabledUntil) }}</b
          >（还剩 {{ remainingLabel(s.memberConcurrency.value.remainingMs) }}）。冻结期间无法浏览影视内容或在 Emby
          播放。会员有效且账号启用时，按解冻规则恢复。
          <template v-if="s.memberStatus.value === 'expired'"
            >请先在本页续费，再按解冻规则恢复；续费不会解除冻结。</template
          >
          <template v-else-if="canSelfUnfreeze">也可以现在自助解冻，不用等到期。</template>
          <template v-else-if="unfreezeBlockedByQuota">本月自助解冻次数已用完，想提前恢复请联系管理员。</template>
          <template v-else>想提前恢复请联系管理员。</template>
        </p>
        <!-- 解冻入口：按钮与说明都由服务端下发的状态决定，不在前端写死口径 -->
        <p v-if="canSelfUnfreeze" class="freeze-action">
          <button type="button" class="unfreeze-btn" @click="openUnfreeze">申请解冻</button>
          <small
            >阅读提示并等待 {{ s.memberUnfreeze.value?.waitSeconds }} 秒后可解冻；本月还可自助解冻
            {{ s.memberUnfreeze.value?.remainingChances }} 次</small
          >
        </p>
      </div>
      <div v-else-if="s.memberConcurrency.value?.overshooting" class="overshoot-note" role="status">
        <strong>检测到同时在线的播放设备超过上限</strong>
        <p>
          同一账号同时只允许 <b>{{ s.memberEmbyMaxStreams.value ?? 1 }}</b> 路，请关掉多余的播放设备。
          继续多路播放会在累计超限满设定时长后冻结账号。
        </p>
      </div>

      <!-- 开通提示：整块文案（标题 + 正文）由后台模板下发（系统设置 →「会员」），
           前端不写死任何一句 —— 端口、地址口径、客服话术都能在后台改。 -->
      <div v-if="s.activatedEmby.value" class="onboard">
        <strong>{{ s.activatedEmby.value.onboardTitle || "🎉 Emby 账号已开通" }}</strong>
        <p class="ob-notice">{{ s.activatedEmby.value.onboardNotice }}</p>
        <button type="button" class="link" @click="s.activatedEmby.value = null">我知道了</button>
      </div>

      <!-- 功能卡网格 -->
      <div class="grid">
        <!-- 续费 / 兑换 -->
        <section class="card">
          <header class="card-head">
            <span class="card-icon green"><SvgIcon type="mdi" :path="mdiTicketConfirmationOutline" :size="17" /></span>
            <div>
              <h2>续费 / 兑换卡密</h2>
              <p>先验证卡密，再获取验证码；从当前到期时间顺延续期。</p>
            </div>
          </header>
          <div class="field-row">
            <input v-model="renewCard" type="text" maxlength="64" placeholder="卡密（月 / 年 / 试用卡）" />
            <button
              type="button"
              class="ghost"
              :disabled="renewChecking || renewCardChecked || !renewCard.trim()"
              @click="checkRenewCard"
            >
              {{ renewChecking ? "验证中…" : renewCardChecked ? "已验证" : "验证卡密" }}
            </button>
          </div>
          <div class="field-row">
            <input v-model="renewCode" type="text" maxlength="6" placeholder="6 位验证码" inputmode="numeric" />
            <button
              type="button"
              class="ghost"
              :disabled="!renewCardChecked || renewSending || renewCooldown > 0"
              @click="sendRenewCode"
            >
              {{ renewSending ? "发送中…" : renewCooldown > 0 ? `${renewCooldown}s` : "发送验证码" }}
            </button>
          </div>
          <button
            type="button"
            class="primary"
            :disabled="renewBusy || !renewCardChecked || renewCode.length < 6"
            @click="submitRenew"
          >
            {{ renewBusy ? "兑换中…" : "确认续费" }}
          </button>
          <p v-if="renewCardInfo" class="card-msg" role="status">
            已验证：{{ renewCardInfo.name }} · 到期时间 {{ renewCardInfo.expiryText
            }}<small v-if="renewCardInfo.expiryDetail">（{{ renewCardInfo.expiryDetail }}）</small>
          </p>
          <p v-if="renewMsg" class="card-msg" role="status">{{ renewMsg }}</p>
        </section>

        <!-- 我的 Emby 账号 -->
        <section v-if="s.contentAllowed.value && embyAccount?.embyUsername" class="card">
          <header class="card-head">
            <span class="card-icon blue"><SvgIcon type="mdi" :path="mdiCheckDecagram" :size="17" /></span>
            <div>
              <h2>我的 Emby 账号</h2>
              <p>
                用户名 <b class="accent-text">{{ embyAccount.embyUsername }}</b>
              </p>
            </div>
          </header>
          <div class="field-row">
            <input
              v-model="embyPassword"
              type="password"
              minlength="6"
              maxlength="200"
              placeholder="新 Emby 密码（至少 6 位）"
              @keyup.enter="saveEmbyPassword"
            />
            <button type="button" class="ghost" :disabled="embySaving" @click="saveEmbyPassword">
              {{ embySaving ? "保存中…" : "修改密码" }}
            </button>
          </div>
          <p v-if="embyMsg" class="card-msg" role="status">{{ embyMsg }}</p>
        </section>

        <!-- 邮件偏好 -->
        <section class="card">
          <header class="card-head">
            <span class="card-icon violet"><SvgIcon type="mdi" :path="mdiEmailOutline" :size="17" /></span>
            <div>
              <h2>邮件通知偏好</h2>
              <p>只管邮件：关闭后不再发送这类邮件（站内不再另发通知）。</p>
            </div>
          </header>
          <div v-if="!mailTypes.length" class="empty">加载中…</div>
          <ul v-else class="mail-pref-list">
            <li v-for="item in mailTypes" :key="item.key">
              <span class="mail-label">
                <span class="mail-name"
                  >{{ item.label
                  }}<small v-if="mailOverridden[item.key] != null" class="mail-override">已自定义</small></span
                >
                <small class="mail-desc">{{ item.desc }}</small>
              </span>
              <span class="mail-actions">
                <button
                  type="button"
                  class="switch"
                  :class="{ on: mailEffective[item.key] }"
                  :aria-pressed="mailEffective[item.key]"
                  :disabled="mailSaving === item.key"
                  @click="toggleMail(item.key)"
                >
                  <i></i>
                </button>
                <button
                  v-if="mailOverridden[item.key] != null"
                  type="button"
                  class="reset"
                  :disabled="mailSaving === item.key"
                  @click="resetMail(item.key)"
                >
                  默认
                </button>
              </span>
            </li>
          </ul>
        </section>
      </div>

      <!-- 平台须知（整宽） -->
      <section class="card wide">
        <header class="card-head">
          <span class="card-icon blue"><span class="bell">📖</span></span>
          <div class="card-head-main">
            <div class="card-title-row"><h2>平台须知</h2></div>
            <p>使用说明、平台规范与免责声明。</p>
          </div>
        </header>
        <div v-if="!articles.length" class="empty">暂无说明内容。</div>
        <div v-else class="article-list">
          <details
            v-for="item in articles"
            :key="item.code"
            class="article"
            :open="openArticle === item.code"
            @toggle="openArticle = ($event.target as HTMLDetailsElement).open ? item.code : openArticle"
          >
            <summary>
              <b>{{ item.title }}</b>
            </summary>
            <div class="article-body">{{ item.content }}</div>
          </details>
        </div>
      </section>
    </template>

    <!-- 自助解冻弹窗：强制显示 + 强制等待（文案后台可改，倒计时以服务端时刻为准） -->
    <UnfreezeModal ref="unfreezeModal" @close="s.loadMember()" />
    <!-- 彩蛋弹窗：续期时验证卡密成功即弹（与注册页同一套口径） -->
    <CardBlessingModal :card="blessingCard" @close="blessingCard = null" />
  </section>
</template>

<style scoped>
/* ===== 布局 ===== */
.profile {
  display: grid;
  gap: 18px;
  max-width: 920px;
  margin: 0 auto;
}
.grid {
  display: grid;
  gap: 18px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.card.wide {
  grid-column: 1 / -1;
}

/* ===== 账户头卡 ===== */
.hero {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 22px 24px;
  border: 1px solid #24394a;
  border-radius: 16px;
  background: linear-gradient(135deg, #122330, #0c1a24 60%);
  box-shadow: 0 12px 32px rgb(0 0 0 / 24%);
}
.hero-avatar {
  width: 58px;
  height: 58px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: #07120d;
  background: linear-gradient(135deg, #7fd08a, #57a35d);
  font-size: 26px;
  font-weight: 800;
  flex: none;
  box-shadow: 0 6px 18px rgb(93 175 93 / 30%);
}
.hero-main {
  min-width: 0;
  flex: 1;
}
.hero-main h1 {
  margin: 0 0 7px;
  font-size: 21px;
  font-weight: 780;
  color: #eef2f4;
  word-break: break-all;
}
.hero-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  font-size: 12px;
  color: #8a97a1;
}
.member-badge {
  padding: 3px 10px;
  border-radius: 999px;
  font-weight: 700;
  font-size: 11px;
}
.member-badge.active {
  color: #9fe3a5;
  background: rgb(93 175 93 / 16%);
  border: 1px solid rgb(93 175 93 / 30%);
}
.member-badge.expiring {
  color: #e6c06a;
  background: rgb(120 90 24 / 18%);
  border: 1px solid rgb(230 192 106 / 30%);
}
.member-badge.expired {
  color: #ef8585;
  background: rgb(150 55 55 / 18%);
  border: 1px solid rgb(239 133 133 / 30%);
}
.member-badge.none {
  color: #8a97a1;
  background: rgb(90 100 110 / 16%);
  border: 1px solid rgb(90 100 110 / 24%);
}
.meta-dot b {
  color: #cdd5dc;
}
.expired-note {
  margin: 8px 0 0;
  color: #ef8585;
  font-size: 12px;
}
/* 冻结 / 超限提示：这是会员自己判断"要不要联系管理员"的唯一依据，别做得太轻。 */
.freeze-note,
.overshoot-note {
  margin: 14px 0 0;
  padding: 12px 16px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.7;
}
.freeze-note {
  border: 1px solid #6b2b2b;
  background: #1d1213;
  color: #f0b4b4;
}
.overshoot-note {
  border: 1px solid #6b5a2b;
  background: #1d1a12;
  color: #e8d59a;
}
.freeze-note strong,
.overshoot-note strong {
  display: block;
  margin-bottom: 4px;
  color: #ffffff;
  font-size: 14px;
}
.freeze-note p,
.overshoot-note p {
  margin: 0;
}
/* 解冻入口：冻结提示里的主操作，按钮要够显眼（会员此刻只想让账号能用）。 */
.freeze-action {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-top: 10px !important;
}
.unfreeze-btn {
  min-height: 36px;
  padding: 0 16px;
  border: 1px solid #7d3636;
  border-radius: 9px;
  color: #ffe9e9;
  background: linear-gradient(180deg, #a83c3c, #8b2f2f);
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition:
    transform 0.16s,
    filter 0.16s;
}
.unfreeze-btn:hover {
  transform: translateY(-1px);
  filter: brightness(1.08);
}
.freeze-action small {
  color: #d79a9a;
  font-size: 12px;
  line-height: 1.6;
}
.logout {
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 13px;
  border: 1px solid #33454f;
  border-radius: 10px;
  color: #a7b2ba;
  background: #0e1a22;
  cursor: pointer;
  font-size: 12px;
  transition:
    border-color 0.18s,
    color 0.18s;
}
.logout:hover {
  border-color: #734444;
  color: #ef8585;
}

/* ===== 卡片 ===== */
.card {
  display: grid;
  gap: 12px;
  padding: 18px;
  border: 1px solid #1f313d;
  border-radius: 14px;
  background: linear-gradient(180deg, #0c171f, #0a141b 80%);
  box-shadow: 0 8px 22px rgb(0 0 0 / 16%);
  align-content: start;
}
.card-head {
  display: flex;
  align-items: flex-start;
  gap: 11px;
}
.card-head-main {
  min-width: 0;
  flex: 1;
}
.card-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.card-head h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 740;
  color: #eef2f4;
}
.card-head p {
  margin: 3px 0 0;
  color: #7d8794;
  font-size: 11.5px;
}
.card-icon {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  flex: none;
}
.card-icon.green {
  color: #7fd08a;
  background: rgb(93 175 93 / 12%);
}
.card-icon.blue {
  color: #8fb7e8;
  background: rgb(60 120 180 / 14%);
}
.card-icon.amber {
  color: #e6c06a;
  background: rgb(150 110 30 / 12%);
}
.card-icon.violet {
  color: #c0a9e6;
  background: rgb(120 90 170 / 14%);
}
.card-icon .bell {
  font-size: 15px;
}
.accent-text {
  color: #8fd98f;
}
.card-msg {
  margin: 0;
  padding: 9px 11px;
  border-radius: 9px;
  color: #a9e5b0;
  background: #0e2016;
  font-size: 12px;
}

/* ===== 表单 ===== */
input {
  width: 100%;
  min-height: 40px;
  padding: 0 12px;
  border: 1px solid #2a3c46;
  border-radius: 9px;
  color: #eef2f4;
  background: #0a151c;
  outline: 0;
  box-sizing: border-box;
  font-size: 13px;
  transition:
    border-color 0.18s,
    box-shadow 0.18s;
}
input:focus {
  border-color: #5aa95a;
  box-shadow: 0 0 0 3px rgb(93 175 93 / 16%);
}
input::placeholder {
  color: #5c6c76;
}
.field-row {
  display: flex;
  gap: 8px;
}
.field-row input {
  flex: 1;
  min-width: 0;
}
.field-row .ghost {
  flex: none;
}
button.primary {
  min-height: 40px;
  padding: 0 16px;
  border: 0;
  border-radius: 9px;
  color: #07120d;
  background: linear-gradient(180deg, #74c574, #5aa95a);
  font-weight: 760;
  cursor: pointer;
  width: 100%;
  box-shadow: 0 8px 20px rgb(93 175 93 / 22%);
  transition:
    transform 0.16s,
    box-shadow 0.16s;
}
button.primary:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 11px 26px rgb(93 175 93 / 30%);
}
button.primary:disabled {
  opacity: 0.5;
  cursor: default;
  box-shadow: none;
}
button.ghost {
  min-height: 36px;
  padding: 0 13px;
  border: 1px solid #2a3c46;
  border-radius: 9px;
  color: #c2ccd3;
  background: #0e1a22;
  cursor: pointer;
  font-size: 12px;
  transition:
    border-color 0.16s,
    color 0.16s,
    background-color 0.16s;
}
button.ghost:hover:not(:disabled) {
  border-color: #3f5a6b;
  color: #eef2f4;
}
button.ghost:disabled {
  opacity: 0.55;
  cursor: default;
}
button.link {
  min-height: auto;
  padding: 4px 0;
  border: 0;
  background: transparent;
  color: #8fb7e8;
  cursor: pointer;
  font-size: 12px;
}

/* ===== 邮件偏好 ===== */
.mail-pref-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 7px;
}
.mail-pref-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 11px;
  border: 1px solid #1c2c36;
  border-radius: 9px;
  background: #0a151c;
}
.mail-label {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.mail-name {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #cdd5dc;
  font-size: 12.5px;
}
.mail-desc {
  color: #63727d;
  font-size: 10.5px;
}
.mail-override {
  padding: 1px 6px;
  border-radius: 999px;
  color: #e6c06a;
  background: rgb(120 90 24 / 14%);
  font-size: 9.5px;
}
.mail-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
button.switch {
  position: relative;
  width: 40px;
  height: 22px;
  border: 0;
  border-radius: 999px;
  background: #22323d;
  cursor: pointer;
  transition: background-color 0.18s;
}
button.switch i {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #93a1ab;
  transition:
    transform 0.18s,
    background-color 0.18s;
}
button.switch.on {
  background: #3f7d45;
}
button.switch.on i {
  transform: translateX(18px);
  background: #c8f0cc;
}
button.switch:disabled {
  opacity: 0.55;
}
button.reset {
  min-height: 24px;
  padding: 0 9px;
  border: 1px solid #2a3c46;
  border-radius: 999px;
  color: #8a97a1;
  background: transparent;
  font-size: 10.5px;
  cursor: pointer;
}
button.reset:hover {
  color: #c2ccd3;
}

/* ===== 平台须知 ===== */
.article-list {
  display: grid;
  gap: 8px;
}
.article {
  border: 1px solid #1c2c36;
  border-radius: 10px;
  background: #0a151c;
}
.article summary {
  padding: 11px 13px;
  color: #cdd5dc;
  font-size: 13px;
  cursor: pointer;
  list-style: none;
}
.article summary::marker {
  display: none;
}
.article summary::before {
  content: "▸ ";
  color: #5c6c76;
}
.article[open] summary::before {
  content: "▾ ";
  color: #7fd08a;
}
.article-body {
  padding: 0 13px 12px;
  color: #8a97a1;
  font-size: 12px;
  line-height: 1.8;
  white-space: pre-wrap;
}

/* ===== 共用 ===== */
.empty {
  padding: 18px;
  border: 1px dashed #22303b;
  border-radius: 10px;
  color: #63727d;
  font-size: 12px;
  text-align: center;
}
.empty-profile {
  display: grid;
  gap: 10px;
  justify-items: center;
  padding: 46px 20px;
  border: 1px dashed #22303b;
  border-radius: var(--radius-lg);
  text-align: center;
}
.empty-profile strong {
  font-size: 18px;
}
.empty-profile p {
  margin: 0;
  color: var(--text-dim);
}
.empty-icon {
  width: 54px;
  height: 54px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: #12201f;
  font-size: 24px;
}
.onboard {
  padding: 14px 16px;
  border: 1px solid #234d2f;
  border-radius: 12px;
  background: #0e1f16;
}
.onboard strong {
  color: #7fd08a;
  font-size: 13px;
}
/* 后台模板可能有多行（地址/账号/密码各占一行）：pre-wrap 保原样换行，别挤成一行。 */
.ob-notice {
  margin: 8px 0 10px;
  color: #b9c4cc;
  font-size: 12px;
  line-height: 1.8;
  white-space: pre-wrap;
}

@media (max-width: 760px) {
  .grid {
    grid-template-columns: 1fr;
  }
  .hero {
    flex-wrap: wrap;
    padding: 16px;
  }
  .hero-avatar {
    width: 46px;
    height: 46px;
    font-size: 20px;
  }
  .logout {
    margin-left: auto;
  }
}
</style>
