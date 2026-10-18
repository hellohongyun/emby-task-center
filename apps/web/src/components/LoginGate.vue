<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import { mdiAccountOutline, mdiLockOutline } from "@mdi/js";
import { ref } from "vue";
import AppVersion from "./AppVersion.vue";

const props = defineProps<{
  /** 用户名可选：留空时后端按"只校验口令"处理（兼容旧调用）。 */
  login: (password: string, username?: string) => Promise<boolean>;
  error?: string;
}>();

/** 首次部署的默认管理员账号；改过账号后浏览器/密码管理器会记住。 */
const DEFAULT_USERNAME = "admin";
const username = ref(DEFAULT_USERNAME);
const password = ref("");
const busy = ref(false);

async function submit() {
  if (!password.value || busy.value) return;
  busy.value = true;
  try {
    const name = username.value.trim();
    if (!(await props.login(password.value, name || undefined))) password.value = "";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="login-screen">
    <section class="login-card" aria-labelledby="login-title">
      <img class="mark" src="/logo.svg" alt="" aria-hidden="true" />
      <span class="eyebrow">PRIVATE MEDIA LIBRARY</span>
      <h1 id="login-title">媒体任务中心</h1>
      <p>这是家庭共享管理站。用管理员账号登录后，可以发布和查看所有媒体任务。</p>

      <form @submit.prevent="submit" :aria-busy="busy">
        <label for="admin-username">管理员账号</label>
        <div class="field">
          <SvgIcon type="mdi" :path="mdiAccountOutline" :size="20" aria-hidden="true" />
          <input
            id="admin-username"
            v-model="username"
            type="text"
            name="username"
            autocomplete="username"
            autocapitalize="none"
            spellcheck="false"
            maxlength="64"
          />
        </div>
        <label for="admin-password">管理员口令</label>
        <div class="field">
          <SvgIcon type="mdi" :path="mdiLockOutline" :size="20" aria-hidden="true" />
          <input
            id="admin-password"
            v-model="password"
            type="password"
            name="password"
            autocomplete="current-password"
            autocapitalize="none"
            spellcheck="false"
            maxlength="1024"
            autofocus
          />
        </div>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <button type="submit" :disabled="busy || !password">{{ busy ? "验证中…" : "进入任务中心" }}</button>
      </form>

      <small>首次部署的默认账号是 admin / admin123，登录后请在「系统设置」页修改口令。</small>
      <footer class="login-version"><AppVersion /></footer>
    </section>
  </main>
</template>

<style scoped>
.login-screen {
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 24px;
  color: #edf2f4;
}
.login-card {
  position: relative;
  width: min(100%, 410px);
  padding: 38px 36px 32px;
  border: 1px solid #21313b;
  border-radius: var(--radius-lg);
  background: linear-gradient(180deg, #0d1821, #0a141c 72%);
  box-shadow: var(--shadow-lg);
}
.login-card::before {
  content: "";
  position: absolute;
  inset: 0 0 auto;
  height: 1px;
  border-radius: inherit;
  background: linear-gradient(90deg, transparent, rgb(255 255 255 / 10%), transparent);
}
.mark {
  width: 72px;
  height: 72px;
  display: block;
  margin-bottom: 24px;
  object-fit: contain;
  filter: drop-shadow(0 8px 20px rgb(0 0 0 / 42%));
}
.eyebrow {
  color: var(--accent);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.16em;
}
h1 {
  margin: 7px 0 8px;
  font-size: 28px;
  font-weight: 760;
  letter-spacing: 0.2px;
}
.login-card > p {
  margin: 0 0 28px;
  color: var(--text-dim);
  line-height: 1.65;
}
label {
  display: block;
  margin-bottom: 8px;
  color: #cbd3d8;
  font-size: 12px;
  font-weight: 620;
  letter-spacing: 0.2px;
}
.field {
  min-height: 48px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 13px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  color: #71808b;
  background: var(--input);
  transition:
    border-color 0.18s var(--ease),
    box-shadow 0.18s var(--ease);
}
.field:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-dim);
}
input {
  width: 100%;
  border: 0;
  outline: 0;
  color: white;
  background: transparent;
}
.error {
  margin: 10px 0 0;
  color: #f27979;
  font-size: 13px;
}
button {
  width: 100%;
  min-height: 48px;
  margin-top: 18px;
  border: 0;
  border-radius: 9px;
  color: var(--accent-ink);
  background: linear-gradient(180deg, #74c574, #5aa95a);
  font-weight: 760;
  cursor: pointer;
  box-shadow: 0 8px 22px rgb(93 175 93 / 26%);
  transition:
    background-color 0.18s var(--ease),
    box-shadow 0.22s var(--ease),
    transform 0.18s var(--ease);
}
button:hover:not(:disabled) {
  background: linear-gradient(180deg, #7ecd7e, #5db05d);
  box-shadow: 0 12px 28px rgb(93 175 93 / 34%);
  transform: translateY(-1px);
}
button:active:not(:disabled) {
  transform: translateY(0);
  box-shadow: 0 6px 16px rgb(93 175 93 / 22%);
}
button:disabled {
  opacity: 0.55;
  cursor: default;
  box-shadow: none;
}
.login-card small {
  display: block;
  margin-top: 18px;
  color: #6f7d87;
  line-height: 1.5;
  text-align: center;
}
.login-version {
  margin-top: 14px;
  text-align: center;
}
@media (max-width: 480px) {
  .login-card {
    padding: 30px 22px 26px;
  }
}
</style>
