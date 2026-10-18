<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import { mdiCheckNetworkOutline, mdiHistory, mdiLogout, mdiRefresh } from "@mdi/js";
import { onMounted } from "vue";
import type { ActivityItem, SystemStatus } from "../composables/useSystem";

defineProps<{ status: SystemStatus | null; activity: ActivityItem[]; loading: boolean; error?: string }>();
const emit = defineEmits<{ refresh: []; logout: [] }>();
onMounted(() => emit("refresh"));
function phaseLabel(value: string) {
  return (
    (
      { claimed: "已认领", running: "执行中", completed: "已完成", failed: "失败", released: "已释放" } as Record<
        string,
        string
      >
    )[value] ?? value
  );
}
</script>
<template>
  <section class="system-view" aria-labelledby="system-title">
    <header>
      <div>
        <span>SYSTEM & ACTIVITY</span>
        <h1 id="system-title">系统状态</h1>
        <p>查看 OpenClaw 接口、媒体库和最近执行记录。</p>
      </div>
      <button type="button" :disabled="loading" @click="emit('refresh')">
        <SvgIcon type="mdi" :path="mdiRefresh" :size="20" />刷新
      </button>
    </header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="status-grid">
      <article>
        <small>媒体目录</small><strong>{{ status?.rootCount ?? "—" }}</strong
        ><span>服务器已配置的只读目录</span>
      </article>
      <article>
        <small>最近扫描</small
        ><strong class="date">{{
          status?.lastScanAt
            ? new Date(status.lastScanAt).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" })
            : "尚未扫描"
        }}</strong
        ><span>扫描结果将同步任务库存</span>
      </article>
      <article>
        <small>服务器时区</small><strong class="date">{{ status?.serverTimezone ?? "—" }}</strong
        ><span>正片更新时间门控与排期按此时区计算</span>
      </article>
    </div>
    <article class="session-card">
      <div>
        <SvgIcon type="mdi" :path="mdiCheckNetworkOutline" :size="24" />
        <div>
          <strong>管理端会话</strong
          ><span
            >管理后台使用管理员账号（首启为 admin /
            admin123，可在「系统设置」修改）；朋友访问的是公开门户，各自用邮箱登录。</span
          >
        </div>
      </div>
      <button type="button" @click="emit('logout')"><SvgIcon type="mdi" :path="mdiLogout" :size="19" />退出登录</button>
    </article>
    <section class="activity">
      <h2><SvgIcon type="mdi" :path="mdiHistory" :size="22" />最近执行记录</h2>
      <div v-if="loading" class="empty">正在读取…</div>
      <div v-else-if="!activity.length" class="empty">暂无执行记录。AI 领取任务后会显示在这里。</div>
      <div v-else class="activity-list">
        <article v-for="item in activity" :key="item.id">
          <div>
            <strong>{{ item.title }}</strong
            ><span>任务 #{{ item.taskId }} · {{ item.workerId || "未知执行器" }}</span>
          </div>
          <div class="activity-state">
            <b :class="{ failed: item.error }">{{ item.error ? "失败" : phaseLabel(item.phase) }}</b
            ><time :datetime="item.startedAt">{{
              new Date(item.startedAt).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" })
            }}</time>
          </div>
          <p v-if="item.error || item.summary">{{ item.error || item.summary }}</p>
        </article>
      </div>
    </section>
  </section>
</template>
<style scoped>
.system-view {
  max-width: 1050px;
  margin: 0 auto;
}
.system-view > header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin: 10px 0 22px;
}
.system-view > header span {
  color: #68bf6a;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.14em;
}
h1 {
  margin: 5px 0;
  font-size: 30px;
}
.system-view > header p {
  margin: 0;
  color: #84929c;
}
.system-view button {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 15px;
  border: 1px solid #315244;
  border-radius: 8px;
  color: #bce8be;
  background: #10241b;
  cursor: pointer;
}
.status-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}
.status-grid article {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 18px;
  border: 1px solid #20323c;
  border-radius: 10px;
  background: #0b161d;
}
.status-grid small,
.status-grid span {
  color: #82909a;
  font-size: 12px;
}
.status-grid strong {
  font-size: 24px;
}
.status-grid strong.online {
  color: #74cd77;
}
.status-grid strong.date {
  font-size: 16px;
}
.status-grid strong.paused {
  color: #e6c06a;
}
.session-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin: 14px 0;
  padding: 17px 18px;
  border: 1px solid #263c34;
  border-radius: 10px;
  background: #0e1c17;
}
.session-card > div {
  display: flex;
  align-items: center;
  gap: 12px;
  color: #71c775;
}
.session-card > div div {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.session-card strong {
  color: #e8edef;
}
.session-card span {
  color: #82908a;
  font-size: 12px;
}
.session-card button {
  border-color: #57343a;
  color: #ebb1b1;
  background: #251518;
}
.activity {
  padding: 18px;
  border: 1px solid #20323c;
  border-radius: 10px;
  background: #0a151c;
}
.activity h2 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 14px;
  font-size: 18px;
}
.activity-list {
  display: flex;
  flex-direction: column;
}
.activity-list article {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px 15px;
  padding: 13px 0;
  border-top: 1px solid #1a2b34;
}
.activity-list article > div:first-child {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.activity-list span,
.activity-list time {
  color: #81909a;
  font-size: 12px;
}
.activity-state {
  display: flex;
  align-items: flex-end;
  gap: 10px;
}
.activity-state b {
  color: #75ca78;
  font-size: 12px;
}
.activity-state b.failed {
  color: #ef8585;
}
.activity-list p {
  grid-column: 1/-1;
  margin: 0;
  color: #a9b3b9;
  font-size: 12px;
}
.empty {
  padding: 30px;
  color: #7e8c96;
  text-align: center;
}
.error {
  padding: 12px;
  color: #ef8585;
  background: #241315;
}
@media (max-width: 640px) {
  .system-view > header {
    align-items: flex-start;
  }
  .status-grid {
    grid-template-columns: 1fr;
  }
  .session-card {
    align-items: flex-start;
  }
  .session-card > button {
    flex: none;
    padding: 0 10px;
    font-size: 12px;
  }
  .activity {
    padding: 14px;
  }
  .activity-list article {
    grid-template-columns: 1fr;
  }
  .activity-state {
    align-items: center;
    justify-content: space-between;
  }
  .activity-list p {
    grid-column: auto;
  }
}
</style>
