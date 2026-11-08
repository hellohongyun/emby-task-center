<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import { mdiArrowLeft, mdiEmailOutline, mdiLogin, mdiShieldKeyOutline, mdiTicketConfirmationOutline } from "@mdi/js";
import { usePublicLoginFlow } from "../composables/usePublicLoginFlow";
import CardBlessingModal from "./CardBlessingModal.vue";
import AppVersion from "./AppVersion.vue";
import MemberProfileFields from "./MemberProfileFields.vue";
import RegistrationGroupInvite from "./RegistrationGroupInvite.vue";

const {
  s,
  step,
  code,
  cardCode,
  inviteCode,
  groupNumber,
  qqNumber,
  joinSource,
  avatarUrl,
  booting,
  sendingCode,
  checkingCard,
  cardChecked,
  cardInfo,
  blessingCard,
  sent,
  registerTip,
  expired,
  cooldown,
  nextStep,
  verifyCard,
  send,
  backToEmail,
  submit,
  submitProfile,
  reverifyEmail,
  title,
  sendLabel,
} = usePublicLoginFlow();
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
        <p v-if="step === 'email'">首次开通请使用数字 QQ 邮箱，例如 123456789@qq.com。</p>
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
        <p v-else-if="step === 'register'">验证卡密并确认邮箱后，即可填写会员资料。</p>
        <p v-else>联系 QQ 取自已验证的邮箱。确认资料后，卡密将用于开通会员。</p>
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
            :disabled="booting"
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

        <button type="button" class="ghost" :disabled="sendingCode || s.loading.value || cooldown > 0" @click="send">
          {{ sendLabel() }}
        </button>

        <p v-if="s.error.value" class="notice error" role="alert">{{ s.error.value }}</p>

        <button type="submit" class="primary" :disabled="s.loading.value || sendingCode || code.length < 6">
          <SvgIcon type="mdi" :path="mdiLogin" :size="17" aria-hidden="true" />
          {{ s.loading.value ? "验证中…" : "登录" }}
        </button>

        <button type="button" class="link" :disabled="s.loading.value || sendingCode" @click="backToEmail">
          <SvgIcon type="mdi" :path="mdiArrowLeft" :size="14" aria-hidden="true" />
          返回修改邮箱
        </button>
      </form>

      <!-- 第 2 步 B：没注册过的 → 卡密开通 -->
      <form v-else-if="step === 'register'" class="login-form" @submit.prevent="cardChecked ? submit() : verifyCard()">
        <label for="login-card">卡密</label>
        <div class="field">
          <SvgIcon type="mdi" :path="mdiTicketConfirmationOutline" :size="20" aria-hidden="true" />
          <input
            id="login-card"
            v-model="cardCode"
            type="text"
            maxlength="64"
            placeholder="月卡 / 年卡 / 试用卡"
            :disabled="checkingCard || sendingCode || s.loading.value"
          />
        </div>

        <RegistrationGroupInvite
          v-if="groupNumber"
          v-model="inviteCode"
          :group-number="groupNumber"
          :disabled="sendingCode || s.loading.value"
        />

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

        <button
          type="button"
          class="ghost"
          :disabled="
            !cardChecked || (Boolean(groupNumber) && !inviteCode) || sendingCode || s.loading.value || cooldown > 0
          "
          @click="send"
        >
          {{ sendLabel() }}
        </button>

        <p v-if="s.error.value" class="notice error" role="alert">{{ s.error.value }}</p>

        <button type="submit" class="primary" :disabled="s.loading.value || sendingCode || !sent || code.length < 6">
          <SvgIcon type="mdi" :path="mdiLogin" :size="17" aria-hidden="true" />
          {{ s.loading.value ? "验证中…" : "验证邮箱并继续" }}
        </button>

        <button
          type="button"
          class="link"
          :disabled="s.loading.value || sendingCode || checkingCard"
          @click="backToEmail"
        >
          <SvgIcon type="mdi" :path="mdiArrowLeft" :size="14" aria-hidden="true" />
          返回修改邮箱
        </button>
      </form>

      <form v-else class="login-form" @submit.prevent="submitProfile">
        <MemberProfileFields
          v-model:qq-number="qqNumber"
          v-model:join-source="joinSource"
          :avatar-url="avatarUrl"
          readonly-qq
          :disabled="s.loading.value"
        />
        <p v-if="s.error.value" class="notice error" role="alert">{{ s.error.value }}</p>
        <button type="submit" class="primary" :disabled="s.loading.value">
          {{ s.loading.value ? "开通中…" : "开通并登录" }}
        </button>
        <button type="button" class="link" :disabled="s.loading.value" @click="reverifyEmail">
          <SvgIcon type="mdi" :path="mdiArrowLeft" :size="14" aria-hidden="true" />
          返回邮箱验证
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

<style scoped src="./PublicLoginView.css"></style>
