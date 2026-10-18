<script setup lang="ts">
import SvgIcon from "@jamescoyle/vue-icon";
import {
  mdiAlertCircleOutline,
  mdiCastVariant,
  mdiContentDuplicate,
  mdiPauseCircle,
  mdiPlayCircle,
  mdiSubtitlesOutline,
} from "@mdi/js";
import { computed } from "vue";

import { isSystemSession } from "../library/session-groups";
import type { EmbySessionRow } from "../types";

/**
 * 在线播放会话详情卡：按 Emby 客户端"播放状态"那一屏的粒度展示。
 *
 * 谁 / 哪台设备 / 什么客户端 / 在看哪一集 / 看到第几分钟 / 直接播放还是转码 /
 * 容器与码率 / 视频编码 / 音轨 / 字幕。所有文案由服务端算好（emby-playback.ts），
 * 这里只做排版，保证管理端与其它消费者看到的是同一套说法。
 */
const props = withDefaults(
  defineProps<{
    session: EmbySessionRow;
    /** 关联到的会员邮箱（会话里有 Emby 账号但未必是会员）。 */
    memberEmail?: string | null;
    /** 是否显示"断开"按钮。 */
    allowEnd?: boolean;
  }>(),
  // 布尔 prop 缺省会被 Vue 强制成 false，这里显式给 true 默认值（否则按钮永不渲染）。
  { memberEmail: null, allowEnd: true },
);

const emit = defineEmits<{ end: [sessionId: string] }>();

const playing = computed(() => Boolean(props.session.item));
const paused = computed(() => props.session.isPaused);
/**
 * 进度百分比；**null = 总时长未知**（.strm / 网盘直链片源在 Emby 里没有 RunTimeTicks）。
 * 这里以前写的是 `?? 0`：未知被画成"0% 宽的进度条"，于是那次会话看起来
 * "只有播放时间、没有进度条"。未知要画成不确定态，不能画成 0%。
 */
const progress = computed(() => {
  const value = props.session.progressPercent;
  if (value == null) return null;
  return Math.max(0, Math.min(100, value));
});
const elapsedText = computed(() => props.session.positionText ?? "0:00");
/** 总时长未知时给个能查的说法（title 提示），省得管理员以为是面板卡了。 */
const unknownReason = "Emby 未提供该片源的总时长（.strm / 网盘直链常见），只能显示已播时间";
/** 没有绑定任何 Emby 用户的会话 = 本应用/系统自己连上去的（媒体任务中心、TgtoDrive…）。 */
const systemSession = computed(() => isSystemSession(props.session));
const sessionLabel = computed(() => {
  // 系统会话没有会员身份：身份位直接写清它是什么，具体是哪个客户端在下面的"设备"里已经有了。
  if (systemSession.value) return "系统 / 应用会话";
  return props.memberEmail || props.session.userName || "未知用户";
});

/** 客户端与人：Emby 给什么显示什么，缺的留空而不是编一个。 */
const clientLine = computed(() =>
  [props.session.client, props.session.applicationVersion].filter(Boolean).join(" ").trim(),
);
const deviceLine = computed(() => props.session.deviceName ?? "未知设备");
const transcodeReasons = computed(() => props.session.transcoding?.reasonsLabel ?? "");

function directLabel(isDirect: boolean | null): string {
  if (isDirect == null) return "";
  return isDirect ? "直接播放" : "转码";
}
</script>

<template>
  <article class="session" :class="{ playing, paused }" :aria-label="playing ? '正在播放' : '已连接的会话'">
    <header class="head">
      <span class="state">
        <i class="dot" :class="{ live: playing && !paused, paused }"></i>
        <SvgIcon v-if="paused" type="mdi" :path="mdiPauseCircle" :size="15" />
        <SvgIcon v-else-if="playing" type="mdi" :path="mdiPlayCircle" :size="15" />
      </span>
      <div class="title-block">
        <p class="title">
          <template v-if="playing">{{ session.item?.displayTitle ?? session.nowPlaying }}</template>
          <template v-else>已连接（未播放）</template>
        </p>
        <p class="subtitle">
          <span class="who">{{ sessionLabel }}</span>
          <template v-if="memberEmail && session.userName && memberEmail !== session.userName">
            <span class="sep">·</span><span class="dim">{{ session.userName }}</span>
          </template>
          <template v-if="session.item?.episodeLabel">
            <span class="sep">·</span><span class="dim">{{ session.item.episodeLabel }}</span>
          </template>
        </p>
      </div>
      <div class="time" v-if="playing">
        <template v-if="session.runTimeText">
          <b>{{ elapsedText }}</b>
          <span>/ {{ session.runTimeText }}</span>
        </template>
        <!-- 总时长未知：只说"已播多久"，不编一个总时长出来 -->
        <template v-else>
          <span class="dim">已播</span>
          <b>{{ elapsedText }}</b>
          <span class="dim">· 总时长未知</span>
        </template>
      </div>
      <button v-if="allowEnd !== false" type="button" class="danger" @click="emit('end', session.id)">断开</button>
    </header>

    <!--
      进度条三态：已知 → 实心百分比；总时长未知 → 不确定态（流动扫光）；未播放 → 整条不渲染。
      未知态刻意不给 aria-valuenow：读屏念"0%"是错的，那时根本没有百分比。
    -->
    <div
      v-if="playing"
      class="progress"
      :class="{ unknown: progress == null }"
      role="progressbar"
      :aria-valuenow="progress == null ? undefined : Math.round(progress)"
      :aria-valuetext="progress == null ? '总时长未知，仅显示已播时间' : undefined"
      :title="progress == null ? unknownReason : `播放进度 ${Math.round(progress)}%`"
      aria-label="播放进度"
    >
      <div v-if="progress != null" class="bar" :style="{ width: progress + '%' }"></div>
      <div v-else class="bar sweeping"></div>
    </div>

    <dl class="facts">
      <div class="fact">
        <dt><SvgIcon type="mdi" :path="mdiCastVariant" :size="13" />设备</dt>
        <dd>
          <b>{{ deviceLine }}</b>
          <span v-if="clientLine" class="dim">{{ clientLine }}</span>
        </dd>
      </div>
      <div class="fact">
        <dt>来源 IP</dt>
        <dd>
          <code>{{ session.remoteAddress ?? "—" }}</code>
        </dd>
      </div>
      <div class="fact" v-if="playing">
        <dt>方式</dt>
        <dd>
          <span class="chip" :class="{ warn: session.playMethod === 'Transcode' }">{{
            session.playMethodLabel || "未知"
          }}</span>
          <span v-if="session.container || session.bitrateText" class="dim">
            {{ [session.container, session.bitrateText].filter(Boolean).join(" · ") }}
          </span>
        </dd>
      </div>
      <div class="fact" v-if="playing && session.videoLabel">
        <dt>视频</dt>
        <dd>
          <b>{{ session.videoLabel }}</b>
          <span class="dim">{{ directLabel(session.videoDirect) }}</span>
        </dd>
      </div>
      <div class="fact" v-if="playing && session.audioLabel">
        <dt>音频</dt>
        <dd>
          <b>{{ session.audioLabel }}</b>
          <span class="dim">{{ directLabel(session.audioDirect) }}</span>
          <span v-if="session.audioStreams.length > 1" class="dim" :title="session.audioStreams.join('\n')">
            <SvgIcon type="mdi" :path="mdiContentDuplicate" :size="12" />{{ session.audioStreams.length }} 条音轨
          </span>
        </dd>
      </div>
      <div class="fact" v-if="playing && session.subtitleLabel">
        <dt><SvgIcon type="mdi" :path="mdiSubtitlesOutline" :size="13" />字幕</dt>
        <dd>
          <b>{{ session.subtitleLabel }}</b>
        </dd>
      </div>
      <div class="fact" v-if="session.mediaSourceName">
        <dt>片源</dt>
        <dd class="dim">{{ session.mediaSourceName }}</dd>
      </div>
      <div class="fact" v-if="session.lastActivityDate">
        <dt>最后活动</dt>
        <dd class="dim">{{ new Date(session.lastActivityDate).toLocaleString("zh-CN") }}</dd>
      </div>
    </dl>

    <p v-if="transcodeReasons" class="transcode">
      <SvgIcon type="mdi" :path="mdiAlertCircleOutline" :size="14" />转码原因：{{ transcodeReasons }}
      <template v-if="session.transcoding?.hardwareAcceleration">
        · 硬件加速 {{ session.transcoding.hardwareAcceleration }}
      </template>
    </p>
  </article>
</template>

<style scoped>
.session {
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface);
}
.session.playing {
  border-color: color-mix(in srgb, var(--accent) 34%, var(--line));
  background: linear-gradient(180deg, var(--accent-dim), transparent 62%), var(--surface);
}
.head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.state {
  display: inline-flex;
  align-items: center;
  color: var(--text-dim);
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--text-faint);
}
.dot.live {
  background: var(--accent-strong);
  box-shadow: 0 0 0 4px var(--accent-dim);
}
.dot.paused {
  background: var(--warn);
}
.title-block {
  flex: 1;
  min-width: 0;
}
.title {
  margin: 0;
  color: var(--text);
  font-size: 14px;
  font-weight: 680;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.subtitle {
  margin: 3px 0 0;
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  color: var(--text-dim);
  font-size: 12px;
}
.who {
  color: var(--accent-strong);
  font-weight: 640;
}
.time {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  color: var(--text-dim);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.time b {
  color: var(--text);
  font-size: 14px;
}
.progress {
  margin: 10px 0 2px;
  height: 5px;
  border-radius: var(--radius-pill);
  background: var(--input);
  overflow: hidden;
}
.bar {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--accent), var(--accent-strong));
  transition: width 0.4s var(--ease);
}
/* 总时长未知：轨道本身给点纹理，配下面那道扫光，一眼看出"在播但算不出百分比" */
.progress.unknown {
  background: repeating-linear-gradient(
    90deg,
    var(--input) 0 6px,
    color-mix(in srgb, var(--input) 62%, var(--line)) 6px 12px
  );
}
.bar.sweeping {
  width: 38%;
  background: linear-gradient(90deg, transparent, var(--accent) 45%, var(--accent-strong) 60%, transparent);
  animation: sweep 1.6s var(--ease) infinite;
}
@keyframes sweep {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(265%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .bar.sweeping {
    animation: none;
    width: 100%;
    opacity: 0.45;
  }
}
.facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 8px 16px;
  margin: 12px 0 0;
}
.fact {
  min-width: 0;
}
.fact dt {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-faint);
  font-size: 11px;
  letter-spacing: 0.02em;
}
.fact dd {
  margin: 2px 0 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  color: var(--text);
  font-size: 12.5px;
}
.fact dd b {
  font-weight: 640;
}
.fact code {
  color: var(--text-dim);
  font-size: 12px;
}
.dim {
  color: var(--text-dim);
  font-weight: 400;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.sep {
  color: var(--text-faint);
}
.chip {
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  color: var(--accent-strong);
  background: var(--accent-dim);
  font-size: 11px;
  font-weight: 700;
}
.chip.warn {
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 16%, transparent);
}
.transcode {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 10px 0 0;
  color: var(--warn);
  font-size: 12px;
}
button.danger {
  min-height: 32px;
  padding: 0 11px;
  border: 1px solid #4a2e30;
  border-radius: 7px;
  color: #f0b7b7;
  background: #241416;
  font-size: 12px;
  cursor: pointer;
}
button.danger:hover {
  background: #33191c;
}
</style>
