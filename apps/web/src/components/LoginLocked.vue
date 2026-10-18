<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import { mdiClockOutline, mdiTelevisionPlay } from "@mdi/js";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps<{ retryAfterSeconds: number }>();
const emit = defineEmits<{ unlock: [] }>();

const remaining = ref(Math.max(0, props.retryAfterSeconds));
let timer: ReturnType<typeof setInterval> | null = null;

watch(
  () => props.retryAfterSeconds,
  (value) => {
    remaining.value = Math.max(0, value);
  },
);

onMounted(() => {
  timer = setInterval(() => {
    remaining.value -= 1;
    if (remaining.value <= 0) {
      if (timer) clearInterval(timer);
      timer = null;
      emit("unlock");
    }
  }, 1_000);
});

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

const display = computed(() => {
  const total = Math.max(0, remaining.value);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
});
</script>

<template>
  <main class="login-locked">
    <section class="login-card" aria-labelledby="locked-title">
      <span class="mark" aria-hidden="true"><SvgIcon type="mdi" :path="mdiTelevisionPlay" :size="34" /></span>
      <span class="eyebrow">PRIVATE MEDIA LIBRARY</span>
      <h1 id="locked-title">尝试次数过多</h1>
      <p>登录已临时锁定，请等待倒计时结束后再试。</p>
      <div class="countdown" role="timer" aria-live="polite">
        <SvgIcon type="mdi" :path="mdiClockOutline" :size="22" aria-hidden="true" />
        <strong>{{ display }}</strong>
      </div>
      <small>锁定按网络地址记录在服务器上，清理浏览器数据后重进仍会显示剩余时间。</small>
    </section>
  </main>
</template>

<style scoped>
.login-locked {
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 24px;
  color: #edf2f4;
  background: #030b11;
}
.login-card {
  width: min(100%, 410px);
  padding: 36px;
  border: 1px solid #21313b;
  border-radius: 14px;
  background: #0b151d;
  text-align: center;
}
.mark {
  width: 60px;
  height: 60px;
  display: grid;
  place-items: center;
  margin: 0 auto 26px;
  border-radius: 12px;
  color: #07120d;
  background: #68bd68;
}
.eyebrow {
  color: #68bd68;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.16em;
}
h1 {
  margin: 7px 0 8px;
  font-size: 26px;
}
.login-card > p {
  margin: 0 0 24px;
  color: #93a0aa;
  line-height: 1.65;
}
.countdown {
  min-height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border: 1px solid #5e4b1d;
  border-radius: 10px;
  color: #f5c352;
  background: #211c0f;
  font-size: 15px;
}
.countdown strong {
  font-size: 22px;
  font-variant-numeric: tabular-nums;
}
.login-card small {
  display: block;
  margin-top: 18px;
  color: #6f7d87;
  line-height: 1.5;
}
@media (max-width: 480px) {
  .login-card {
    padding: 28px 22px;
  }
}
</style>
