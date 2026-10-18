<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { useAdminSubmissions } from "../composables/useAdminSubmissions";

/**
 * 系统设置 →「公告、平台说明与邮件偏好」。
 *
 * 这四块原先挂在「会员与运营 → 运营设置」里，和会员表挤在一页：公告与平台说明是
 * "会员能看到什么内容"，邮件两块是"发不发信"，本质都是系统级配置，所以随「运营设置」
 * 这一段一起搬到系统设置（追更标记那一块已整体下线，不再有）。
 */
const props = defineProps<{ requireAuth: () => void }>();
const admin = useAdminSubmissions(props.requireAuth);
const message = ref("");
/** 平台说明正文里可用的占位符（与后端 EMBY_SERVER_ADDRESS_TOKEN 一致）。 */
const addressToken = "{{embyServerAddress}}";

onMounted(() => {
  void admin.loadMailDefaults();
  void admin.loadAdminArticles();
});

/* ---- 邮件默认发送设置（全局；用户可在「我的」里覆盖） ---- */
async function saveMailDefaults() {
  message.value = (await admin.saveMailDefaults()) ? "邮件默认发送设置已保存。" : admin.error.value || "保存失败";
}

/* ---- 用户邮件代设（按邮箱覆盖某个用户的偏好） ---- */
const adminUserMailEmail = ref("");
async function loadAdminUserMail() {
  const email = adminUserMailEmail.value.trim();
  if (!email) {
    message.value = "请输入用户邮箱。";
    return;
  }
  message.value = (await admin.loadAdminUserMail(email))
    ? `已加载 ${email} 的邮件偏好（默认可覆盖）。`
    : admin.error.value || "加载失败";
}
async function toggleUserMail(mailType: string) {
  const email = adminUserMailEmail.value.trim();
  if (!email) return;
  const current = admin.userMail.value?.effective[mailType] ?? false;
  message.value = (await admin.setAdminUserMail(email, mailType, !current))
    ? `已更新 ${email} 的「${mailType}」`
    : admin.error.value || "保存失败";
}

/* ---- 公告管理（会员进入时的弹窗） ---- */
const announcement = computed(() => admin.adminArticles.value.find((item) => item.code === "announcement"));
const announcementMsg = ref("");
const announcementMsgOk = ref(true);
const announcementSaving = ref(false);
let announcementMsgTimer: ReturnType<typeof setTimeout> | null = null;
async function saveAnnouncement() {
  if (!announcement.value || announcementSaving.value) return;
  announcementSaving.value = true;
  const ok = await admin.saveAdminArticle(announcement.value.code, {
    title: announcement.value.title,
    content: announcement.value.content,
    forceSeconds: Math.max(0, Math.min(120, Number(announcement.value.forceSeconds) || 0)),
  });
  announcementSaving.value = false;
  announcementMsgOk.value = ok;
  announcementMsg.value = ok ? "已保存并生效 ✓ 用户进入将重新弹出" : admin.error.value || "保存失败";
  if (announcementMsgTimer) clearTimeout(announcementMsgTimer);
  announcementMsgTimer = setTimeout(() => {
    announcementMsg.value = "";
  }, 2600);
}

/* ---- 平台说明与规范（会员端「我的 → 平台须知」） ---- */
async function saveArticle(item: { code: string; content: string }) {
  message.value = (await admin.saveAdminArticle(item.code, { content: item.content }))
    ? `已保存说明：${item.code}`
    : admin.error.value || "保存失败";
}
</script>

<template>
  <section class="content-mail">
    <p v-if="message" class="msg" role="status">{{ message }}</p>

    <section class="panel">
      <h3>公告管理（弹窗）</h3>
      <p class="sub-hint">保存后，用户进入平台时弹出该公告；公告内容一旦变化，即使处于免打扰期也会重新弹出。</p>
      <template v-if="announcement">
        <div class="article-admin">
          <header>
            <b>{{ announcement.title }}</b>
            <label
              ><input
                v-model="announcement.enabled"
                type="checkbox"
                @change="admin.saveAdminArticle(announcement.code, { enabled: announcement.enabled })"
              />展示</label
            >
          </header>
          <div class="force-row">
            <label
              >强制阅读（秒）<input v-model.number="announcement.forceSeconds" type="number" min="0" max="120"
            /></label>
            <small>0 = 可立即点击；1-120 = 倒计时结束后才可关闭</small>
          </div>
          <textarea v-model="announcement.content" rows="8" placeholder="输入公告内容（支持换行）"></textarea>
          <footer>
            <button type="button" class="primary" :disabled="announcementSaving" @click="saveAnnouncement">
              {{ announcementSaving ? "保存中…" : "保存并生效" }}
            </button>
            <span v-if="announcementMsg" class="panel-msg" :class="{ bad: !announcementMsgOk }" role="status">{{
              announcementMsg
            }}</span>
          </footer>
        </div>
      </template>
      <div v-else class="empty">暂无公告。</div>
    </section>

    <section class="panel">
      <h3>平台说明与规范</h3>
      <p class="sub-hint">
        用户「我的 → 平台须知」展示；公告（announcement）默认展开。正文里写
        <code>{{ addressToken }}</code> 会自动替换成「Emby 地址」当前的地址，不要写死域名（配置改了正文不会跟着改）。
      </p>
      <div class="article-admin-list">
        <article v-for="item in admin.adminArticles.value" :key="item.code" class="article-admin">
          <header>
            <b
              >{{ item.title }}<small>{{ item.code }}</small></b
            >
            <label
              ><input
                v-model="item.enabled"
                type="checkbox"
                @change="admin.saveAdminArticle(item.code, { enabled: item.enabled })"
              />展示</label
            >
          </header>
          <textarea v-model="item.content" rows="5" :placeholder="`更新 ${item.code} 的内容`"></textarea>
          <footer>
            <button type="button" class="primary" @click="saveArticle(item)">保存内容</button>
          </footer>
        </article>
      </div>
    </section>

    <section class="panel">
      <h3>邮件默认发送设置</h3>
      <p class="sub-hint">管理员全局默认；用户可在「我的 → 邮件通知偏好」单独覆盖。</p>
      <div class="mail-grid">
        <label
          v-for="option in admin.mailDefaultOptions"
          :key="option.key"
          :class="{ off: !admin.mailDefaults.value[option.key] }"
        >
          <input v-model="admin.mailDefaults.value[option.key]" type="checkbox" />
          <span class="mail-opt"
            ><b>{{ option.label }}</b
            ><small>{{ option.desc }}</small></span
          >
        </label>
      </div>
      <button type="button" class="primary" @click="saveMailDefaults">保存</button>
    </section>

    <section class="panel">
      <h3>用户邮件代设</h3>
      <p class="sub-hint">按邮箱给单个用户设置（覆盖其「我的」设置；留空/全部恢复默认 = 跟随全局默认）。</p>
      <div class="mail-grid">
        <label
          v-for="option in admin.mailDefaultOptions"
          :key="'u' + option.key"
          :class="{ off: admin.userMail.value?.effective[option.key] === false }"
        >
          <input
            type="checkbox"
            :checked="admin.userMail.value?.effective[option.key] ?? false"
            :disabled="!admin.userMail.value"
            @change="toggleUserMail(option.key)"
          />
          <span class="mail-opt"
            ><b>{{ option.label }}</b
            ><small>{{ option.desc }}</small
            ><small v-if="admin.userMail.value?.userPrefs[option.key] != null" class="mail-override"
              >已代设</small
            ></span
          >
        </label>
      </div>
      <div class="mail-row">
        <input v-model="adminUserMailEmail" type="email" placeholder="输入用户邮箱，如 member@example.com" />
        <button type="button" @click="loadAdminUserMail()">加载该用户</button>
      </div>
    </section>
  </section>
</template>

<style scoped>
.content-mail {
  max-width: 1180px;
  margin: 0 auto;
  padding: 0 22px;
}
.msg {
  margin: 6px 0 0;
  color: var(--warn);
  font-size: 13px;
}
.panel {
  margin-top: 14px;
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface);
}
.panel h3 {
  margin: 0 0 8px;
  color: var(--text);
  font-size: 16px;
}
.sub-hint {
  margin: 0 0 12px;
  color: var(--text-dim);
  font-size: 12.5px;
  line-height: 1.7;
}
.sub-hint code {
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--input);
  font-size: 12px;
}
.empty {
  color: var(--text-faint);
  font-size: 13px;
}
.mail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 8px;
  margin-bottom: 12px;
}
.mail-grid label {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--input);
  cursor: pointer;
}
.mail-grid label.off {
  opacity: 0.55;
}
.mail-opt {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.mail-opt b {
  color: var(--text);
  font-size: 13px;
}
.mail-opt small {
  color: var(--text-dim);
  font-size: 11.5px;
}
.mail-override {
  color: var(--accent-strong);
}
.mail-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.mail-row input {
  flex: 1;
  min-width: 220px;
  min-height: 36px;
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius);
  color: var(--text);
  background: var(--input);
}
.article-admin-list {
  display: grid;
  gap: 12px;
}
.article-admin {
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--input);
}
.article-admin header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.article-admin header b {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  color: var(--text);
  font-size: 13.5px;
}
.article-admin header small {
  color: var(--text-faint);
  font-size: 11px;
}
.article-admin label,
.force-row label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-dim);
  font-size: 12px;
}
.force-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.force-row input {
  width: 68px;
  min-height: 30px;
  padding: 0 8px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  color: var(--text);
  background: var(--input);
}
.force-row small {
  color: var(--text-faint);
  font-size: 11.5px;
}
.article-admin textarea {
  width: 100%;
  padding: 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius);
  color: var(--text);
  background: var(--surface);
  font-size: 13px;
  line-height: 1.6;
  resize: vertical;
}
.article-admin footer {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 10px;
}
button {
  min-height: 34px;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius);
  color: var(--text);
  background: var(--input);
  font-size: 12.5px;
  cursor: pointer;
}
button.primary {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--line));
  color: var(--accent-ink);
  background: var(--accent);
  font-weight: 700;
}
.panel-msg {
  color: var(--accent-strong);
  font-size: 12.5px;
}
.panel-msg.bad {
  color: var(--danger);
}
</style>
