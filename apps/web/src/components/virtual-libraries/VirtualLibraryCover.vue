<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { DEFAULT_LIBRARY_POSTER_URL } from "@emby-task-center/contracts/library-poster";

const props = defineProps<{ src?: string; name: string }>();
const failed = ref(false);
const image = computed(() => (!failed.value && props.src) || DEFAULT_LIBRARY_POSTER_URL);
watch(
  () => props.src,
  () => {
    failed.value = false;
  },
);
</script>

<template>
  <img
    class="vl-cover-image"
    :src="image"
    :alt="`${name}媒体库海报`"
    loading="lazy"
    decoding="async"
    @error="failed = true"
  />
</template>

<style scoped>
.vl-cover-image {
  display: block;
  width: 100%;
  min-width: 0;
  aspect-ratio: 16 / 9;
  object-fit: contain;
  background: #101c28;
}
</style>
