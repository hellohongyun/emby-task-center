import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { CardBlessingInfo, RegistrationProof } from "./portal-member";
import { usePortalSession, type CardCheckInfo } from "./usePortalSession";

export function usePublicLoginFlow() {
  const s = usePortalSession();

  /**
   * 门户根据邮箱选择登录或首次开通：
   *  email    第一步，**只有一个邮箱**；点「下一步」由服务端判断注册过没有
   *  login    注册过 → 发验证码 → 输入验证码登录（过期也算注册过，续费去「我的」页）
   *  register 没注册过 → 验证卡密和群邀请码 → 验证邮箱 → 确认资料
   */
  const step = ref<"email" | "login" | "register" | "profile">("email");
  const code = ref("");
  const cardCode = ref("");
  const inviteCode = ref("");
  const groupNumber = ref("");
  const registration = ref<RegistrationProof | null>(null);
  const qqNumber = ref("");
  const joinSource = ref("");
  const avatarUrl = computed(() =>
    /^[0-9]+$/.test(qqNumber.value) ? `https://q1.qlogo.cn/g?b=qq&nk=${qqNumber.value}&s=100` : null,
  );
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
  let disposed = false;

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

  onBeforeUnmount(() => {
    disposed = true;
    stopCooldown();
  });

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

  watch(inviteCode, () => {
    if (step.value !== "register") return;
    if (sent.value) {
      sent.value = false;
      code.value = "";
    }
    s.error.value = "";
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
      groupNumber.value = entry.groupInvite?.groupNumber ?? "";
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
      if (!result || disposed) return;
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
    if (!address || sendingCode.value || s.loading.value || cooldown.value > 0) return;
    const registering = step.value === "register";
    if (registering && (!cardChecked.value || (groupNumber.value && !inviteCode.value))) return;
    sendingCode.value = true;
    try {
      const result = await s.sendCode(
        address,
        registering ? cardCode.value.trim() : undefined,
        registering && groupNumber.value ? inviteCode.value : undefined,
      );
      if (!result || disposed) return;
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
    inviteCode.value = "";
    groupNumber.value = "";
    registration.value = null;
    qqNumber.value = "";
    joinSource.value = "";
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
    if (s.loading.value || sendingCode.value || code.value.length < 6) return;
    const address = s.email.value.trim();
    if (step.value === "register") {
      if (!cardChecked.value) {
        s.error.value = "请先验证卡密";
        return;
      }
      if (!sent.value) return;
      const proof = await s.verifyRegistration(
        address,
        code.value,
        cardCode.value.trim(),
        groupNumber.value ? inviteCode.value : undefined,
      );
      if (!proof || disposed) return;
      registration.value = proof;
      qqNumber.value = proof.qqNumber;
      step.value = "profile";
    } else {
      await s.loginWithCode(address, code.value);
      if (s.loggedInEmail.value) backToEmail();
    }
  }

  async function submitProfile() {
    if (!registration.value || s.loading.value) return;
    const ok = await s.activateRegistration(
      s.email.value.trim(),
      cardCode.value.trim(),
      registration.value.registrationToken,
      joinSource.value || undefined,
    );
    if (ok) backToEmail();
  }

  function reverifyEmail() {
    registration.value = null;
    code.value = "";
    sent.value = false;
    s.error.value = "";
    step.value = "register";
  }

  const title = () =>
    ({ email: "登录 / 开通会员", login: "验证邮箱", register: "用卡密开通会员", profile: "确认会员资料" })[step.value];
  const sendLabel = () =>
    sendingCode.value ? "发送中…" : cooldown.value > 0 ? `${cooldown.value}s` : sent.value ? "重新发送" : "发送验证码";

  return {
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
  };
}
