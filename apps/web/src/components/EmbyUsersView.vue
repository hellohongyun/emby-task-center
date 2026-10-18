<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import { mdiAccountMultiple, mdiDelete, mdiLock, mdiLockOpen, mdiLogin, mdiPlus, mdiRefresh } from "@mdi/js";
import { computed, onMounted, ref } from "vue";

import { useEmbyUsers } from "../composables/useEmbyUsers";
import { groupSessions } from "../library/session-groups";
import SessionPlaybackCard from "./SessionPlaybackCard.vue";

const props = defineProps<{ requireAuth?: (() => void) | undefined }>();

const u = useEmbyUsers(props.requireAuth);
const newName = ref("");
const newPassword = ref("");
const newIsAdmin = ref(false);
const passwordEdit = ref<Record<string, string>>({});
const editingPassword = ref<Record<string, boolean>>({});
/** 与「会员与运营」一致：默认只显示正在播放，未播放的会话折叠（见 library/session-groups.ts）。 */
const sessionGroups = computed(() => groupSessions(u.sessions.value));
const showIdleSessions = ref(false);

onMounted(() => void Promise.all([u.load(), u.loadSessions()]));

async function createUser() {
  if (!newName.value.trim() || u.busy.value) return;
  const name = newName.value.trim();
  const password = newPassword.value;
  const isAdmin = newIsAdmin.value;
  const ok = await u.createUser({
    name: newName.value.trim(),
    password: newPassword.value || undefined,
    isAdmin: newIsAdmin.value,
  });
  if (ok && newName.value.trim() === name && newPassword.value === password && newIsAdmin.value === isAdmin) {
    newName.value = "";
    newPassword.value = "";
    newIsAdmin.value = false;
  }
}

function togglePasswordEdit(userId: string) {
  editingPassword.value[userId] = !editingPassword.value[userId];
  if (editingPassword.value[userId]) passwordEdit.value[userId] = "";
}

async function savePassword(userId: string) {
  const value = passwordEdit.value[userId];
  if (!value) return;
  const ok = await u.setPassword(userId, value);
  if (ok && editingPassword.value[userId] && passwordEdit.value[userId] === value)
    editingPassword.value[userId] = false;
}

function lastLogin(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
</script>

<template>
  <section class="emby-users" aria-labelledby="emby-users-title">
    <div class="heading">
      <div>
        <h2 id="emby-users-title">Emby 用户</h2>
        <p class="hint">通过 Emby API 管理用户：创建、停用/启用（控制登录）、查看/断开在线播放会话、改密码、删除。</p>
      </div>
      <button
        type="button"
        class="refresh"
        :disabled="u.loading.value"
        @click="
          () => {
            u.load();
            u.loadSessions();
          }
        "
      >
        <SvgIcon type="mdi" :path="mdiRefresh" :size="17" />{{ u.loading.value ? "刷新中…" : "刷新" }}
      </button>
    </div>

    <p v-if="u.error.value" class="error" role="alert">{{ u.error.value }}</p>

    <div class="create-card" role="group" aria-label="创建 Emby 用户">
      <h3>创建用户</h3>
      <div class="create-form">
        <label>用户名<input v-model="newName" type="text" maxlength="60" placeholder="例如：xiaoming" /></label>
        <label
          >初始密码<input v-model="newPassword" type="text" maxlength="200" placeholder="可选（不填则无密码）"
        /></label>
        <label class="admin-toggle"><input v-model="newIsAdmin" type="checkbox" />设为管理员</label>
        <button type="button" class="primary" :disabled="!newName.trim() || u.busy.value" @click="createUser">
          <SvgIcon type="mdi" :path="mdiPlus" :size="16" />创建
        </button>
      </div>
    </div>

    <div class="table-card">
      <h3>用户列表 ({{ u.users.value.length }})</h3>
      <div v-if="u.loading.value" class="empty">正在读取…</div>
      <div v-else-if="!u.users.value.length" class="empty">暂无 Emby 用户。</div>
      <table v-else class="users-table">
        <thead>
          <tr>
            <th>用户名</th>
            <th>状态</th>
            <th>权限</th>
            <th>在线</th>
            <th>最近活动</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="user in u.users.value" :key="user.id">
            <td>
              <span class="user-name">{{ user.name }}</span>
            </td>
            <td>
              <span class="status" :class="user.isDisabled ? 'off' : 'on'">{{
                user.isDisabled ? "已停用" : "正常"
              }}</span>
            </td>
            <td>
              <span v-if="user.isAdmin" class="badge admin">管理员</span>
              <span v-if="user.isHidden" class="badge">隐藏</span>
              <span v-if="!user.playbackEnabled" class="badge warn">禁播</span>
            </td>
            <td>
              <span class="sessions" :class="{ active: user.activeSessions > 0 }">
                <SvgIcon type="mdi" :path="user.activeSessions > 0 ? mdiAccountMultiple : mdiLogin" :size="14" />
                {{ user.activeSessions }}
              </span>
            </td>
            <td class="dim">{{ lastLogin(user.lastActivityDate) }}</td>
            <td class="actions">
              <button
                type="button"
                :class="{ danger: !user.isDisabled }"
                :disabled="u.isUserBusy(user.id)"
                @click="u.setDisabled(user.id, !user.isDisabled)"
              >
                <SvgIcon type="mdi" :path="user.isDisabled ? mdiLockOpen : mdiLock" :size="15" />{{
                  user.isDisabled ? "启用" : "停用"
                }}
              </button>
              <button type="button" :disabled="u.isUserBusy(user.id)" @click="togglePasswordEdit(user.id)">
                改密码
              </button>
              <button type="button" class="danger" :disabled="u.isUserBusy(user.id)" @click="u.removeUser(user.id)">
                <SvgIcon type="mdi" :path="mdiDelete" :size="15" />删除
              </button>
              <div v-if="editingPassword[user.id]" class="password-row">
                <input
                  v-model="passwordEdit[user.id]"
                  type="text"
                  maxlength="200"
                  placeholder="新密码"
                  @keyup.enter="savePassword(user.id)"
                />
                <button
                  type="button"
                  class="primary"
                  :disabled="!passwordEdit[user.id] || u.busy.value"
                  @click="savePassword(user.id)"
                >
                  保存
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="table-card sessions-card">
      <div class="sessions-head">
        <h3>在线播放会话</h3>
        <span class="count"
          >{{ sessionGroups.playing.length }} 个在播<template v-if="sessionGroups.idle.length">
            · {{ sessionGroups.idle.length }} 个已连接</template
          ></span
        >
      </div>
      <div v-if="!u.sessions.value.length" class="empty">当前没有在线会话。</div>
      <template v-else>
        <div v-if="!sessionGroups.playing.length" class="empty">当前没有正在播放的会话。</div>
        <div v-else class="session-cards">
          <SessionPlaybackCard
            v-for="session in sessionGroups.playing"
            :key="session.id"
            :session="session"
            :member-email="u.users.value.find((user) => user.id === session.userId)?.name ?? null"
            @end="u.endSession"
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
              :member-email="u.users.value.find((user) => user.id === session.userId)?.name ?? null"
              @end="u.endSession"
            />
          </div>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.emby-users {
  padding: 4px 2px 20px;
  color: #dbe3e8;
}
.heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}
.heading h2 {
  margin: 0 0 4px;
  color: #f4f6f7;
  font-size: 22px;
}
.hint {
  margin: 0;
  color: #8a97a1;
  font-size: 13px;
  line-height: 1.6;
}
.refresh,
.create-form button,
.actions button,
.session-list button {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 11px;
  border: 1px solid #2b3d49;
  border-radius: 7px;
  color: #c9d3da;
  background: #12202b;
  cursor: pointer;
  font-size: 12px;
}
.refresh {
  margin-left: auto;
}
.refresh:disabled,
.create-form button:disabled {
  opacity: 0.55;
  cursor: default;
}
.create-card,
.table-card {
  margin-bottom: 16px;
  padding: 16px 18px;
  border: 1px solid #1e2d38;
  border-radius: 12px;
  background: #0c161d;
}
.create-card h3,
.table-card h3 {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 720;
}
.create-form {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}
.create-form label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: #8d9ba4;
  font-size: 12px;
}
.create-form input {
  min-height: 40px;
  padding: 0 10px;
  border: 1px solid #283b47;
  border-radius: 7px;
  color: #eef2f4;
  background: #0e1a23;
}
.admin-toggle {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  margin: 0;
}
.admin-toggle input {
  width: 18px;
  height: 18px;
  accent-color: #5aa95a;
}
button.primary {
  border-color: #3b4f2f;
  color: #d7f0d8;
  background: #17321f;
}
button.danger {
  border-color: #4a2e30;
  color: #f0b7b7;
  background: #241416;
}
button.danger:hover {
  background: #33191c;
}
.users-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.users-table th {
  padding: 8px 10px;
  border-bottom: 1px solid #20313c;
  color: #74838d;
  font-size: 11px;
  font-weight: 700;
  text-align: left;
}
.users-table td {
  padding: 10px;
  border-bottom: 1px solid #16232b;
  vertical-align: middle;
}
.user-name {
  color: #eef2f4;
  font-weight: 600;
}
.status {
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 750;
}
.status.on {
  color: #7fd08a;
  background: #10241a;
}
.status.off {
  color: #f0b7b7;
  background: #2a1717;
}
.badge {
  display: inline-block;
  margin-right: 4px;
  padding: 2px 7px;
  border-radius: 999px;
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
.sessions {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #74909c;
}
.sessions.active {
  color: #7fd08a;
}
.dim {
  color: #8a97a1;
}
.actions .password-row {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}
.actions input {
  min-height: 32px;
  padding: 0 8px;
  border: 1px solid #283b47;
  border-radius: 6px;
  color: #eef2f4;
  background: #0e1a23;
}
.sessions-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.sessions-head .count {
  color: #8a97a1;
  font-size: 12px;
}
.session-cards {
  display: grid;
  gap: 10px;
}
.idle-sessions {
  margin-top: 10px;
}
.idle-toggle {
  min-height: 32px;
  padding: 0 11px;
  border: 1px dashed #2c3e4b;
  border-radius: 8px;
  color: #8a97a1;
  background: transparent;
  font-size: 12px;
  cursor: pointer;
}
.idle-toggle:hover {
  color: #edf2f4;
  border-color: #4a5c69;
}
.idle-sessions .session-cards {
  margin-top: 10px;
}
.session-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 7px;
}
.session-list li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid #20323c;
  border-radius: 8px;
  background: #0a151c;
  font-size: 12px;
}
.session-user {
  color: #eef2f4;
  font-weight: 650;
  min-width: 110px;
}
.session-device {
  color: #aeb9c0;
  min-width: 90px;
}
.session-item {
  flex: 1;
  color: #cdd5dc;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #84929c;
}
.error {
  margin: 0 0 12px;
  padding: 10px 14px;
  border: 1px solid #4a2e30;
  border-radius: 8px;
  color: #f0b7b7;
  background: #241416;
}
.empty {
  padding: 22px;
  color: #63727d;
  font-size: 13px;
  text-align: center;
}
@media (max-width: 640px) {
  .users-table {
    font-size: 12px;
  }
  .heading {
    flex-direction: column;
  }
}
</style>
