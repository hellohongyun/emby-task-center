<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { MediaRequest } from "@emby-task-center/contracts/media-request";
import MediaRequestPicker from "./MediaRequestPicker.vue";
import { useMediaRequestApi } from "../composables/media-request-api";
import type { RequestMedia } from "../composables/media-request-types";
import { requestStatusLabel } from "../composables/media-request-types";

const emit = defineEmits<{ submitted: []; viewRecords: [] }>();
const api = useMediaRequestApi();
const media = ref<RequestMedia | null>(null);
const kind = ref("request");
const season = ref("");
const description = ref("");
const confirmed = ref(false);
const message = ref("");
const saved = ref(false);
const picker = ref<InstanceType<typeof MediaRequestPicker> | null>(null);
const stageHeading = ref<HTMLHeadingElement | null>(null);
defineExpose({
  startNew: () => {
    if (saved.value) reset();
  },
});
const review = ref(false);
const receipt = ref<MediaRequest | null>(null);
const stage = computed(() => (saved.value ? "receipt" : review.value ? "review" : media.value ? "details" : "search"));
watch(stage, () => stageHeading.value?.focus(), { flush: "post" });
const selectedSeason = computed(() => media.value?.seasons?.find((item) => String(item.seasonNumber) === season.value));
const scope = computed(() =>
  media.value?.mediaType === "movie"
    ? "整部电影"
    : selectedSeason.value
      ? `${season.value === "0" ? "S00 特别篇" : `S${season.value.padStart(2, "0")}`} · ${selectedSeason.value.name ?? "未命名季"} · ${selectedSeason.value.episodeCount} 集`
      : "请选择一个季",
);
const detailsValid = computed(
  () =>
    media.value &&
    (media.value.mediaType === "movie" || !!selectedSeason.value) &&
    (kind.value !== "supplement" || !!description.value.trim()),
);
const valid = computed(() => confirmed.value && detailsValid.value);
function select(value: RequestMedia | null) {
  api.error.value = "";
  media.value = value;
  description.value = "";
  season.value = "";
  confirmed.value = false;
  saved.value = false;
  message.value = "";
  kind.value = "request";
  review.value = false;
  receipt.value = null;
}
function advance() {
  if (!detailsValid.value) return;
  confirmed.value = false;
  review.value = true;
}
async function submit() {
  if (!valid.value || !media.value || api.busy.value.submit || saved.value) return;
  const result = await api.run<{ request: MediaRequest; duplicate: boolean }>("submit", "/api/public/media-requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: kind.value,
      mediaType: media.value.mediaType,
      tmdbId: media.value.tmdbId,
      seasonNumber: media.value.mediaType === "tv" ? Number(season.value) : null,
      description: description.value.trim(),
    }),
  });
  if (!result) return;
  saved.value = true;
  receipt.value = result.request;
  message.value = result.duplicate
    ? `已有未结束申请 #${result.request.id}，请在“我的申请”原记录补充说明。`
    : `申请 #${result.request.id} 已提交，可在“我的申请”查看处理状态。`;
  emit("submitted");
}
function reset() {
  api.cancel();
  select(null);
}
async function continueRequest() {
  reset();
  await nextTick();
  picker.value?.focusSearch();
}
</script>

<template>
  <section class="member-request-form" aria-label="提交求片申请">
    <template v-if="!saved">
      <MediaRequestPicker v-show="!media" ref="picker" :disabled="api.busy.value.submit" @select="select" />
      <div v-if="media" class="request-stage">
        <header class="step-heading">
          <ol class="request-steps" aria-label="申请步骤">
            <li class="complete"><span aria-hidden="true">✓</span>选作品</li>
            <li :class="{ complete: review }" :aria-current="review ? undefined : 'step'">
              <span aria-hidden="true">{{ review ? "✓" : "2" }}</span
              >填申请
            </li>
            <li :aria-current="review ? 'step' : undefined"><span aria-hidden="true">3</span>确认提交</li>
          </ol>
          <h2 ref="stageHeading" tabindex="-1">{{ review ? "确认这份申请" : "填写申请内容" }}</h2>
          <p v-if="review">核对作品和申请范围后提交。</p>
        </header>
        <div class="selected-work">
          <div class="selected-poster">
            <img
              v-if="media.posterUrl"
              :src="media.posterUrl"
              alt=""
              @error="($event.target as HTMLImageElement).hidden = true"
            /><span>暂无海报</span>
          </div>
          <div class="selected-identity">
            <span class="work-type"
              >{{ media.mediaType === "movie" ? "电影" : "剧集" }} · {{ media.releaseYear ?? "年份未知" }}</span
            >
            <h3>{{ media.title }}</h3>
            <p v-if="media.originalTitle && media.originalTitle !== media.title" class="original-title">
              {{ media.originalTitle }}
            </p>
            <small>TMDB {{ media.tmdbId }}</small>
          </div>
          <button v-if="!review" type="button" class="change-work" @click="picker?.changeSelection()">更换作品</button>
        </div>
        <form @submit.prevent="review ? submit() : advance()">
          <fieldset v-if="!review" :disabled="api.busy.value.submit">
            <legend class="sr-only">填写申请内容</legend>
            <label v-if="media.mediaType === 'tv'" class="form-field"
              >申请分季
              <select v-model="season" required @change="confirmed = false">
                <option value="" disabled>请选择一个季</option>
                <option v-for="item in media.seasons ?? []" :key="item.seasonNumber" :value="String(item.seasonNumber)">
                  {{ item.seasonNumber === 0 ? "S00 特别篇" : `S${String(item.seasonNumber).padStart(2, "0")}` }} ·
                  {{ item.name ?? "未命名季" }} · {{ item.episodeCount }} 集{{
                    item.airDate ? ` · ${item.airDate}` : ""
                  }}
                </option>
              </select>
            </label>
            <label v-if="media.mediaType === 'tv'" class="form-field"
              >申请类型
              <select v-model="kind" @change="confirmed = false">
                <option value="request">求片：申请这一季</option>
                <option value="supplement">补集：补充这一季缺少的集</option>
              </select>
            </label>
            <p v-if="media.mediaType === 'tv' && !media.seasons?.length" class="form-error" role="alert">
              该剧暂缺可确认的分季资料，无法提交，请稍后重试。
            </p>
            <p v-if="selectedSeason?.airDate" class="season-hint">本季首播于 {{ selectedSeason.airDate }}</p>
            <label class="form-field form-field--note"
              >{{ kind === "supplement" ? "缺少的集号或补集说明（必填）" : "申请说明（可选）" }}
              <textarea
                v-model="description"
                :required="kind === 'supplement'"
                rows="3"
                maxlength="2000"
                :placeholder="
                  kind === 'supplement' ? '例如 E13–E16，或写明缺少的内容、版本要求' : '可说明版本、配音等要求'
                "
              />
            </label>
            <p class="field-hint">
              {{
                kind === "supplement"
                  ? "请写清缺少的内容，方便管理员核查。"
                  : "有特别想看的版本？可以在这里告诉管理员。"
              }}<span>{{ description.length }}/2000</span>
            </p>
          </fieldset>
          <div v-else class="confirmation-panel">
            <dl>
              <div>
                <dt>申请类型</dt>
                <dd>{{ kind === "supplement" ? "补集" : "求片" }}</dd>
              </div>
              <div>
                <dt>申请范围</dt>
                <dd>{{ scope }}</dd>
              </div>
              <div v-if="selectedSeason?.airDate">
                <dt>分季首播</dt>
                <dd>{{ selectedSeason.airDate }}</dd>
              </div>
              <div class="summary-description">
                <dt>申请说明</dt>
                <dd class="summary-note">{{ description.trim() || "未填写" }}</dd>
              </div>
            </dl>
            <label class="confirm"
              ><input
                v-model="confirmed"
                type="checkbox"
                required
                :disabled="api.busy.value.submit"
              />我已核对作品、年份{{ media.mediaType === "tv" ? "和分季" : "" }}</label
            >
            <p class="review-hint">提交后由管理员寻找资源并处理，可在“我的申请”查看进度。</p>
          </div>
          <p v-if="api.error.value" class="form-error" role="alert">
            {{ api.error.value }}<span>已保留当前申请内容。</span>
          </p>
          <div class="form-actions">
            <button
              v-if="review"
              type="button"
              class="secondary"
              :disabled="api.busy.value.submit"
              @click="
                review = false;
                confirmed = false;
              "
            >
              返回修改
            </button>
            <button v-if="!review" type="submit" class="primary" :disabled="!detailsValid">
              下一步，核对申请 <span aria-hidden="true">→</span>
            </button>
            <button v-else type="submit" class="primary" :disabled="!valid || api.busy.value.submit">
              {{ api.busy.value.submit ? "正在提交…" : "确认提交" }}
            </button>
          </div>
        </form>
      </div>
    </template>
    <div v-else class="request-stage request-receipt">
      <header class="receipt-heading">
        <span class="receipt-check" aria-hidden="true">✓</span>
        <div>
          <h2 ref="stageHeading" tabindex="-1">
            {{ message.startsWith("已有") ? "找到你之前的申请" : "已收到你的申请" }}
          </h2>
          <p class="receipt-message" role="status">{{ message }}</p>
        </div>
      </header>
      <div v-if="receipt" class="receipt-work">
        <strong>{{ receipt.title }}</strong
        ><span
          >{{ receipt.mediaType === "movie" ? "整部电影" : `S${String(receipt.seasonNumber).padStart(2, "0")}` }} ·
          {{ requestStatusLabel(receipt.status) }}</span
        >
      </div>
      <div class="receipt-actions">
        <button type="button" class="primary" @click="emit('viewRecords')">查看我的申请</button
        ><button type="button" class="secondary" @click="continueRequest">继续申请其他作品或分季</button>
      </div>
    </div>
  </section>
</template>

<style scoped src="./MediaRequestForm.css"></style>
<style scoped src="./MediaRequestForm.confirm.css"></style>
