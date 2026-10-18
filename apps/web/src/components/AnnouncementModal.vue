<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

interface Article {
  code: string;
  title: string;
  content: string;
  updatedAt?: string;
  forceSeconds?: number;
}

const visible = ref(false);
const title = ref("平台公告");
const content = ref("");
const updatedAt = ref<string | null>(null);
const snooze = ref(false);
const snoozeKey = "emby_announcement_snooze";
const snoozeDays = 14;
/** 强制阅读倒计时（秒）：期间无法点击「我知道了」（管理端可配置 0-120）。 */
const cooldown = ref(0);
const forceSeconds = ref(3);
let cooldownTimer: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  try {
    const response = await fetch("/api/public/articles", { credentials: "include" });
    if (!response.ok) return;
    const body = (await response.json()) as { articles: Article[] };
    const announcement = (body.articles ?? []).find((article) => article.code === "announcement");
    if (!announcement) return;
    title.value = announcement.title;
    content.value = announcement.content;
    updatedAt.value = announcement.updatedAt ?? null;
    forceSeconds.value = Math.max(0, Math.min(120, announcement.forceSeconds ?? 3));
    let snoozed: { until: number; updatedAt: string | null } | null = null;
    try {
      const raw = localStorage.getItem(snoozeKey);
      if (raw) snoozed = JSON.parse(raw) as { until: number; updatedAt: string | null };
    } catch {
      /* 忽略 */
    }
    const contentChanged =
      updatedAt.value != null && snoozed?.updatedAt != null && snoozed.updatedAt !== updatedAt.value;
    const stillSnoozed = snoozed?.until != null && Date.now() < snoozed.until;
    visible.value = contentChanged || !stillSnoozed;
    if (visible.value) startCooldown();
  } catch {
    /* 忽略 */
  }
});

function startCooldown() {
  if (cooldownTimer) clearInterval(cooldownTimer);
  cooldown.value = forceSeconds.value;
  if (cooldown.value <= 0) {
    cooldown.value = 0;
    return;
  }
  cooldownTimer = setInterval(() => {
    cooldown.value -= 1;
    if (cooldown.value <= 0) {
      cooldown.value = 0;
      if (cooldownTimer) clearInterval(cooldownTimer);
      cooldownTimer = null;
    }
  }, 1000);
}

onBeforeUnmount(() => {
  if (cooldownTimer) clearInterval(cooldownTimer);
});

function dismiss() {
  if (cooldown.value > 0) return;
  const until = snooze.value ? Date.now() + snoozeDays * 86_400_000 : 0;
  try {
    if (snooze.value) localStorage.setItem(snoozeKey, JSON.stringify({ until, updatedAt: updatedAt.value }));
    else sessionStorage.setItem(`${snoozeKey}_session`, String(Date.now()));
  } catch {
    /* 忽略 */
  }
  visible.value = false;
}
</script>

<template>
  <Transition name="fade">
    <div v-if="visible" class="modal-mask" role="dialog" aria-modal="true" aria-label="平台公告">
      <section class="modal">
        <header>
          <span class="icon">📣</span>
          <h2>{{ title }}</h2>
        </header>
        <div class="body">{{ content }}</div>
        <footer>
          <label class="snooze"
            ><input v-model="snooze" type="checkbox" :disabled="cooldown > 0" /><span
              ><b>14 天免打扰</b>（14 天后继续弹出公告）</span
            ></label
          >
          <button type="button" class="primary" :disabled="cooldown > 0" @click="dismiss">
            {{ cooldown > 0 ? `我知道了（${cooldown}s）` : "我知道了" }}
          </button>
        </footer>
      </section>
    </div>
  </Transition>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  z-index: 90;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgb(2 8 12 / 74%);
  backdrop-filter: blur(6px);
}
.modal {
  width: min(100%, 520px);
  max-height: 82dvh;
  display: flex;
  flex-direction: column;
  border: 1px solid #2c4251;
  border-radius: 16px;
  background: linear-gradient(180deg, #0e1c26, #0a141c 70%);
  box-shadow: 0 28px 80px rgb(0 0 0 / 55%);
  overflow: hidden;
}
header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 18px 20px 12px;
}
header .icon {
  font-size: 22px;
}
header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 780;
  color: #eef2f4;
}
.body {
  flex: 1;
  min-height: 0;
  padding: 4px 20px 14px;
  overflow: auto;
  color: #b7c1c8;
  font-size: 13px;
  line-height: 1.9;
  white-space: pre-wrap;
}
footer {
  display: grid;
  gap: 12px;
  padding: 14px 20px 18px;
  border-top: 1px solid #1c2c36;
  background: #0b141a;
}
.snooze {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  color: #8a97a1;
  font-size: 12px;
  cursor: pointer;
}
.snooze b {
  color: #b7c1c8;
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
  box-shadow: 0 8px 22px rgb(93 175 93 / 24%);
  transition:
    transform 0.16s,
    box-shadow 0.16s;
}
button.primary:hover:not(:disabled) {
  transform: translateY(-1px);
}
button.primary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  box-shadow: none;
}
.snooze input:disabled + span {
  opacity: 0.55;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
@media (max-width: 560px) {
  .modal {
    border-radius: 12px;
  }
}
</style>
