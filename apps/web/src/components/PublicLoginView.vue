<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import { mdiArrowLeft, mdiEmailOutline, mdiLogin, mdiShieldKeyOutline, mdiTicketConfirmationOutline } from "@mdi/js";
import { onBeforeUnmount, ref, watch } from "vue";

import type { CardCheckInfo } from "../composables/usePortalSession";
import { usePortalSession } from "../composables/usePortalSession";
import CardBlessingModal, { type CardBlessingInfo } from "./CardBlessingModal.vue";
import AppVersion from "./AppVersion.vue";

const s = usePortalSession();

/**
 * 三步页：
 *  email    第一步，**只有一个邮箱**；点「下一步」由服务端判断注册过没有
 *  login    注册过 → 发验证码 → 输入验证码登录（过期也算注册过，续费去「我的」页）
 *  register 没注册过 → 先验证卡密 → 解锁「发送验证码」→ 输入验证码开通
 */
const step = ref<"email" | "login" | "register">("email");
const code = ref("");
const cardCode = ref("");
const booting = ref(false);
const sendingCode = ref(false);
const checkingCard = ref(false);
/** 卡密是否已验证通过：没通过就不解锁「发送验证码」。 */
const cardChecked = ref(false);
const cardInfo = ref<CardCheckInfo | null>(null);
/** 彩蛋弹窗要显示的内容；null = 不弹（这张卡没配祝福文案，或还没验证）。 */
const blessingCard = ref<CardBlessingInfo | null>(null);
/** 这封验证码是否已经发出去了（登录页文案与倒计时据此变化）。 */
const sent = ref(false);
/** 注册页的轻提示（卡密有效 / 换过卡密要重新验证）。 */
const registerTip = ref("");
/** 会员已到期（只影响提示文案；照样能登录）。 */
const expired = ref(false);
/** 60 秒重发冷却。 */
const cooldown = ref(0);
let cooldownTimer: ReturnType<typeof setInterval> | null = null;

function stopCooldown() {
  if (cooldownTimer) clearInterval(cooldownTimer);
  cooldownTimer = null;
}

function startCooldown() {
  cooldown.value = 60;
  stopCooldown();
  cooldownTimer = setInterval(() => {
    cooldown.value -= 1;
    if (cooldown.value <= 0) {
      cooldown.value = 0;
      stopCooldown();
    }
  }, 1000);
}

onBeforeUnmount(stopCooldown);

// 换卡密就作废上一次的验证结果；若验证码已经发出去了，一并作废——
// 那封码在服务端绑的是旧卡密，留着只会换来一次 card_mismatch。
watch(cardCode, () => {
  if (!cardChecked.value && !sent.value) return;
  cardChecked.value = false;
  cardInfo.value = null;
  blessingCard.value = null;
  sent.value = false;
  code.value = "";
  s.error.value = "";
  registerTip.value = "卡密已更换，请重新验证卡密后获取验证码。";
});

/** 第一步：判断该走登录还是注册。 */
async function nextStep() {
  const address = s.email.value.trim();
  if (!address || booting.value || s.loading.value) return;
  booting.value = true;
  try {
    const entry = await s.checkEntry(address);
    if (!entry) return;
    expired.value = entry.expired;
    step.value = entry.needsCard ? "register" : "login";
  } finally {
    booting.value = false;
  }
}

/** 注册页：先验证卡密（只校验、不消耗）。 */
async function verifyCard() {
  const address = s.email.value.trim();
  if (!address || checkingCard.value || s.loading.value) return;
  checkingCard.value = true;
  try {
    const result = await s.checkCard(address, cardCode.value.trim());
    if (!result) return;
    cardInfo.value = result.card;
    cardChecked.value = true;
    // 验证通过后要显示的**是卡密名称与到期时间**（不是类型和天数）：管理员给卡起的名字
    // 与写的到期口径在这里第一次对用户可见，不能又变回"月卡 · 30 天"。
    registerTip.value = result.card
      ? `卡密有效：${result.card.name} · ${result.card.expiryText}，现在可以发送验证码了。`
      : "卡密有效，现在可以发送验证码了。";
    // 彩蛋：只有配了祝福文案的卡才弹（没配就不弹，不拿一句通用祝福糊弄）
    blessingCard.value = result.card?.blessing
      ? {
          name: result.card.name,
          expiryText: result.card.expiryText,
          expiryDetail: result.card.expiryDetail,
          expiryDays: result.card.expiryDays,
          blessing: result.card.blessing,
        }
      : null;
  } finally {
    checkingCard.value = false;
  }
}

/** 发验证码：注册页必须先过卡密验证；60 秒内不能重发。 */
async function send() {
  const address = s.email.value.trim();
  if (!address || sendingCode.value || cooldown.value > 0) return;
  if (step.value === "register" && !cardChecked.value) return;
  sendingCode.value = true;
  try {
    const result = await s.sendCode(address, step.value === "register" ? cardCode.value.trim() : undefined);
    if (!result) return;
    sent.value = true;
    expired.value = result.expired;
    startCooldown();
  } finally {
    sendingCode.value = false;
  }
}

function backToEmail() {
  step.value = "email";
  code.value = "";
  cardCode.value = "";
  cardChecked.value = false;
  cardInfo.value = null;
  blessingCard.value = null;
  sent.value = false;
  registerTip.value = "";
  expired.value = false;
  cooldown.value = 0;
  stopCooldown();
  s.error.value = "";
}

async function submit() {
  if (s.loading.value || code.value.length < 6) return;
  const address = s.email.value.trim();
  if (step.value === "register") {
    if (!cardChecked.value) {
      s.error.value = "请先验证卡密";
      return;
    }
    await s.activate(address, code.value, cardCode.value.trim());
  } else {
    await s.loginWithCode(address, code.value);
  }
  if (s.loggedInEmail.value) {
    step.value = "email";
    code.value = "";
    cardCode.value = "";
    cardChecked.value = false;
    cardInfo.value = null;
    blessingCard.value = null;
    sent.value = false;
  }
}

const title = () => ({ email: "登录 / 开通会员", login: "验证邮箱", register: "用卡密开通会员" })[step.value];
const sendLabel = () =>
  sendingCode.value ? "发送中…" : cooldown.value > 0 ? `${cooldown.value}s` : sent.value ? "重新发送" : "发送验证码";
</script>

<template>
  <div class="login-screen">
    <div class="login-orb orb-a" aria-hidden="true"></div>
    <div class="login-orb orb-b" aria-hidden="true"></div>

    <section class="login-card" aria-labelledby="login-title">
      <div class="brand">
        <img src="/logo.svg" alt="" aria-hidden="true" />
        <span>影视中心</span>
      </div>

      <div class="card-head">
        <h1 id="login-title">{{ title() }}</h1>
        <p v-if="step === 'email'">登录后可查看影视库、热榜与会员信息，未登录不会展示任何内容。</p>
        <p v-else-if="step === 'login'">
          <template v-if="sent"
            >验证码已发送至 <b>{{ s.email.value }}</b
            >，请查收。</template
          >
          <template v-else
            >该邮箱已注册，验证码将发送至 <b>{{ s.email.value }}</b
            >。</template
          >
          <template v-if="expired">会员已到期，登录后可在「我的 → 续费 / 兑换卡密」续费。</template>
        </p>
        <p v-else>这个邮箱还没有注册过。输入卡密验证通过后，即可发送验证码开通会员。</p>
      </div>

      <!-- 第 1 步：只有邮箱 -->
      <form v-if="step === 'email'" class="login-form" @submit.prevent="nextStep">
        <label for="login-email">会员邮箱</label>
        <div class="field">
          <SvgIcon type="mdi" :path="mdiEmailOutline" :size="20" aria-hidden="true" />
          <input
            id="login-email"
            v-model="s.email.value"
            type="email"
            required
            autocomplete="email"
            placeholder="you@example.com"
          />
        </div>

        <p v-if="s.error.value" class="notice error" role="alert">{{ s.error.value }}</p>

        <button type="submit" class="primary" :disabled="booting || s.loading.value || !s.email.value.trim()">
          {{ booting ? "查询中…" : "下一步" }}
        </button>
      </form>

      <!-- 第 2 步 A：注册过的 → 验证码登录 -->
      <form v-else-if="step === 'login'" class="login-form" @submit.prevent="submit">
        <label for="login-code">验证码</label>
        <div class="field">
          <SvgIcon type="mdi" :path="mdiShieldKeyOutline" :size="20" aria-hidden="true" />
          <input
            id="login-code"
            v-model="code"
            type="text"
            inputmode="numeric"
            maxlength="6"
            placeholder="6 位验证码"
          />
        </div>

        <button type="button" class="ghost" :disabled="sendingCode || cooldown > 0" @click="send">
          {{ sendLabel() }}
        </button>

        <p v-if="s.error.value" class="notice error" role="alert">{{ s.error.value }}</p>

        <button type="submit" class="primary" :disabled="s.loading.value || code.length < 6">
          <SvgIcon type="mdi" :path="mdiLogin" :size="17" aria-hidden="true" />
          {{ s.loading.value ? "验证中…" : "登录" }}
        </button>

        <button type="button" class="link" :disabled="s.loading.value" @click="backToEmail">
          <SvgIcon type="mdi" :path="mdiArrowLeft" :size="14" aria-hidden="true" />
          返回修改邮箱
        </button>
      </form>

      <!-- 第 2 步 B：没注册过的 → 卡密开通 -->
      <form v-else class="login-form" @submit.prevent="cardChecked ? submit() : verifyCard()">
        <label for="login-card">卡密</label>
        <div class="field">
          <SvgIcon type="mdi" :path="mdiTicketConfirmationOutline" :size="20" aria-hidden="true" />
          <input id="login-card" v-model="cardCode" type="text" maxlength="64" placeholder="月卡 / 年卡 / 试用卡" />
        </div>

        <button
          type="button"
          class="ghost"
          :disabled="checkingCard || cardChecked || !cardCode.trim()"
          @click="verifyCard"
        >
          {{ checkingCard ? "验证中…" : cardChecked ? "卡密已验证" : "验证卡密" }}
        </button>

        <p v-if="registerTip" class="notice ok" role="status">{{ registerTip }}</p>

        <!-- 验证通过后的卡密摘要：名称 + 到期时间（名称优先，真实日期做小字） -->
        <div v-if="cardInfo" class="card-summary" role="status">
          <span class="summary-icon"><SvgIcon type="mdi" :path="mdiTicketConfirmationOutline" :size="15" /></span>
          <div class="summary-body">
            <strong>{{ cardInfo.name }}</strong>
            <span class="summary-expiry">
              到期时间：{{ cardInfo.expiryText }}
              <small v-if="cardInfo.expiryDetail">（{{ cardInfo.expiryDetail }}）</small>
            </span>
          </div>
        </div>

        <label for="login-code">验证码</label>
        <div class="field">
          <SvgIcon type="mdi" :path="mdiShieldKeyOutline" :size="20" aria-hidden="true" />
          <input
            id="login-code"
            v-model="code"
            type="text"
            inputmode="numeric"
            maxlength="6"
            placeholder="6 位验证码"
          />
        </div>

        <button type="button" class="ghost" :disabled="!cardChecked || sendingCode || cooldown > 0" @click="send">
          {{ sendLabel() }}
        </button>

        <p v-if="s.error.value" class="notice error" role="alert">{{ s.error.value }}</p>

        <button type="submit" class="primary" :disabled="s.loading.value || code.length < 6">
          <SvgIcon type="mdi" :path="mdiLogin" :size="17" aria-hidden="true" />
          {{ s.loading.value ? "验证中…" : "开通并登录" }}
        </button>

        <button type="button" class="link" :disabled="s.loading.value" @click="backToEmail">
          <SvgIcon type="mdi" :path="mdiArrowLeft" :size="14" aria-hidden="true" />
          返回修改邮箱
        </button>
      </form>
    </section>

    <footer class="login-footer">
      <a href="/login">管理端口 · 管理员登录</a>
      <AppVersion />
    </footer>

    <!-- 彩蛋弹窗：验证卡密成功时弹，内容全部来自服务端预检结果 -->
    <CardBlessingModal :card="blessingCard" @close="blessingCard = null" />
  </div>
</template>

<style scoped>
.login-screen {
  position: relative;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 28px;
  padding: 24px 18px 40px;
  overflow: hidden;
  color: var(--text);
  background:
    radial-gradient(1000px 520px at 18% -10%, rgb(34 84 58 / 28%), transparent 60%),
    radial-gradient(900px 480px at 90% 110%, rgb(30 70 104 / 26%), transparent 55%),
    linear-gradient(180deg, #04101a 0%, #071821 55%, #050e16 100%);
}
.login-orb {
  position: absolute;
  border-radius: 50%;
  filter: blur(90px);
  opacity: 0.5;
  pointer-events: none;
}
.orb-a {
  width: 320px;
  height: 320px;
  top: -120px;
  right: -80px;
  background: rgb(67 153 111 / 38%);
}
.orb-b {
  width: 300px;
  height: 300px;
  bottom: -100px;
  left: -70px;
  background: rgb(53 118 168 / 34%);
}

.login-card {
  position: relative;
  z-index: 1;
  width: min(100%, 400px);
  padding: 32px;
  border: 1px solid rgb(84 122 140 / 32%);
  border-radius: 20px;
  background: rgb(7 18 26 / 86%);
  box-shadow: 0 24px 70px rgb(0 0 0 / 48%);
  backdrop-filter: blur(16px);
}
.brand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-bottom: 24px;
}
.brand img {
  width: 40px;
  height: 40px;
  object-fit: contain;
  filter: drop-shadow(0 4px 14px rgb(94 208 141 / 24%));
}
.brand span {
  font-size: 17px;
  font-weight: 800;
  letter-spacing: 0.3px;
}
.card-head {
  margin-bottom: 22px;
}
.card-head h1 {
  margin: 0 0 8px;
  font-size: 22px;
  font-weight: 800;
  color: #f2f6f8;
  letter-spacing: 0.2px;
}
.card-head p {
  margin: 0;
  color: #8aa0ab;
  font-size: 13px;
  line-height: 1.6;
}
.card-head p b {
  color: #b8e6c6;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.login-form label {
  color: #a9bcc7;
  font-size: 12px;
  font-weight: 700;
}
.field {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 46px;
  padding: 0 14px;
  border: 1px solid #2a4553;
  border-radius: 12px;
  color: #647c88;
  background: rgb(8 21 30 / 82%);
  transition:
    border-color 0.18s ease,
    box-shadow 0.18s ease;
}
.field:focus-within {
  border-color: #4fae72;
  box-shadow: 0 0 0 3px rgb(79 174 114 / 16%);
}
.field input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  color: #eef4f6;
  background: transparent;
  font-size: 14px;
}
.field input::placeholder {
  color: #5a7481;
}

.notice {
  margin: 0;
  padding: 9px 12px;
  border-radius: 9px;
  font-size: 12px;
  line-height: 1.5;
}
.notice.error {
  color: #f0a4a4;
  background: rgb(128 44 44 / 22%);
  border: 1px solid rgb(173 71 71 / 30%);
}
.notice.ok {
  color: #a8e0bd;
  background: rgb(38 92 60 / 26%);
  border: 1px solid rgb(79 174 114 / 34%);
}

/* 卡密摘要：验证通过后把"哪张卡、什么时候到期"摆出来，而不是只留一句提示 */
.card-summary {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid rgb(79 174 114 / 30%);
  border-radius: 10px;
  background: rgb(30 74 48 / 22%);
}
.summary-icon {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  color: #a8e0bd;
  background: rgb(79 174 114 / 16%);
  flex: none;
}
.summary-body {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.summary-body strong {
  color: #dff3e6;
  font-size: 13.5px;
  font-weight: 740;
}
.summary-expiry {
  color: #9fc4ae;
  font-size: 11.5px;
}
.summary-expiry small {
  color: #6d8b7a;
  font-size: 10.5px;
}

.primary {
  min-height: 46px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 0;
  border-radius: 12px;
  color: #071610;
  background: linear-gradient(180deg, #6fd08d, #3fa862);
  font-size: 14px;
  font-weight: 800;
  cursor: pointer;
  transition:
    transform 0.14s ease,
    filter 0.18s ease,
    opacity 0.18s ease;
}
.primary:hover:not(:disabled) {
  filter: brightness(1.08);
  transform: translateY(-1px);
}
.primary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  transform: none;
}

.ghost {
  min-height: 42px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid #2a4553;
  border-radius: 12px;
  color: #b6d3de;
  background: rgb(8 21 30 / 72%);
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition:
    border-color 0.18s ease,
    color 0.18s ease,
    opacity 0.18s ease;
}
.ghost:hover:not(:disabled) {
  border-color: #4fae72;
  color: #d8f2e3;
}
.ghost:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 36px;
  border: 0;
  color: #86a4b1;
  background: transparent;
  font-size: 12px;
  cursor: pointer;
}
.link:hover {
  color: #b8d8e4;
}
.link:disabled {
  opacity: 0.5;
  cursor: default;
}

.login-footer {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  justify-content: center;
  padding-bottom: 2px;
}
.login-footer a {
  color: #6d8794;
  font-size: 12px;
  text-decoration: none;
  letter-spacing: 0.3px;
  transition: color 0.18s ease;
}
.login-footer a:hover {
  color: #b9d4df;
  text-decoration: underline;
}

@media (max-width: 480px) {
  .login-card {
    padding: 26px 20px;
  }
  .brand span {
    font-size: 15px;
  }
  .card-head h1 {
    font-size: 19px;
  }
}
</style>
