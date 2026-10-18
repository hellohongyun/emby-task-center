<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";

import { usePortalSession } from "../composables/usePortalSession";

/**
 * 自助解冻弹窗：**强制显示 + 强制等待**。
 *
 * 口径：
 *  - 标题与正文都来自后台（服务端已渲染好占位符），前端一句提示语都不写死；
 *  - 等待时长由服务端记的「申请时刻」决定：这里只按 readyAt 显示倒计时，
 *    刷新页面、重开弹窗都不会重新计时（也就没法靠关掉再打开来赖掉等待）；
 *  - 强制显示 = 倒计时期间没有关闭入口（点遮罩不关、没有关闭按钮），
 *    只有「确认解冻」或解冻成功后的「完成」能离开；
 *  - 服务端返回"还没等满"时，以服务端时刻为准重新拉起倒计时（本地时钟不准也绕不过去）。
 */
const s = usePortalSession();
const emit = defineEmits<{ (event: "close"): void }>();

const visible = ref(false);
const phase = ref<"reading" | "waiting" | "ready" | "done" | "blocked">("reading");
const secondsLeft = ref(0);
const message = ref("");
const busy = ref(false);
let timer: ReturnType<typeof setInterval> | null = null;

const status = computed(() => s.memberUnfreeze.value);
const title = computed(() => status.value?.title || "申请提前解冻");
const notice = computed(() => status.value?.notice || "");
/**
 * 两个口径要分清（服务端分开下发）：
 *  - remainingChances：本月**当前**还剩几次（不扣本次）——解冻成功后用它，1/3 用掉后应显示"还剩 2 次"；
 *  - remainingAfterThis：本次解冻后还剩几次——等待期间的前置说明用它。
 * 混用会写出"已用 1 / 3，本月还剩 1 次"这种自相矛盾的文案。
 */
const remainingNow = computed(() => status.value?.remainingChances ?? 0);
const remainingAfter = computed(() => status.value?.remainingAfterThis ?? 0);
const monthlyLimit = computed(() => status.value?.monthlyLimit ?? 0);
const usedThisMonth = computed(() => status.value?.usedThisMonth ?? 0);

function stopTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** 每次都以服务端给的 readyAt 重算：后台标签页被节流、时钟偏差都不会影响口径。 */
function tick() {
  const readyAt = status.value?.readyAt;
  if (!readyAt) return;
  const remainMs = Date.parse(readyAt) - Date.now();
  secondsLeft.value = Number.isFinite(remainMs) ? Math.max(0, Math.ceil(remainMs / 1000)) : 0;
  if (remainMs <= 0) {
    phase.value = "ready";
    stopTimer();
  }
}

function startTimer() {
  stopTimer();
  timer = setInterval(tick, 1_000);
}

/** 打开弹窗：先让服务端记下申请时刻，再按返回的 readyAt 开始倒计时。 */
async function open() {
  visible.value = true;
  phase.value = "reading";
  message.value = "";
  const state = await s.ackUnfreeze();
  if (!state) {
    // 服务端说不能自助解冻（没冻结/次数用完/关了开关）：如实告知并允许关闭，不假装在等待。
    phase.value = "blocked";
    message.value = s.error.value || "暂时无法自助解冻。";
    return;
  }
  phase.value = "waiting";
  tick();
  startTimer();
}

async function submit() {
  if (busy.value || phase.value !== "ready") return;
  busy.value = true;
  message.value = "";
  const ok = await s.confirmUnfreeze();
  busy.value = false;
  if (ok) {
    phase.value = "done";
    stopTimer();
    return;
  }
  message.value = s.error.value || "解冻失败，请稍后再试。";
  // 失败后以服务端状态为准：还在冻结中（比如"还没等满"）就接着倒数；
  // 已经不满足自助解冻条件（冻结到期/次数用完/开关关了）就如实告知并放人走 ——
  // 别把会员锁在一个点不动、也关不掉的弹窗里。
  await s.loadMember();
  const latest = s.memberUnfreeze.value;
  if (latest?.frozen && latest.enabled && latest.readyAt) {
    phase.value = "waiting";
    tick();
    startTimer();
    return;
  }
  phase.value = "blocked";
}

function finish() {
  visible.value = false;
  stopTimer();
  emit("close");
}

onBeforeUnmount(stopTimer);
defineExpose({ open });
</script>

<template>
  <Transition name="fade">
    <div v-if="visible" class="unfreeze-mask" role="dialog" aria-modal="true" :aria-label="title">
      <section class="unfreeze-modal">
        <header>
          <span class="icon">🔒</span>
          <h2>{{ title }}</h2>
        </header>

        <template v-if="phase === 'done'">
          <div class="body done">
            <p>✅ 账号已解冻，现在可以重新登录播放了。</p>
            <p v-if="monthlyLimit > 0" class="done-meta">
              本次已记入本月自助解冻次数：已用 {{ usedThisMonth }} / {{ monthlyLimit }} 次，本月还剩
              {{ remainingNow }} 次。
            </p>
            <p class="done-meta">如果客户端仍提示账号停用，重新登录一次即可。</p>
          </div>
        </template>

        <template v-else>
          <p class="locked-hint">请阅读以下提示，倒计时结束后才能解冻。</p>
          <div class="body">{{ notice }}</div>
          <p v-if="message" class="msg" role="alert">{{ message }}</p>
        </template>

        <footer>
          <button v-if="phase === 'done'" type="button" class="primary" data-testid="unfreeze-finish" @click="finish">
            完成
          </button>
          <button
            v-else-if="phase === 'blocked'"
            type="button"
            class="primary"
            data-testid="unfreeze-close"
            @click="finish"
          >
            知道了
          </button>
          <button
            v-else
            type="button"
            class="primary"
            data-testid="unfreeze-confirm"
            :disabled="phase !== 'ready' || busy"
            @click="submit"
          >
            {{ phase === "ready" ? (busy ? "解冻中…" : "确认解冻") : `请阅读提示（${secondsLeft}s）` }}
          </button>
          <small v-if="phase !== 'done' && monthlyLimit > 0" class="foot-note">
            每月可自助解冻 {{ monthlyLimit }} 次，已用 {{ usedThisMonth }} 次，本次解冻后还剩 {{ remainingAfter }} 次
          </small>
        </footer>
      </section>
    </div>
  </Transition>
</template>

<style scoped>
.unfreeze-mask {
  position: fixed;
  z-index: 95;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgb(2 8 12 / 78%);
  backdrop-filter: blur(6px);
}
.unfreeze-modal {
  width: min(100%, 540px);
  max-height: 86dvh;
  display: flex;
  flex-direction: column;
  border: 1px solid #6b2b2b;
  border-radius: 16px;
  background: linear-gradient(180deg, #1b1214, #0c1016 72%);
  box-shadow: 0 28px 80px rgb(0 0 0 / 58%);
  overflow: hidden;
}
header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 18px 20px 10px;
}
header .icon {
  font-size: 20px;
}
header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 780;
  color: #f4f6f7;
}
.locked-hint {
  margin: 0;
  padding: 0 20px 6px;
  color: #e0a5a5;
  font-size: 12px;
}
.body {
  flex: 1;
  min-height: 0;
  padding: 6px 20px 16px;
  overflow: auto;
  color: #c3ccd3;
  font-size: 13px;
  line-height: 1.9;
  white-space: pre-wrap;
}
.body.done {
  color: #cfe6cf;
}
.body.done p {
  margin: 0 0 10px;
}
.done-meta {
  color: #9aa6ae;
  font-size: 12px;
}
.msg {
  margin: 0;
  padding: 0 20px 10px;
  color: #f0b4b4;
  font-size: 12px;
}
footer {
  display: grid;
  gap: 10px;
  padding: 14px 20px 18px;
  border-top: 1px solid #33232a;
  background: #0b1014;
}
.foot-note {
  color: #8a97a1;
  font-size: 12px;
  line-height: 1.6;
}
button.primary {
  min-height: 44px;
  border: 0;
  border-radius: 10px;
  color: #07120d;
  background: linear-gradient(180deg, #74c574, #5aa95a);
  font-weight: 760;
  font-size: 14px;
  cursor: pointer;
  width: 100%;
  transition: transform 0.16s;
}
button.primary:hover:not(:disabled) {
  transform: translateY(-1px);
}
button.primary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.22s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
