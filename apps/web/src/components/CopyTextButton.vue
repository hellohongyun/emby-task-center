<script setup lang="ts">
import { ref, watch } from "vue";

const props = defineProps<{ text: string; label: string }>();
const result = ref("");
watch(
  () => props.text,
  () => (result.value = ""),
);

function copyViaSelection(value: string): boolean {
  const previous = document.activeElement;
  const field = document.createElement("textarea");
  field.value = value;
  field.readOnly = true;
  field.style.position = "fixed";
  field.style.opacity = "0";
  const container = previous?.closest("dialog[open]") ?? document.body;
  container.append(field);
  field.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
    if (previous instanceof HTMLElement) previous.focus();
  }
}

async function copy() {
  const value = props.text;
  let copied = false;
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(value);
      copied = true;
    }
  } catch {
    // 部署在局域网 HTTP 时仍可尝试使用选区复制。
  }
  if (!copied) copied = copyViaSelection(value);
  if (props.text === value) result.value = copied ? "已复制" : "复制失败，请手动复制";
}
</script>

<template>
  <button type="button" :aria-label="label" @click="copy">
    <span aria-live="polite">{{ result || label }}</span>
  </button>
</template>
