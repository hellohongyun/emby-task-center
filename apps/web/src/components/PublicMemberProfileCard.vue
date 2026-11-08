<script setup lang="ts">
import { onMounted, ref } from "vue";
import { isStaleSessionError, request } from "../composables/portal-session-state";
import type { MemberProfile, MemberProfileFields } from "../types";
import MemberProfileEditor from "./MemberProfileEditor.vue";

const endpoint = "/api/public/subscriptions/member/profile";
const profile = ref<MemberProfile>();
const loading = ref(true);
const error = ref("");

async function loadProfile() {
  loading.value = true;
  error.value = "";
  try {
    const body = await request<{ profile: MemberProfile }>(endpoint);
    profile.value = body.profile;
  } catch (caught) {
    if (!isStaleSessionError(caught)) error.value = "暂时无法读取会员资料。";
  } finally {
    loading.value = false;
  }
}

async function saveProfile(input: MemberProfileFields): Promise<MemberProfile> {
  const body = await request<{ profile: MemberProfile }>(endpoint, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  profile.value = body.profile;
  return body.profile;
}

onMounted(loadProfile);
</script>

<template>
  <section class="card" aria-label="会员资料">
    <h2 class="profile-card-title">会员资料</h2>
    <p v-if="loading" role="status">正在读取会员资料…</p>
    <div v-else-if="error" role="alert">
      <p>{{ error }}</p>
      <button type="button" @click="loadProfile">重新读取</button>
    </div>
    <MemberProfileEditor v-else-if="profile" :profile="profile" :save="saveProfile" />
  </section>
</template>

<style scoped>
.profile-card-title {
  margin: 0;
  font-size: 15px;
  font-weight: 740;
}
</style>
