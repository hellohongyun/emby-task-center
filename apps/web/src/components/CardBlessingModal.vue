<script setup lang="ts">
import { mdiClose, mdiPartyPopper } from "@mdi/js";
import SvgIcon from "@jamescoyle/vue-icon";
import { onBeforeUnmount, onMounted } from "vue";

/**
 * 卡密彩蛋弹窗：用户在注册页 / 续费页点「验证卡密」成功后弹出。
 *
 * 三条口径（用户决策，见 docs/card-keys.md）：
 *  ① 只有**配了彩蛋祝福文案**的卡才弹——没配就不弹，不拿一句通用祝福糊弄；
 *  ② 每次验证成功都弹（不是"一张卡只弹一次"），这是彩蛋而不是一次性提示；
 *  ③ 到期时间以管理员写的**名称**为主（如"2027年春节结束到期"），真实日期退到小字。
 *
 * 视觉上刻意做足"仪式感"：这是一次**开奖**，不是一条系统提示。所以有彩带、有逐级入场、
 * 有金色的到期票券；但一切都建立在"文案与字段全部来自后台"之上——前端一句提示语都不写死。
 */
export interface CardBlessingInfo {
  /** 卡密名称（管理员 DIY）；没起名字时服务端已回落成类型标签。 */
  name: string;
  /** 到期主文案：名称优先。 */
  expiryText: string;
  /** 真实到期日小字；相对天数卡为 null。 */
  detail?: string | null;
  /** 兼容旧字段名（服务端给的是 expiryDetail）。 */
  expiryDetail?: string | null;
  /** 剩余天数（固定到期日卡才有）。 */
  expiryDays?: number | null;
  /** 彩蛋祝福文案。 */
  blessing: string;
}

const props = defineProps<{ card: CardBlessingInfo | null }>();
const emit = defineEmits<{ (event: "close"): void }>();

/** 真实到期日小字：两个字段名都认，避免调用方漏传一个就少一行。 */
function detailOf(card: CardBlessingInfo): string | null {
  return card.expiryDetail ?? card.detail ?? null;
}

function close() {
  emit("close");
}

const CONFETTI_COLORS = ["#8fd98f", "#5aa95a", "#f2d08a", "#d9b26a", "#8fb7e8", "#f0a4a4"];

/**
 * 彩带粒子：纯 CSS，不引第三方库（这个项目一路零动画依赖）。
 *
 * 用**下标**算伪随机而不是 Math.random：同一张卡每次打开彩带落点一致，
 * 不会出现"关掉再打开，画面完全变一个样"的闪烁感；每个粒子的横向位置、延迟、
 * 时长、飘移、旋转、尺寸都通过 CSS 变量传进去，24 片共用一套 keyframes。
 */
const confetti = Array.from({ length: 24 }, (_, index) => {
  const rand = (seed: number) => {
    const value = Math.sin(index * 12.9898 + seed * 78.233) * 43758.5453;
    return value - Math.floor(value);
  };
  return {
    left: `${(rand(1) * 100).toFixed(1)}%`,
    delay: `${(rand(2) * 0.9).toFixed(2)}s`,
    duration: `${(2.4 + rand(3) * 1.8).toFixed(2)}s`,
    drift: `${((rand(4) - 0.5) * 140).toFixed(0)}px`,
    spin: `${(rand(5) * 720 - 360).toFixed(0)}deg`,
    size: `${(0.55 + rand(6) * 0.75).toFixed(2)}rem`,
    radius: rand(7) > 0.55 ? "50%" : "2px",
    color: CONFETTI_COLORS[index % CONFETTI_COLORS.length],
  };
});

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && props.card) close();
}

/*
 * 监听常驻、由 handler 判空，而不是 watch(props.card) 去挂/摘。
 * watch 版本有个真实的坑：父组件如果是"带着 card 直接挂载"（v-if 或初始就非 null），
 * watcher 不会触发，Esc 就永远失效；只有 null→card 的过渡才会注册成功。
 * 常驻一个 keydown 监听的成本可以忽略，但少了这条时序陷阱。
 */
onMounted(() => document.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div v-if="card" class="blessing-backdrop" role="dialog" aria-modal="true" aria-labelledby="blessing-title">
    <!-- 全屏彩带：纯装饰，不接事件 -->
    <div class="confetti-layer" aria-hidden="true">
      <i
        v-for="(piece, index) in confetti"
        :key="index"
        class="confetti"
        :style="{
          left: piece.left,
          animationDelay: piece.delay,
          animationDuration: piece.duration,
          background: piece.color,
          width: piece.size,
          height: piece.size,
          borderRadius: piece.radius,
          '--drift': piece.drift,
          '--spin': piece.spin,
        }"
      />
    </div>

    <div class="blessing-card">
      <span class="glow" aria-hidden="true"></span>
      <span class="sheen" aria-hidden="true"></span>

      <button type="button" class="close" aria-label="关闭" @click="close">
        <SvgIcon type="mdi" :path="mdiClose" :size="16" />
      </button>

      <span class="medallion" aria-hidden="true">
        <span class="medallion-ring"></span>
        <SvgIcon type="mdi" :path="mdiPartyPopper" :size="30" />
      </span>

      <p class="eyebrow"><span class="spark"></span>卡密验证成功<span class="spark"></span></p>
      <h2 id="blessing-title">{{ card.name }}</h2>

      <blockquote class="blessing">{{ card.blessing }}</blockquote>

      <div class="ticket">
        <span class="ticket-label">到期时间</span>
        <span class="ticket-main">
          <!-- 主口径是管理员写的名称；真实日期只做小字，避免"名称看着好、日子算不清" -->
          <strong>{{ card.expiryText }}</strong>
          <small v-if="detailOf(card)">{{ detailOf(card) }}</small>
        </span>
        <span v-if="card.expiryDays != null && detailOf(card)" class="ticket-days">
          还剩 <b>{{ card.expiryDays }}</b> 天
        </span>
      </div>

      <button type="button" class="primary" @click="close">开心收下</button>
    </div>
  </div>
</template>

<style scoped>
.blessing-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  padding: 20px;
  background: radial-gradient(120% 90% at 50% 0%, rgb(90 169 90 / 16%), transparent 62%), rgb(3 8 12 / 76%);
  backdrop-filter: blur(4px);
  animation: fade 0.22s ease-out;
}

/* ===== 彩带 ===== */
.confetti-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}
.confetti {
  position: absolute;
  top: -12vh;
  display: block;
  opacity: 0;
  animation-name: fall;
  animation-timing-function: cubic-bezier(0.35, 0.1, 0.6, 1);
  animation-fill-mode: forwards;
}

/* ===== 卡片本体 ===== */
.blessing-card {
  position: relative;
  width: min(430px, 100%);
  padding: 30px 26px 24px;
  border: 1px solid rgb(217 178 106 / 34%);
  border-radius: 20px;
  background: linear-gradient(180deg, #13291d 0%, #0d1a15 46%, #0a141b 100%);
  box-shadow:
    0 30px 70px rgb(0 0 0 / 58%),
    0 0 0 1px rgb(143 217 143 / 8%) inset,
    0 -40px 80px -40px rgb(93 175 93 / 30%) inset;
  text-align: center;
  overflow: hidden;
  animation: card-in 0.46s cubic-bezier(0.2, 0.9, 0.25, 1.32) both;
}
/* 顶部光晕 + 一道缓慢扫过的柔光，让卡片"活着"而不是一张静止的图 */
.glow {
  position: absolute;
  top: -110px;
  left: 50%;
  width: 300px;
  height: 300px;
  transform: translateX(-50%);
  background: radial-gradient(circle, rgb(143 217 143 / 30%), transparent 66%);
  pointer-events: none;
  animation: breathe 3.6s ease-in-out infinite;
}
.sheen {
  position: absolute;
  top: -60%;
  left: -30%;
  width: 40%;
  height: 220%;
  transform: rotate(18deg);
  background: linear-gradient(90deg, transparent, rgb(255 255 255 / 7%), transparent);
  pointer-events: none;
  animation: sheen 5.5s ease-in-out 0.7s infinite;
}

.close {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 2;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 1px solid rgb(217 178 106 / 22%);
  border-radius: 9px;
  color: #9aa6ae;
  background: rgb(10 20 27 / 72%);
  cursor: pointer;
  transition:
    border-color 0.16s,
    color 0.16s;
}
.close:hover {
  border-color: rgb(217 178 106 / 60%);
  color: #f2e3c4;
}

/* ===== 奖章 ===== */
.medallion {
  position: relative;
  display: inline-grid;
  place-items: center;
  width: 68px;
  height: 68px;
  margin-bottom: 14px;
  border-radius: 50%;
  color: #10240f;
  background: linear-gradient(160deg, #f7e2ac 0%, #d9b26a 42%, #8fd98f 100%);
  box-shadow:
    0 14px 34px rgb(93 175 93 / 34%),
    0 0 0 6px rgb(217 178 106 / 12%);
  animation: pop 0.56s cubic-bezier(0.2, 0.9, 0.25, 1.45) 0.06s both;
}
.medallion-ring {
  position: absolute;
  inset: -14px;
  border: 1px solid rgb(217 178 106 / 40%);
  border-radius: 50%;
  animation: ripple 2.6s ease-out 0.4s infinite;
}

.eyebrow {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  margin: 0 0 7px;
  color: #d9b26a;
  font-size: 11.5px;
  letter-spacing: 0.22em;
  animation: rise 0.42s ease-out 0.16s both;
}
.eyebrow .spark {
  width: 16px;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgb(217 178 106 / 70%));
}
.eyebrow .spark:last-child {
  background: linear-gradient(90deg, rgb(217 178 106 / 70%), transparent);
}

.blessing-card h2 {
  margin: 0 0 16px;
  color: #f6faf6;
  font-size: 22px;
  font-weight: 800;
  letter-spacing: 0.02em;
  text-shadow: 0 2px 18px rgb(143 217 143 / 26%);
  animation: rise 0.44s ease-out 0.22s both;
}

/* ===== 祝福语：全场主角 ===== */
.blessing {
  position: relative;
  margin: 0 0 20px;
  padding: 16px 16px 16px 18px;
  border-left: 2px solid rgb(217 178 106 / 55%);
  border-radius: 0 12px 12px 0;
  background: linear-gradient(90deg, rgb(217 178 106 / 9%), transparent 70%);
  color: #e8f3e6;
  font-size: 15.5px;
  line-height: 1.9;
  text-align: left;
  white-space: pre-wrap;
  animation: rise 0.48s ease-out 0.3s both;
}

/* ===== 到期票券 ===== */
.ticket {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px dashed rgb(217 178 106 / 38%);
  border-radius: 12px;
  background: linear-gradient(180deg, rgb(15 33 22 / 78%), rgb(12 24 18 / 62%));
  text-align: left;
  animation: rise 0.48s ease-out 0.38s both;
}
.ticket-label {
  flex: none;
  padding: 3px 8px;
  border-radius: 999px;
  color: #d9b26a;
  background: rgb(217 178 106 / 12%);
  font-size: 10.5px;
  letter-spacing: 0.06em;
}
.ticket-main {
  min-width: 0;
}
.ticket-main strong {
  display: block;
  color: #dff3e6;
  font-size: 15px;
  font-weight: 780;
}
.ticket-main small {
  display: block;
  margin-top: 2px;
  color: #6d8b7a;
  font-size: 10.5px;
}
.ticket-days {
  margin-left: auto;
  flex: none;
  color: #9fc4ae;
  font-size: 11px;
}
.ticket-days b {
  color: #8fd98f;
  font-size: 15px;
  font-weight: 800;
  margin: 0 2px;
}

/* ===== 收下按钮 ===== */
button.primary {
  position: relative;
  width: 100%;
  min-height: 46px;
  margin-top: 20px;
  border: 0;
  border-radius: 12px;
  color: #0b1a0d;
  background: linear-gradient(180deg, #f7e2ac 0%, #d9b26a 34%, #8fd98f 100%);
  font-size: 15px;
  font-weight: 800;
  letter-spacing: 0.04em;
  cursor: pointer;
  overflow: hidden;
  box-shadow: 0 12px 26px rgb(217 178 106 / 26%);
  animation: rise 0.48s ease-out 0.46s both;
  transition:
    transform 0.16s,
    box-shadow 0.16s;
}
button.primary:hover {
  transform: translateY(-2px);
  box-shadow: 0 18px 34px rgb(217 178 106 / 34%);
}
button.primary:active {
  transform: translateY(0) scale(0.99);
}

/* ===== 关键帧 ===== */
@keyframes fade {
  from {
    opacity: 0;
  }
}
@keyframes card-in {
  from {
    opacity: 0;
    transform: translateY(18px) scale(0.94);
  }
}
@keyframes pop {
  from {
    opacity: 0;
    transform: scale(0.4) rotate(-24deg);
  }
}
@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
}
@keyframes breathe {
  0%,
  100% {
    opacity: 0.75;
    transform: translateX(-50%) scale(1);
  }
  50% {
    opacity: 1;
    transform: translateX(-50%) scale(1.12);
  }
}
@keyframes ripple {
  0% {
    opacity: 0.7;
    transform: scale(0.9);
  }
  70%,
  100% {
    opacity: 0;
    transform: scale(1.35);
  }
}
@keyframes sheen {
  0% {
    left: -40%;
  }
  55%,
  100% {
    left: 130%;
  }
}
@keyframes fall {
  0% {
    opacity: 0;
    transform: translate3d(0, 0, 0) rotate(0deg);
  }
  8% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: translate3d(var(--drift), 116vh, 0) rotate(var(--spin));
  }
}

/*
 * 降低动态效果：彩带整层撤掉，入场动画也不做。
 * 这里必须显式写明——产品的全局 reduced-motion 规则只是把时长压到 0.01ms，
 * 彩带会"瞬间飞完"而不是"不飞"，看起来反而像闪了一下。
 */
@media (prefers-reduced-motion: reduce) {
  .confetti-layer,
  .sheen {
    display: none;
  }
  .blessing-backdrop,
  .blessing-card,
  .medallion,
  .medallion-ring,
  .eyebrow,
  .blessing-card h2,
  .blessing,
  .ticket,
  button.primary {
    animation: none;
    opacity: 1;
    transform: none;
  }
  /* 光晕靠 translateX(-50%) 居中，不能跟着上面那条被清成 none */
  .glow {
    animation: none;
    opacity: 0.85;
  }
}
</style>
