<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import {
  mdiAccountGroup,
  mdiAccountMultiple,
  mdiAccountPlus,
  mdiDelete,
  mdiLock,
  mdiLockOpen,
  mdiLogin,
  mdiRefresh,
  mdiRestore,
} from "@mdi/js";
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";

import type { EmbyUserRow, EmbySessionRow, SubmissionUser } from "../types";
import { useAdminSubmissions } from "../composables/useAdminSubmissions";
import { useEmbyUsers } from "../composables/useEmbyUsers";
import { groupSessions } from "../library/session-groups";
import SessionPlaybackCard from "./SessionPlaybackCard.vue";

const props = defineProps<{ requireAuth: () => void }>();

const admin = useAdminSubmissions(props.requireAuth);
const eu = useEmbyUsers(props.requireAuth);
const busy = ref(false);
const message = ref("");

/* ---- 统一用户行：会员 + Emby 账号 ——按 embyUserId 优先关联，用户名兜底，未关联的 Emby 账号单独成行 ---- */
interface UserRow {
  member: SubmissionUser | null;
  emby: EmbyUserRow | null;
}
const rows = computed<UserRow[]>(() => {
  const byId = new Map<string, EmbyUserRow>();
  const byName = new Map<string, EmbyUserRow>();
  for (const e of eu.users.value) {
    byId.set(e.id, e);
    if (e.name) byName.set(e.name.toLowerCase(), e);
  }
  const used = new Set<string>();
  const out: UserRow[] = [];
  for (const m of admin.users.value) {
    const emby =
      (m.embyUserId && byId.get(m.embyUserId)) || (m.embyUsername && byName.get(m.embyUsername.toLowerCase())) || null;
    if (emby) used.add(emby.id);
    out.push({ member: m, emby });
  }
  for (const e of eu.users.value) if (!used.has(e.id)) out.push({ member: null, emby: e });
  return out;
});

/* ---- 在线会话分组：默认只显示"正在播放"，挂在上面没播的折叠起来 ---- */
const sessionGroups = computed(() => groupSessions(eu.sessions.value));
const showIdleSessions = ref(false);

/* ---- 概览统计 ---- */
const stats = computed(() => [
  { label: "会员", value: rows.value.filter((r) => r.member).length },
  { label: "Emby 用户", value: eu.users.value.length },
  { label: "正在播放", value: sessionGroups.value.playing.length },
  {
    label: "超限/冻结",
    value: rows.value.filter((r) => r.member?.concurrency?.overshooting || r.member?.concurrency?.disabled).length,
  },
]);

/* ---- 添加用户（会员 + Emby 一步：邮箱即 Emby 用户名） ---- */
const memberForm = reactive({ email: "", password: "", subscriptionExpiresAt: "", embyMaxStreams: "", note: "" });
async function addMember() {
  if (!memberForm.email.trim()) {
    message.value = "请填写邮箱";
    return;
  }
  if (!memberForm.password.trim()) {
    message.value = "请填写 Emby 初始密码";
    return;
  }
  // type="number" 的 v-model 会把值自动转成 number；空值时是 ""。统一安全转换：
  const parsedMaxStreams = Number(memberForm.embyMaxStreams);
  busy.value = true;
  message.value = "";
  const ok = await admin.addUser({
    email: memberForm.email.trim(),
    subscriptionExpiresAt: toIso(memberForm.subscriptionExpiresAt),
    embyMaxStreams: Number.isFinite(parsedMaxStreams) && parsedMaxStreams >= 1 ? parsedMaxStreams : null,
    note: memberForm.note.trim() || null,
    password: memberForm.password.trim(),
  });
  busy.value = false;
  message.value = ok ? "已添加用户（已自动开通 Emby 账号）" : admin.error.value || "添加失败";
  if (ok) {
    memberForm.email = "";
    memberForm.password = "";
    memberForm.subscriptionExpiresAt = "";
    memberForm.embyMaxStreams = "";
    memberForm.note = "";
  }
}

/**
 * 「仅 Emby 账号」为什么还没绑成会员：与服务端自动绑定规则（subscriptions/emby-member-sync.ts）
 * 保持一致，纯展示用、不参与判定。
 */
function unboundReason(row: UserRow): string {
  const emby = row.emby;
  if (!emby) return "";
  if (emby.isAdmin) return "Emby 管理员账号，不参与自动绑定";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emby.name ?? "")) return "用户名不是邮箱，无法作为会员账号";
  if (emby.isDisabled) return "Emby 侧已停用，不参与自动绑定";
  return "等待自动同步（每 10 分钟一轮，也可点上方「同步 Emby 账号」）";
}

/** 手动触发"Emby 账号 → 会员"绑定；服务端启动时与每 10 分钟也会自动跑一次。 */
async function syncEmbyAccounts() {
  busy.value = true;
  message.value = "正在同步 Emby 账号…";
  const result = await admin.syncEmbyAccounts();
  busy.value = false;
  if (!result) {
    message.value = admin.error.value || "同步失败";
    return;
  }
  const parts = [
    result.linked ? `新绑定 ${result.linked} 个` : "",
    result.adopted ? `补绑定 ${result.adopted} 个` : "",
    result.skipped ? `跳过 ${result.skipped} 个` : "",
  ].filter(Boolean);
  message.value = parts.length
    ? `同步完成：${parts.join("，")}。被跳过的账号在「邮箱 / 会员」列里能看到原因。`
    : "同步完成：没有需要绑定的 Emby 账号。";
  await Promise.all([eu.load(), eu.loadSessions()]);
}

/* ---- 会员字段编辑 ---- */
async function setMaxStreams(row: UserRow, value: string) {
  if (!row.member) return;
  busy.value = true;
  const ok = await admin.updateUser(row.member.id, { embyMaxStreams: value.trim() ? Number(value) : null });
  busy.value = false;
  if (!ok && admin.error.value) message.value = admin.error.value;
}
/** 每日 / 首批额度：投稿链路移除后不再被消费，这里只作为管理员记录。 */
async function setQuota(row: UserRow, field: "processPerDay" | "processFirstBatch", value: string) {
  if (!row.member) return;
  const parsed = value.trim() ? Number(value) : null;
  if (parsed != null && (!Number.isInteger(parsed) || parsed < 0 || parsed > 1000)) {
    message.value = "额度需为 0–1000 的整数。";
    return;
  }
  busy.value = true;
  const ok = await admin.setUserQuota(
    row.member.id,
    field === "processPerDay" ? parsed : null,
    field === "processFirstBatch" ? parsed : null,
  );
  busy.value = false;
  if (!ok && admin.error.value) message.value = admin.error.value;
}

/**
 * 移除会员：会员记录 + 它的 Emby 账号一起删（服务端一个请求里做完）。
 * 原先这里只删会员行、Emby 号要另外点一次「删除」，漏点一次就等于没断服。
 */
async function removeMember(row: UserRow) {
  if (!row.member) return;
  const also = row.emby ? `（含 Emby 账号 ${row.emby.name}）` : "";
  if (!confirm(`移除会员 ${row.member.email}${also}？`)) return;
  const ok = await admin.deleteUser(row.member.id);
  if (ok) {
    message.value = row.emby ? "已移除会员及其 Emby 账号" : "已移除会员";
    // 被删掉的 Emby 半边也要从表里消失
    await eu.load(true);
  }
}

/* ---- 并发超限恢复 ---- */
async function restoreMember(row: UserRow) {
  if (!row.member) return;
  if (!confirm(`立即恢复 ${row.member.email} 的并发播放？（将清除超限冻结并重新启用其 Emby 账号）`)) return;
  const ok = await admin.restoreUser(row.member.id);
  if (ok) message.value = `已恢复 ${row.member.email} 的并发播放`;
}

/* ---- Emby 账号操作 ---- */
const editingPassword = ref<Record<string, boolean>>({});
const passwordEdit = ref<Record<string, string>>({});
function togglePasswordEdit(id: string) {
  editingPassword.value[id] = !editingPassword.value[id];
  if (editingPassword.value[id]) passwordEdit.value[id] = "";
}
async function savePassword(id: string) {
  const value = passwordEdit.value[id];
  if (!value) return;
  const ok = await eu.setPassword(id, value);
  if (ok && editingPassword.value[id] && passwordEdit.value[id] === value) {
    editingPassword.value[id] = false;
    message.value = "Emby 密码已更新";
  }
}
async function removeEmby(row: UserRow) {
  if (!row.emby) return;
  if (!confirm(`删除 Emby 用户 ${row.emby.name}？`)) return;
  await eu.removeUser(row.emby.id);
}

/* ---- 投稿请求审批已随投稿功能整体移除 ---- */

async function refreshAll() {
  await Promise.all([admin.load(), eu.load(), eu.loadSessions()]);
}

/* ---- 在线会话/在线数 实时刷新：静默轮询（不闪 loading），离开页面即停 ---- */
const AUTO_REFRESH_MS = 3000;
let pollTimer: number | undefined;
let pollRunning = false;
async function pollSessions() {
  if (pollRunning) return;
  pollRunning = true;
  try {
    await Promise.all([eu.load(true), eu.loadSessions()]);
  } finally {
    pollRunning = false;
  }
}
function startPolling() {
  stopPolling();
  pollTimer = window.setInterval(() => void pollSessions(), AUTO_REFRESH_MS);
}
function stopPolling() {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

onMounted(() => {
  void refreshAll();
  startPolling();
});
onUnmounted(stopPolling);

/* ---- helpers ---- */
function toIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function formatExpiryDate(value: string | null): string {
  if (!value) return "未设置";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未设置";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function memberStatusLabel(status: string): string {
  return { active: "有效", expiring: "临期", expired: "已过期", none: "未开通" }[status] ?? status;
}
function memberClass(status: string): string {
  if (status === "expired") return "expired";
  if (status === "expiring") return "expiring";
  return "ok";
}
/** 并发超限状态徽标；返回非空对象，active 表示是否处于超限/冻结。 */
function concurrencyMeta(member: SubmissionUser | null): { label: string; cls: string; active: boolean } {
  if (!member) return { label: "—", cls: "ok", active: false };
  const c = member.concurrency;
  if (!c) return { label: "正常", cls: "ok", active: false };
  if (c.disabled) {
    const ms = c.remainingMs ?? 0;
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const remain = h > 0 ? `${h} 小时${m > 0 ? ` ${m} 分` : ""}` : `${m} 分`;
    return { label: `已冻结 · 剩 ${remain}`, cls: "lock", active: true };
  }
  if (c.overshooting && c.notified) return { label: "超限 · 已提醒", cls: "warn", active: true };
  if (c.overshooting) return { label: "超限中", cls: "warn", active: true };
  return { label: "正常", cls: "ok", active: false };
}
function dateLabel(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
/** 会话 → 会员邮箱：优先按 Emby 账号 Id 对上会员行，其次按用户名（= 邮箱）。 */
function memberEmailForSession(session: EmbySessionRow): string | null {
  const match = rows.value.find(
    (row) =>
      (session.userId && row.member?.embyUserId === session.userId) ||
      (session.userName &&
        (row.member?.email?.toLowerCase() === session.userName.toLowerCase() ||
          row.member?.embyUsername?.toLowerCase() === session.userName.toLowerCase())),
  );
  return match?.member?.email ?? null;
}
</script>

<template>
  <section class="members" aria-label="用户 / 会员管理">
    <header class="head">
      <div class="head-main">
        <div class="head-title">
          <span class="head-icon" aria-hidden="true"><SvgIcon type="mdi" :path="mdiAccountGroup" :size="22" /></span>
          <h2>会员</h2>
        </div>
        <p class="head-sub">会员与其 Emby 账号同排一行：状态、到期、并发、额度与在线情况，操作集中在行尾。</p>
      </div>
      <div class="head-actions">
        <button type="button" class="refresh" :disabled="busy" @click="syncEmbyAccounts">
          <SvgIcon type="mdi" :path="mdiAccountMultiple" :size="18" />同步 Emby 账号
        </button>
        <button type="button" class="refresh" :disabled="admin.loading.value || eu.loading.value" @click="refreshAll">
          <SvgIcon type="mdi" :path="mdiRefresh" :size="18" />刷新
        </button>
      </div>
    </header>

    <ul class="stats" aria-label="概览">
      <li v-for="item in stats" :key="item.label">
        <b>{{ item.value }}</b
        ><span>{{ item.label }}</span>
      </li>
    </ul>

    <p v-if="message" class="msg" role="status">{{ message }}</p>
    <p v-if="admin.error.value || eu.error.value" class="error" role="alert">
      {{ admin.error.value || eu.error.value }}
    </p>

    <!-- 添加 -->
    <section class="panel add">
      <h3>添加用户 <span class="panel-hint">邮箱即 Emby 用户名，一步开通</span></h3>
      <form class="add-form" @submit.prevent="addMember">
        <label class="field">
          <span>邮箱 <em class="req">*</em></span>
          <input v-model="memberForm.email" type="email" required placeholder="name@example.com" />
        </label>
        <label class="field">
          <span>Emby 初始密码 <em class="req">*</em></span>
          <input v-model="memberForm.password" type="text" maxlength="200" required placeholder="必填，设置初始密码" />
        </label>
        <label class="field">
          <span>到期时间</span>
          <input v-model="memberForm.subscriptionExpiresAt" type="datetime-local" />
        </label>
        <label class="field">
          <span>并发上限</span>
          <input v-model="memberForm.embyMaxStreams" type="number" min="1" max="20" placeholder="留空不限" />
        </label>
        <label class="field">
          <span>备注</span>
          <input v-model="memberForm.note" type="text" placeholder="可选" />
        </label>
        <button type="submit" class="primary submit" :disabled="busy">
          <SvgIcon type="mdi" :path="mdiAccountPlus" :size="16" />添加用户
        </button>
      </form>
    </section>

    <!-- 统一用户表 -->
    <section class="panel">
      <h3>
        会员 <span class="count-chip">{{ rows.length }}</span>
      </h3>
      <div v-if="admin.loading.value || eu.loading.value" class="empty">正在读取…</div>
      <div v-else-if="!rows.length" class="empty">暂无用户。请先添加用户（邮箱即 Emby 用户名）。</div>
      <div v-else class="table-wrap">
        <table class="users-table">
          <thead>
            <tr>
              <th>邮箱 / 会员</th>
              <th>会员状态</th>
              <th>到期日期</th>
              <th>Emby 用户</th>
              <th>Emby 状态</th>
              <th>并发上限</th>
              <th title="每日 / 首批额度（管理员记录用；投稿链路已移除，不再消费）">额度（日/首批）</th>
              <th>超限状态</th>
              <th>最近活动</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.member?.id ?? 'emby-' + row.emby?.id">
              <td>
                <template v-if="row.member"
                  ><b class="email">{{ row.member.email }}</b
                  ><small v-if="row.member.note" class="email-note">{{ row.member.note }}</small></template
                >
                <template v-else
                  ><span class="only-emby">仅 Emby 账号</span
                  ><small class="email-note">{{ unboundReason(row) }}</small></template
                >
              </td>
              <td>
                <span v-if="row.member" :class="['member-badge', memberClass(row.member.status)]">{{
                  memberStatusLabel(row.member.status)
                }}</span>
                <span v-else class="dim">—</span>
              </td>
              <td>
                <span
                  v-if="row.member"
                  :class="['expiry', memberClass(row.member.status)]"
                  :title="
                    row.member.subscriptionExpiresAt
                      ? new Date(row.member.subscriptionExpiresAt).toLocaleString('zh-CN')
                      : ''
                  "
                  >{{ formatExpiryDate(row.member.subscriptionExpiresAt) }}</span
                >
                <span v-else class="dim">—</span>
              </td>
              <td>
                <b class="emby-name">{{ row.emby?.name ?? row.member?.embyUsername ?? "—" }}</b>
              </td>
              <td>
                <div class="emby-state">
                  <div class="emby-badges">
                    <span v-if="row.emby?.isAdmin" class="badge admin">管理员</span>
                    <span v-if="row.emby?.isHidden" class="badge">隐藏</span>
                    <span v-if="row.emby && !row.emby.playbackEnabled" class="badge warn">禁播</span>
                    <span v-if="row.emby?.isDisabled" class="badge off">已停用</span>
                  </div>
                  <span v-if="row.emby" :class="['sessions', { active: row.emby.activeSessions > 0 }]">
                    <SvgIcon
                      type="mdi"
                      :path="row.emby.activeSessions > 0 ? mdiAccountMultiple : mdiLogin"
                      :size="13"
                    />{{ row.emby.activeSessions }}
                  </span>
                  <span v-else class="dim">未绑定</span>
                </div>
              </td>
              <td>
                <span v-if="row.member" class="editable"
                  ><input
                    :value="row.member.embyMaxStreams ?? ''"
                    type="number"
                    min="1"
                    max="20"
                    placeholder="不限"
                    :disabled="busy"
                    @change="setMaxStreams(row, ($event.target as HTMLInputElement).value)"
                /></span>
                <span v-else class="dim">—</span>
              </td>
              <td>
                <div v-if="row.member" class="quota-cell">
                  <input
                    :value="row.member.processPerDay ?? ''"
                    type="number"
                    min="0"
                    max="1000"
                    placeholder="日"
                    :disabled="busy"
                    aria-label="每日额度"
                    @change="setQuota(row, 'processPerDay', ($event.target as HTMLInputElement).value)"
                  />
                  <input
                    :value="row.member.processFirstBatch ?? ''"
                    type="number"
                    min="0"
                    max="1000"
                    placeholder="首批"
                    :disabled="busy"
                    aria-label="首批额度"
                    @change="setQuota(row, 'processFirstBatch', ($event.target as HTMLInputElement).value)"
                  />
                </div>
                <span v-else class="dim">—</span>
              </td>
              <td>
                <template v-if="row.member">
                  <span :class="['cc-badge', concurrencyMeta(row.member).cls]">{{
                    concurrencyMeta(row.member).label
                  }}</span>
                </template>
                <span v-else class="dim">—</span>
              </td>
              <td class="dim last-activity">{{ row.emby ? dateLabel(row.emby.lastActivityDate) : "—" }}</td>
              <td class="actions">
                <div class="row-actions">
                  <template v-if="row.member">
                    <button
                      v-if="concurrencyMeta(row.member).active"
                      type="button"
                      class="warn"
                      @click="restoreMember(row)"
                    >
                      <SvgIcon type="mdi" :path="mdiRestore" :size="13" />恢复
                    </button>
                    <button type="button" class="danger" @click="removeMember(row)">移除会员</button>
                  </template>
                  <template v-if="row.emby">
                    <button
                      type="button"
                      :class="{ danger: !row.emby.isDisabled }"
                      :disabled="eu.isUserBusy(row.emby.id)"
                      @click="eu.setDisabled(row.emby.id, !row.emby.isDisabled)"
                    >
                      <SvgIcon type="mdi" :path="row.emby.isDisabled ? mdiLockOpen : mdiLock" :size="13" />{{
                        row.emby.isDisabled ? "启用" : "停用"
                      }}
                    </button>
                    <button
                      type="button"
                      :disabled="eu.isUserBusy(row.emby.id)"
                      @click="togglePasswordEdit(row.emby.id)"
                    >
                      改密码
                    </button>
                    <!-- 会员行上的 Emby 账号由「移除会员」一并删除，这里只保留孤儿 Emby 账号（没有会员那半行）的删除入口 -->
                    <button
                      v-if="!row.member"
                      type="button"
                      class="danger"
                      :disabled="eu.isUserBusy(row.emby.id)"
                      @click="removeEmby(row)"
                    >
                      <SvgIcon type="mdi" :path="mdiDelete" :size="13" />删除
                    </button>
                  </template>
                </div>
                <div v-if="row.emby && editingPassword[row.emby.id]" class="password-row">
                  <input
                    v-model="passwordEdit[row.emby.id]"
                    type="text"
                    maxlength="200"
                    placeholder="新 Emby 密码"
                    @keyup.enter="savePassword(row.emby.id)"
                  />
                  <button
                    type="button"
                    class="primary"
                    :disabled="!passwordEdit[row.emby.id] || eu.busy.value"
                    @click="savePassword(row.emby.id)"
                  >
                    保存
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!--
      在线会话：详情对齐 Emby 客户端的播放状态（片名/季节集/进度/设备/直连或转码/编码音轨）。
      默认只铺"正在播放"的那几条——挂在上面没播的（含本应用自己连上去的会话）折叠成一行，
      否则无播放的卡片会把真正在播的挤下去，看起来像面板卡了。
    -->
    <section class="panel">
      <div class="sessions-head">
        <h3>在线播放会话</h3>
        <div class="sessions-meta">
          <span class="live"><span class="dot live"></span>实时刷新 · 每 3 秒</span
          ><span class="count playing">{{ sessionGroups.playing.length }} 个在播</span
          ><span v-if="sessionGroups.idle.length" class="count">{{ sessionGroups.idle.length }} 个已连接</span>
        </div>
      </div>
      <div v-if="!eu.sessions.value.length" class="empty">当前没有在线会话。</div>
      <template v-else>
        <div v-if="!sessionGroups.playing.length" class="empty">当前没有正在播放的会话。</div>
        <div v-else class="session-cards">
          <SessionPlaybackCard
            v-for="session in sessionGroups.playing"
            :key="session.id"
            :session="session"
            :member-email="memberEmailForSession(session)"
            @end="eu.endSession"
          />
        </div>
        <div v-if="sessionGroups.idle.length" class="idle-sessions">
          <button
            type="button"
            class="idle-toggle"
            :aria-expanded="showIdleSessions"
            @click="showIdleSessions = !showIdleSessions"
          >
            {{ showIdleSessions ? "收起" : "展开" }}另有 {{ sessionGroups.idle.length }} 个已连接会话（未在播放）
          </button>
          <div v-if="showIdleSessions" class="session-cards">
            <SessionPlaybackCard
              v-for="session in sessionGroups.idle"
              :key="session.id"
              :session="session"
              :member-email="memberEmailForSession(session)"
              @end="eu.endSession"
            />
          </div>
        </div>
      </template>
    </section>
  </section>
</template>

<style scoped>
.members {
  padding: 22px;
  max-width: 1180px;
  margin: 0 auto;
  color: var(--text);
}

/* 页头 */
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}
.head-main {
  min-width: 0;
}
.head-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}
.head-title {
  display: flex;
  align-items: center;
  gap: 11px;
  margin-bottom: 6px;
}
.head-icon {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border-radius: 11px;
  color: var(--accent-strong);
  background: var(--accent-dim);
  border: 1px solid rgb(104 189 104 / 24%);
}
.head h2 {
  margin: 0;
  font-size: 23px;
  font-weight: 760;
  color: var(--text);
  letter-spacing: 0.01em;
}
.head-sub {
  margin: 0;
  color: var(--text-dim);
  font-size: 13px;
  line-height: 1.6;
}
.refresh {
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 15px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  color: var(--text);
  background: var(--surface-hi);
  cursor: pointer;
  font-size: 13px;
}
.refresh:disabled {
  opacity: 0.55;
  cursor: default;
}
.refresh:not(:disabled):hover {
  background: #172834;
  border-color: #35506a;
}

/* 概览统计 */
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
  margin: 0 0 4px;
  padding: 0;
  list-style: none;
}
.stats li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 12px 15px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}
.stats b {
  flex: none;
  font-size: 22px;
  font-weight: 780;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.stats span {
  color: var(--text-dim);
  font-size: 12px;
}
.stats li:first-child b {
  color: var(--accent-strong);
}

.msg {
  margin: 12px 0 0;
  color: var(--warn);
  font-size: 13px;
}
.error {
  margin: 12px 0 0;
  padding: 10px 14px;
  border: 1px solid #4a2e30;
  border-radius: 8px;
  color: #f0b7b7;
  background: #241416;
}

.panel {
  margin-top: 16px;
  padding: 18px 20px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
}
.panel h3 {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 14px;
  font-size: 16px;
  font-weight: 760;
  color: var(--text);
}
.panel-hint {
  color: var(--text-faint);
  font-size: 12px;
  font-weight: 500;
}
.count-chip {
  display: inline-flex;
  align-items: center;
  min-width: 22px;
  height: 22px;
  padding: 0 8px;
  border-radius: var(--radius-pill);
  color: var(--text-dim);
  background: var(--surface-hi);
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.count-chip.warn {
  color: var(--accent-strong);
  background: var(--accent-dim);
}

/* 添加表单 */
.add-form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  align-items: end;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--text-dim);
  font-size: 12px;
}
.field > span {
  font-weight: 600;
}
.req {
  color: var(--danger);
  font-style: normal;
}
.field input {
  min-height: 40px;
  padding: 0 11px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  color: var(--text);
  background: var(--input);
  font-size: 13px;
  transition:
    border-color 0.18s var(--ease),
    box-shadow 0.18s var(--ease);
}
.field input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-ring);
}
.field input:disabled {
  opacity: 0.6;
}
.add-form .submit {
  align-self: end;
}

button {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 0 13px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  color: var(--text);
  background: var(--surface-hi);
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  transition:
    background-color 0.18s var(--ease),
    border-color 0.18s var(--ease),
    color 0.18s var(--ease);
}
button:not(:disabled):hover {
  background: #16242f;
  border-color: #35506a;
}
button.primary {
  border-color: #4d9b51;
  color: var(--accent-ink);
  background: var(--accent);
  font-weight: 700;
}
button.primary:not(:disabled):hover {
  background: var(--accent-strong);
  border-color: var(--accent-strong);
}
button.danger {
  color: var(--danger);
  border-color: #4a2a2a;
  background: #141616;
}
button.danger:not(:disabled):hover {
  background: #241416;
  border-color: #5c3435;
}
button:disabled {
  opacity: 0.55;
  cursor: default;
}

/* 用户表 */
.table-wrap {
  overflow: auto;
  max-height: 560px;
  border: 1px solid var(--line);
  border-radius: 10px;
}
.users-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  min-width: 920px;
}
.users-table th {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--surface-hi);
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 700;
  text-align: left;
  white-space: nowrap;
}
.users-table td {
  padding: 12px;
  border-bottom: 1px solid var(--line);
  vertical-align: middle;
}
.users-table tbody tr:hover {
  background: rgb(255 255 255 / 2%);
}
.users-table tbody tr:last-child td {
  border-bottom: 0;
}
.email {
  color: var(--text);
  display: block;
}
.email-note {
  display: block;
  color: var(--text-dim);
  font-size: 11px;
  margin-top: 3px;
}
.only-emby {
  color: #8fb7e8;
  font-size: 12px;
}
.dim {
  color: var(--text-faint);
}
.last-activity {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.member-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  font-size: 11px;
  font-weight: 700;
}
.member-badge::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.member-badge.ok {
  color: #7fd08a;
  background: #14301c;
}
.member-badge.expiring {
  color: #e6c06a;
  background: #2a2210;
}
.member-badge.expired {
  color: #ef8585;
  background: #2a1515;
}
.editable input {
  min-height: 32px;
  padding: 0 8px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  color: var(--text);
  background: var(--input);
  width: 100%;
  font-size: 12px;
}
.editable input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-ring);
}
/* 每日 / 首批额度：两个窄输入并排 */
.quota-cell {
  display: flex;
  gap: 6px;
}
.quota-cell input {
  width: 66px;
  min-height: 32px;
  padding: 0 8px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  color: var(--text);
  background: var(--input);
  font-size: 12px;
}
.quota-cell input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-ring);
}
.expiry {
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  white-space: nowrap;
}
.expiry.ok {
  color: var(--text-dim);
}
.expiry.expiring {
  color: var(--warn);
}
.expiry.expired {
  color: var(--danger);
}
.emby-name {
  color: var(--text);
}
.emby-state {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}
.emby-badges {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.badge {
  display: inline-block;
  padding: 2px 7px;
  border-radius: var(--radius-pill);
  color: #8fb7e8;
  background: #12233a;
  font-size: 10px;
  font-weight: 700;
}
.badge.admin {
  color: #e6c06a;
  background: #2a2410;
}
.badge.warn {
  color: #f0b7b7;
  background: #2a1717;
}
.badge.off {
  color: #f0b7b7;
  background: #2a1717;
}
.badge.lock {
  color: #ffb454;
  background: #2d2210;
}
.cc-badge {
  display: inline-block;
  padding: 3px 9px;
  border-radius: var(--radius-pill);
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}
.cc-badge.warn {
  color: #e6c06a;
  background: #2a2210;
}
.cc-badge.lock {
  color: #ffb454;
  background: #2d2210;
}
.cc-badge.ok {
  color: var(--text-faint);
  background: transparent;
  font-weight: 500;
}
.row-actions button.warn {
  color: #e6c06a;
  border-color: #4a3f1a;
  background: #1c1910;
}
.row-actions button.warn:not(:disabled):hover {
  background: #2a2210;
  border-color: #63531f;
}
.sessions {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.sessions.active {
  color: #7fd08a;
}
.actions {
  white-space: nowrap;
}
.row-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  max-width: 300px;
}
.row-actions button {
  min-height: 30px;
  padding: 0 10px;
}
.password-row {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}
.password-row input {
  min-height: 32px;
  padding: 0 8px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  color: var(--text);
  background: var(--input);
  min-width: 150px;
}

/* 在线会话 */
.sessions-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.sessions-head h3 {
  margin: 0;
}
.sessions-meta {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
.sessions-head .count {
  color: var(--text-dim);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.sessions-head .live {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #7fd08a;
  font-size: 11px;
  font-weight: 600;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #5c6b76;
  flex: none;
}
.dot.live {
  background: #7fd08a;
  box-shadow: 0 0 0 3px rgb(127 208 138 / 18%);
  animation: pulse 1.8s var(--ease) infinite;
}
@keyframes pulse {
  0%,
  100% {
    box-shadow: 0 0 0 3px rgb(127 208 138 / 18%);
  }
  50% {
    box-shadow: 0 0 0 6px rgb(127 208 138 / 6%);
  }
}
/* 会话卡片的排版在 SessionPlaybackCard.vue 里，这里只管列间距。 */
.session-cards {
  display: grid;
  gap: 10px;
}
.sessions-head .count.playing {
  color: var(--accent-strong);
}
/* 未播放的会话收在按钮后面，不跟正在播的抢位置 */
.idle-sessions {
  margin-top: 10px;
}
.idle-toggle {
  min-height: 32px;
  padding: 0 11px;
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius);
  color: var(--text-dim);
  background: transparent;
  font-size: 12px;
  cursor: pointer;
}
.idle-toggle:hover {
  color: var(--text);
  border-color: var(--text-faint);
}
.idle-sessions .session-cards {
  margin-top: 10px;
}
.empty {
  padding: 26px 20px;
  color: var(--text-faint);
  font-size: 13px;
  text-align: center;
}

@media (max-width: 900px) {
  .members {
    padding: 16px;
  }
  .stats {
    grid-template-columns: repeat(2, 1fr);
  }
  .add-form {
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  }
}
@media (max-width: 720px) {
  .head {
    flex-direction: column;
  }
  .sessions-head {
    flex-direction: column;
    align-items: flex-start;
  }
}
@media (max-width: 420px) {
  .stats {
    grid-template-columns: 1fr 1fr;
  }
  .add-form {
    grid-template-columns: 1fr;
  }
}
</style>
