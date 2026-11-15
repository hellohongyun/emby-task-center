<script setup lang="ts">
import { onMounted, ref } from "vue";
import VirtualLibrariesPage from "../views/VirtualLibrariesPage.vue";
import { usePortalSession } from "../composables/usePortalSession";
import { portalAccessError } from "../composables/portal-access";

const session = usePortalSession();
const checking = ref(true);
const bound = ref(false);
const failed = ref(false);
async function checkAccount() {
  checking.value = true;
  failed.value = false;
  const account = await session.getEmbyAccount();
  failed.value = !account;
  bound.value = !!account?.embyUserId;
  checking.value = false;
}
onMounted(checkAccount);
</script>

<template>
  <p v-if="checking" role="status">正在检查账号…</p>
  <section v-else-if="failed || !bound" class="vl-panel">
    <h1>我的私人媒体库</h1>
    <p>{{ failed ? "暂时无法读取账号，请稍后重试。" : "请联系管理员绑定 Emby 账号后使用私人媒体库。" }}</p>
    <button type="button" @click="checkAccount">重新检查</button>
  </section>
  <VirtualLibrariesPage v-else personal :require-auth="() => (portalAccessError = 'unauthorized')" />
</template>
