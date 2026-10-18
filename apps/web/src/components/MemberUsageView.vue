<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import {
  mdiAccountClockOutline,
  mdiChartTimelineVariant,
  mdiClockOutline,
  mdiHistory,
  mdiLogin,
  mdiPlayCircleOutline,
  mdiRefresh,
  mdiTelevisionPlay,
} from "@mdi/js";
import { computed, onMounted, ref } from "vue";

import { useMemberUsage } from "../composables/useMemberUsage";
import type { UsageMemberSummary } from "../types";

/**
 * 会员使用记录：谁在什么时候登录、看了什么、一天里的哪些时段在用。
 *
 * 数据不是 Emby 的实时快照，而是应用自己攒的台账（每 30 秒采样 + 回填 Emby 活动日志），
 * 所以页头把"记录从哪来"写清楚，并提供「刷新记录」手动触发一次采样 —— 刚装好就能看到内容。
 */
const props = defineProps<{ requireAuth: () => void }>();

const usage = useMemberUsage(props.requireAuth);
const days = ref(7);
const message = ref("");

const RANGES = [
  { value: 1, label: "今天" },
  { value: 7, label: "近 7 天" },
  { value: 30, label: "近 30 天" },
];

const overview = computed(() => usage.overview.value);
const members = computed(() => overview.value?.members ?? []);
/** 时段图强度归一化用的峰值（全站与单会员各自算）。 */
const peakHour = computed(() => Math.max(1, ...(overview.value?.hourly ?? [0])));
const peakHourLabel = computed(() => {
  const hourly = overview.value?.hourly ?? [];
  if (!hourly.some((minutes) => minutes > 0)) return "暂无数据";
  const index = hourly.indexOf(Math.max(...hourly));
  return `${String(index).padStart(2, "0")}:00 – ${String((index + 1) % 24).padStart(2, "0")}:00`;
});

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}`;
}

function durationText(minutes: number): string {
  if (!minutes) return "—";
  if (minutes < 60) return `${Math.round(minutes)} 分`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

function momentText(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dayText(value: string): string {
  const [, month, day] = value.split("-");
  return `${month}-${day}`;
}

/** 表里那一行的 24 格"时段条"：按该会员自己的峰值上色。 */
function rowPeak(member: UsageMemberSummary): number {
  return Math.max(1, ...member.hourly);
}
function intensity(minutes: number, peak: number): number {
  if (minutes <= 0) return 0;
  return Math.max(0.14, Math.min(1, minutes / peak));
}

const eventMeta: Record<string, { label: string; cls: string }> = {
  login: { label: "登录", cls: "ok" },
  play_start: { label: "开始播放", cls: "play" },
  play_stop: { label: "结束播放", cls: "stop" },
  session_end: { label: "断开连接", cls: "stop" },
  other: { label: "其它活动", cls: "dim" },
};

function eventLabel(kind: string): string {
  return eventMeta[kind]?.label ?? kind;
}
function eventClass(kind: string): string {
  return eventMeta[kind]?.cls ?? "dim";
}
function eventItemText(event: {
  itemTitle: string | null;
  episodeTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
}): string {
  const tag =
    event.seasonNumber != null && event.episodeNumber != null ? ` S${event.seasonNumber}E${event.episodeNumber}` : "";
  const head = event.itemTitle ? `${event.itemTitle}${tag}` : "";
  return [head, event.episodeTitle].filter(Boolean).join(" · ");
}

async function changeDays(value: number) {
  days.value = value;
  usage.closeDetail();
  await usage.load(value);
}

async function openDetail(member: UsageMemberSummary) {
  await usage.loadDetail(member.key, days.value);
}

async function refreshNow() {
  message.value = "正在从 Emby 采集…";
  const result = await usage.refreshNow(days.value);
  if (!result) {
    message.value = usage.error.value || "刷新失败";
    return;
  }
  // 服务端理论上一定回这两个字段；这里仍然按缺省处理，别让一次异常响应把页面打崩。
  const sampled = result.sampled ?? { observed: 0 };
  const activity = result.activity ?? { inserted: 0, unsupported: false };
  const parts = [
    sampled.observed ? `当前 ${sampled.observed} 个会话` : "当前没有在线会话",
    activity.unsupported ? "该 Emby 不支持活动日志回填" : `活动日志补录 ${activity.inserted} 条`,
  ];
  message.value = `已采集：${parts.join("，")}。`;
}

onMounted(async () => {
  await usage.load(days.value);
  // 首次进入时若一条记录都没有，自动去 Emby 采一次（用户不必先点按钮才知道这页是干什么的）。
  if (overview.value && members.value.every((member) => member.playMinutes === 0 && member.loginCount === 0)) {
    await refreshNow();
  }
});
</script>

<template>
  <section class="usage" aria-labelledby="usage-title">
    <header class="head">
      <div class="head-main">
        <div class="head-title">
          <span class="head-icon" aria-hidden="true"
            ><SvgIcon type="mdi" :path="mdiAccountClockOutline" :size="22"
          /></span>
          <h2 id="usage-title">使用记录</h2>
        </div>
        <p class="head-sub">
          谁在什么时候登录、看了什么、一天里的哪些时段在用。记录由系统自己攒：每 30 秒采样一次 Emby 在线会话，并回填
          Emby 活动日志里的登录/播放历史。
        </p>
      </div>
      <div class="head-actions">
        <div class="ranges" role="group" aria-label="统计范围">
          <button
            v-for="item in RANGES"
            :key="item.value"
            type="button"
            :class="{ active: days === item.value }"
            @click="changeDays(item.value)"
          >
            {{ item.label }}
          </button>
        </div>
        <button type="button" class="refresh" :disabled="usage.refreshing.value" @click="refreshNow">
          <SvgIcon type="mdi" :path="mdiRefresh" :size="16" />{{ usage.refreshing.value ? "采集中…" : "刷新记录" }}
        </button>
      </div>
    </header>

    <p v-if="message" class="msg" role="status">{{ message }}</p>
    <p v-if="usage.error.value" class="error" role="alert">{{ usage.error.value }}</p>

    <ul class="stats" aria-label="概览">
      <li>
        <b>{{ overview?.totals.activeMembers ?? 0 }}</b
        ><span>活跃会员</span>
      </li>
      <li>
        <b>{{ overview?.totals.logins ?? 0 }}</b
        ><span>登录次数</span>
      </li>
      <li>
        <b>{{ overview?.totals.plays ?? 0 }}</b
        ><span>播放次数</span>
      </li>
      <li>
        <b>{{ overview?.totals.playHours ?? 0 }}</b
        ><span>观看小时</span>
      </li>
      <li>
        <b>{{ overview?.totals.devices ?? 0 }}</b
        ><span>使用设备</span>
      </li>
      <li>
        <b class="peak">{{ peakHourLabel }}</b
        ><span>高峰时段</span>
      </li>
    </ul>

    <!-- 全站时段分布 -->
    <section class="panel">
      <div class="panel-head">
        <h3><SvgIcon type="mdi" :path="mdiClockOutline" :size="16" />全站使用时段</h3>
        <span class="panel-hint">按小时统计观看分钟数（本地时间）</span>
      </div>
      <div v-if="usage.loading.value" class="empty">正在读取…</div>
      <div v-else class="hour-chart" role="img" aria-label="按小时的使用分布">
        <div v-for="(minutes, hour) in overview?.hourly ?? []" :key="hour" class="hour-col">
          <div class="hour-bar-wrap">
            <div
              class="hour-bar"
              :style="{ height: Math.round(intensity(minutes, peakHour) * 100) + '%' }"
              :title="`${hourLabel(hour)}:00 · ${durationText(minutes)}`"
            ></div>
          </div>
          <span class="hour-label">{{ hourLabel(hour) }}</span>
        </div>
      </div>
    </section>

    <!-- 会员使用表 -->
    <section class="panel">
      <div class="panel-head">
        <h3><SvgIcon type="mdi" :path="mdiChartTimelineVariant" :size="16" />会员使用情况</h3>
        <span class="panel-hint">{{ members.length }} 个账号 · 无记录的会员也列出来（显示 0）</span>
      </div>
      <div v-if="usage.loading.value" class="empty">正在读取…</div>
      <div v-else-if="!members.length" class="empty">还没有会员账号。</div>
      <div v-else class="table-wrap">
        <table class="usage-table">
          <thead>
            <tr>
              <th>会员 / 账号</th>
              <th>最近登录</th>
              <th>登录</th>
              <th>播放</th>
              <th>观看时长</th>
              <th>活跃天数</th>
              <th>最近观看</th>
              <th>使用时段（0–23 时）</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="member in members" :key="member.key">
              <td>
                <b class="email">{{ member.email ?? member.userName ?? member.key }}</b>
                <small v-if="!member.email" class="email-note">未绑定会员（仅 Emby 账号）</small>
              </td>
              <td class="dim">{{ momentText(member.lastLoginAt) }}</td>
              <td>
                <span class="count" :class="{ zero: !member.loginCount }">
                  <SvgIcon type="mdi" :path="mdiLogin" :size="12" />{{ member.loginCount }}
                </span>
              </td>
              <td>
                <span class="count" :class="{ zero: !member.plays }">
                  <SvgIcon type="mdi" :path="mdiPlayCircleOutline" :size="12" />{{ member.plays }}
                </span>
              </td>
              <td>
                <b :class="{ dim: !member.playMinutes }">{{ durationText(member.playMinutes) }}</b>
              </td>
              <td class="dim">{{ member.activeDays || "—" }}</td>
              <td class="dim item-cell" :title="member.topItems[0]?.title ?? ''">
                {{ member.topItems[0]?.title ?? "—" }}
              </td>
              <td>
                <div class="spark" :aria-label="`使用时段分布`">
                  <i
                    v-for="(minutes, hour) in member.hourly"
                    :key="hour"
                    :style="{ opacity: intensity(minutes, rowPeak(member)) }"
                    :title="`${hourLabel(hour)}:00 · ${durationText(minutes)}`"
                  ></i>
                </div>
              </td>
              <td>
                <button type="button" class="link" @click="openDetail(member)">
                  <SvgIcon type="mdi" :path="mdiHistory" :size="14" />详情
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 单会员详情 -->
    <section v-if="usage.detail.value || usage.detailLoading.value" class="panel detail">
      <div class="panel-head">
        <h3>
          <SvgIcon type="mdi" :path="mdiTelevisionPlay" :size="16" />{{
            usage.detail.value?.member.email ?? usage.detail.value?.member.userName ?? "会员详情"
          }}
        </h3>
        <button type="button" class="link" @click="usage.closeDetail()">关闭</button>
      </div>
      <div v-if="usage.detailLoading.value" class="empty">正在读取…</div>
      <template v-else-if="usage.detail.value">
        <div class="detail-grid">
          <div class="detail-block">
            <h4>近 {{ days }} 天概况</h4>
            <ul class="facts">
              <li>
                <span>最近登录</span><b>{{ momentText(usage.detail.value.member.lastLoginAt) }}</b>
              </li>
              <li>
                <span>登录次数</span><b>{{ usage.detail.value.member.loginCount }}</b>
              </li>
              <li>
                <span>播放次数</span><b>{{ usage.detail.value.member.plays }}</b>
              </li>
              <li>
                <span>观看时长</span><b>{{ durationText(usage.detail.value.member.playMinutes) }}</b>
              </li>
              <li>
                <span>挂着时长</span><b>{{ durationText(usage.detail.value.member.idleMinutes) }}</b>
              </li>
              <li>
                <span>活跃天数</span><b>{{ usage.detail.value.member.activeDays }}</b>
              </li>
            </ul>
            <h4>看过的内容</h4>
            <ul v-if="usage.detail.value.recentItems.length" class="items">
              <li v-for="item in usage.detail.value.recentItems" :key="item.title + item.lastAt">
                <b>{{ item.title }}</b>
                <span class="dim">{{ item.plays }} 次 · {{ durationText(item.minutes) }}</span>
                <span class="dim">{{ momentText(item.lastAt) }}</span>
              </li>
            </ul>
            <p v-else class="empty small">这段时间没有观看记录。</p>
          </div>

          <div class="detail-block">
            <h4>每天的使用时段</h4>
            <div v-if="usage.detail.value.heatmap.length" class="heatmap">
              <div v-for="row in usage.detail.value.heatmap" :key="row.date" class="heat-row">
                <span class="heat-date">{{ dayText(row.date) }}</span>
                <div class="heat-cells">
                  <i
                    v-for="(minutes, hour) in row.hours"
                    :key="hour"
                    :style="{ opacity: minutes > 0 ? intensity(minutes, Math.max(1, ...row.hours)) : 0.05 }"
                    :title="`${row.date} ${hourLabel(hour)}:00 · ${durationText(minutes)}`"
                  ></i>
                </div>
              </div>
              <div class="heat-axis">
                <span class="heat-date"></span>
                <div class="heat-cells">
                  <span v-for="hour in 24" :key="hour" class="heat-tick">{{
                    (hour - 1) % 6 === 0 ? hourLabel(hour - 1) : ""
                  }}</span>
                </div>
              </div>
            </div>
            <p v-else class="empty small">这段时间没有观看记录。</p>
          </div>
        </div>

        <h4>最近事件</h4>
        <ul v-if="usage.detail.value.events.length" class="timeline">
          <li v-for="event in usage.detail.value.events" :key="event.id">
            <span :class="['kind', eventClass(event.kind)]">{{ eventLabel(event.kind) }}</span>
            <span class="when">{{ momentText(event.occurredAt) }}</span>
            <span class="what">
              <template v-if="eventItemText(event)">{{ eventItemText(event) }}</template>
              <template v-else-if="event.detail">{{ event.detail }}</template>
              <template v-else>—</template>
            </span>
            <span class="where dim">
              {{ [event.deviceName, event.client, event.appVersion].filter(Boolean).join(" · ") }}
            </span>
            <span class="ip dim">{{ event.remoteAddress ?? "" }}</span>
          </li>
        </ul>
        <p v-else class="empty small">暂无可展示的事件（登录/播放记录会随着使用持续累积）。</p>
      </template>
    </section>
  </section>
</template>

<style scoped>
.usage {
  padding: 22px;
  max-width: 1180px;
  margin: 0 auto;
  color: var(--text);
}
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}
.head-title {
  display: flex;
  align-items: center;
  gap: 9px;
}
.head-title h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 740;
}
.head-icon {
  display: inline-flex;
  color: var(--accent-strong);
}
.head-sub {
  margin: 6px 0 0;
  max-width: 720px;
  color: var(--text-dim);
  font-size: 12.5px;
  line-height: 1.6;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ranges {
  display: inline-flex;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  background: var(--surface);
}
.ranges button {
  min-height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--radius-pill);
  color: var(--text-dim);
  background: transparent;
  font-size: 12px;
  cursor: pointer;
}
.ranges button.active {
  color: var(--accent-ink);
  background: var(--accent);
  font-weight: 700;
}
.refresh {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
  color: var(--text);
  background: var(--surface-hi);
  font-size: 12.5px;
  cursor: pointer;
}
.refresh:disabled {
  opacity: 0.6;
  cursor: default;
}
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px;
  margin: 0 0 16px;
  padding: 0;
  list-style: none;
}
.stats li {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}
.stats b {
  font-size: 19px;
  font-weight: 740;
}
.stats b.peak {
  font-size: 15px;
}
.stats span {
  color: var(--text-dim);
  font-size: 11.5px;
}
.panel {
  margin-bottom: 16px;
  padding: 16px 18px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--bg-raised);
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.panel-head h3 {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  font-size: 14.5px;
  font-weight: 700;
}
.panel-hint {
  color: var(--text-faint);
  font-size: 11.5px;
}
.hour-chart {
  display: grid;
  grid-template-columns: repeat(24, 1fr);
  gap: 4px;
  height: 120px;
  align-items: end;
}
.hour-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  height: 100%;
  /* 24 列在窄屏上会被刻度文字撑破：显式允许收缩，否则整页横向溢出。 */
  min-width: 0;
}
.hour-bar-wrap {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: flex-end;
  border-radius: 5px;
  background: var(--input);
}
.hour-bar {
  width: 100%;
  min-height: 2px;
  border-radius: 5px;
  background: linear-gradient(180deg, var(--accent-strong), var(--accent));
}
.hour-label {
  max-width: 100%;
  overflow: hidden;
  color: var(--text-faint);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.table-wrap {
  overflow-x: auto;
}
.usage-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.usage-table th {
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
  color: var(--text-faint);
  font-size: 11px;
  font-weight: 700;
  text-align: left;
  white-space: nowrap;
}
.usage-table td {
  padding: 9px 10px;
  border-bottom: 1px solid var(--line);
  vertical-align: middle;
}
.email {
  font-weight: 650;
}
.email-note {
  display: block;
  margin-top: 2px;
  color: var(--text-faint);
  font-size: 10.5px;
}
.count {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--accent-strong);
  font-weight: 650;
}
.count.zero {
  color: var(--text-faint);
}
.dim {
  color: var(--text-dim);
}
.item-cell {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.spark {
  display: grid;
  grid-template-columns: repeat(24, 1fr);
  gap: 2px;
  min-width: 150px;
}
.spark i {
  height: 16px;
  border-radius: 2px;
  background: var(--accent-strong);
}
.link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
  color: var(--text);
  background: var(--surface-hi);
  font-size: 11.5px;
  cursor: pointer;
}
.link:hover {
  border-color: var(--accent-ring);
  color: var(--accent-strong);
}
.detail .detail-grid {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) minmax(320px, 1.4fr);
  gap: 18px;
}
.detail h4 {
  margin: 14px 0 8px;
  color: var(--text-dim);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.03em;
}
.detail-block h4:first-child {
  margin-top: 0;
}
.facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.facts li {
  padding: 9px 11px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}
.facts span {
  display: block;
  color: var(--text-faint);
  font-size: 11px;
}
.facts b {
  font-size: 13.5px;
}
.items {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 6px;
}
.items li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 11px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  font-size: 12.5px;
}
.items li b {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.heatmap {
  display: grid;
  gap: 4px;
}
.heat-row,
.heat-axis {
  display: grid;
  grid-template-columns: 48px 1fr;
  align-items: center;
  gap: 8px;
}
.heat-date {
  color: var(--text-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.heat-cells {
  display: grid;
  grid-template-columns: repeat(24, 1fr);
  gap: 2px;
}
.heat-cells i {
  height: 14px;
  border-radius: 3px;
  background: var(--accent-strong);
}
.heat-tick {
  color: var(--text-faint);
  font-size: 9.5px;
  text-align: left;
}
.timeline {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 5px;
  max-height: 340px;
  overflow-y: auto;
}
.timeline li {
  display: grid;
  grid-template-columns: 64px 108px 1fr auto auto;
  align-items: center;
  gap: 10px;
  padding: 8px 11px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  font-size: 12px;
}
.kind {
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  font-size: 11px;
  font-weight: 700;
  text-align: center;
}
.kind.ok {
  color: var(--accent-strong);
  background: var(--accent-dim);
}
.kind.play {
  color: #8fb7e8;
  background: rgb(143 183 232 / 15%);
}
.kind.stop {
  color: var(--warn);
  background: rgb(230 192 106 / 14%);
}
.kind.dim {
  color: var(--text-dim);
  background: var(--surface-hi);
}
.when {
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.what {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.where,
.ip {
  font-size: 11.5px;
  white-space: nowrap;
}
.msg {
  margin: 0 0 12px;
  padding: 9px 13px;
  border: 1px solid var(--accent-ring);
  border-radius: var(--radius);
  color: var(--accent-strong);
  background: var(--accent-dim);
  font-size: 12.5px;
}
.error {
  margin: 0 0 12px;
  padding: 9px 13px;
  border: 1px solid #4a2e30;
  border-radius: var(--radius);
  color: var(--danger);
  background: #241416;
  font-size: 12.5px;
}
.empty {
  padding: 22px;
  color: var(--text-faint);
  font-size: 12.5px;
  text-align: center;
}
.empty.small {
  padding: 12px;
  text-align: left;
}
@media (max-width: 900px) {
  .head {
    flex-direction: column;
  }
  .detail .detail-grid {
    grid-template-columns: 1fr;
  }
  .timeline li {
    grid-template-columns: 64px 1fr;
  }
}
@media (max-width: 640px) {
  .usage {
    padding: 16px 14px;
  }
  .hour-chart {
    gap: 2px;
    height: 96px;
  }
  .hour-label {
    font-size: 8.5px;
  }
  .head-actions {
    flex-wrap: wrap;
    width: 100%;
  }
}
</style>
