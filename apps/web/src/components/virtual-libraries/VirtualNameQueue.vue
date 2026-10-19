<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{ names: string[]; index: number; busy: boolean }>();
const emit = defineEmits<{ start: [names: string[]]; skip: []; stop: [] }>();
const draft = ref("");
const parsedNames = computed(() =>
  draft.value
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean),
);
const running = computed(() => props.names.length > 0);
const complete = computed(() => running.value && props.index >= props.names.length);
function start() {
  if (!props.busy && !running.value && parsedNames.value.length) emit("start", parsedNames.value);
}
</script>

<template>
  <section class="vl-name-queue" aria-label="名单逐项选片">
    <template v-if="running">
      <div class="vl-name-queue-status" role="status" aria-live="polite">
        <template v-if="complete">
          <strong>名单已完成</strong>
          <span>共 {{ names.length }} 项</span>
        </template>
        <template v-else>
          <span>名单进度 {{ index + 1 }} / {{ names.length }}</span>
          <strong>{{ names[index] }}</strong>
          <span>按现有方式选择并加入，成功后搜索下一项；也可以跳过。</span>
        </template>
      </div>
      <div class="vl-name-queue-actions">
        <button v-if="!complete" type="button" :disabled="busy" @click="!busy && emit('skip')">跳过此项</button>
        <button type="button" :disabled="busy" @click="!busy && emit('stop')">结束名单</button>
      </div>
    </template>
    <details v-else>
      <summary>名单逐项选片</summary>
      <p>每行一个电影或剧名。自动填入搜索词，由你选择内容并加入。</p>
      <form @submit.prevent="start">
        <label>
          <span>影片名单</span>
          <textarea v-model="draft" rows="5" placeholder="电影或剧名，每行一个" :disabled="busy" />
        </label>
        <div class="vl-name-queue-actions">
          <span>{{ parsedNames.length }} 项</span>
          <button type="submit" :disabled="busy || !parsedNames.length">开始逐项选片</button>
        </div>
      </form>
    </details>
  </section>
</template>

<style scoped>
.vl-name-queue {
  margin: 16px 0;
  padding: 14px;
  border: 1px solid #2b404d;
  border-radius: 9px;
  background: #10212c;
  min-width: 0;
}
.vl-name-queue summary {
  cursor: pointer;
  font-size: 13px;
  font-weight: 650;
}
.vl-name-queue p,
.vl-name-queue span {
  color: #9eb0bd;
  font-size: 12px;
}
.vl-name-queue label,
.vl-name-queue-status {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.vl-name-queue strong {
  font-size: 14px;
  overflow-wrap: anywhere;
}
.vl-name-queue textarea {
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  resize: vertical;
  padding: 10px;
  border: 1px solid #385160;
  border-radius: 7px;
  color: #d8e4eb;
  background: #091620;
  font: inherit;
  line-height: 1.6;
}
.vl-name-queue-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}
.vl-name-queue button {
  min-height: 42px;
  padding: 9px 13px;
  border: 1px solid #385160;
  border-radius: 7px;
  background: #14232e;
  color: #d8e4eb;
  cursor: pointer;
}
.vl-name-queue button:disabled {
  opacity: 0.5;
  cursor: default;
}
.vl-name-queue textarea:focus-visible {
  outline: 2px solid #6ac173;
  outline-offset: 3px;
}
@media (max-width: 480px) {
  .vl-name-queue-actions button {
    flex: 1;
  }
}
</style>
