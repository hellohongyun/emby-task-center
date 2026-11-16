<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import VirtualLibrariesPage from "../../views/VirtualLibrariesPage.vue";
import VirtualMarketView from "./VirtualMarketView.vue";
import VirtualMarketDefaults from "./VirtualMarketDefaults.vue";
import VirtualUserLibraries from "./VirtualUserLibraries.vue";
import PersonalLibraryOrder from "./PersonalLibraryOrder.vue";
import VirtualPlayerAccount from "./VirtualPlayerAccount.vue";
import { useAppServices } from "../../state/app-services";
const props = defineProps<{ personal?: boolean; requireAuth?: () => void }>();
const services = props.personal ? null : useAppServices();
const requireAuth = props.requireAuth ?? services?.requireAuth ?? (() => undefined);
const tab = ref("owned");
const dirty = ref(false);
const pendingTab = ref("");
const accountRevision = ref(0);
const navigation = ref<HTMLElement>();
function revealActiveTab() {
  const nav = navigation.value;
  const active = nav?.querySelector<HTMLElement>('[aria-pressed="true"]');
  if (!nav || !active) return;
  const box = nav.getBoundingClientRect();
  const item = active.getBoundingClientRect();
  if (item.left < box.left) nav.scrollLeft -= box.left - item.left;
  else if (item.right > box.right) nav.scrollLeft += item.right - box.right;
}
watch(tab, revealActiveTab, { flush: "post" });
onMounted(() => window.addEventListener("resize", revealActiveTab));
onBeforeUnmount(() => window.removeEventListener("resize", revealActiveTab));
const tabs = computed(() => [
  { id: "owned", name: "我的虚拟库", description: "创建、选片与上架" },
  { id: "market", name: "媒体库市场", description: "选择在播放器中显示的库" },
  { id: "order", name: "我的媒体库顺序", description: "调整自己的显示位置" },
  ...(props.personal
    ? []
    : [
        { id: "users", name: "用户库查看", description: "后台只读，不代替用户修改" },
        { id: "defaults", name: "新用户默认设置", description: "只影响以后注册的用户" },
      ]),
]);
function selectTab(id: string) {
  if (id === tab.value) return;
  if (dirty.value) {
    pendingTab.value = id;
    return;
  }
  tab.value = id;
}
function discard() {
  dirty.value = false;
  tab.value = pendingTab.value;
  pendingTab.value = "";
}
function accountSaved() {
  dirty.value = false;
  accountRevision.value++;
}
</script>
<template>
  <div class="vm-workspace">
    <div class="vm-workspace-intro">
      <p>媒体库工作台</p>
      <span>先管理自己的库，再选择分享、订阅和显示顺序。</span>
    </div>
    <nav ref="navigation" class="vm-tabs" aria-label="虚拟媒体库功能">
      <button
        v-for="item in tabs"
        :key="item.id"
        type="button"
        :aria-label="item.name"
        :aria-pressed="tab === item.id"
        @click="selectTab(item.id)"
      >
        <strong>{{ item.name }}</strong
        ><small>{{ item.description }}</small>
      </button>
    </nav>
    <section v-if="pendingTab" class="vm-section vm-discard" role="alertdialog" aria-label="未保存的更改">
      <strong>当前页面有未保存的更改</strong>
      <p>切换页面会丢弃这些更改，已保存的设置保持不变。</p>
      <div class="vm-actions">
        <button type="button" @click="pendingTab = ''">继续编辑</button
        ><button class="vm-button-danger" type="button" @click="discard">放弃更改并切换</button>
      </div>
    </section>
    <VirtualPlayerAccount
      v-if="!personal && tab !== 'users'"
      :require-auth="requireAuth"
      :pending-changes="dirty"
      @saved="accountSaved"
    />
    <VirtualLibrariesPage
      v-if="tab === 'owned'"
      :key="`owned-${accountRevision}`"
      :personal="personal"
      :require-auth="requireAuth"
      @dirty-change="dirty = $event"
    />
    <VirtualMarketView
      v-else-if="tab === 'market'"
      :key="`market-${accountRevision}`"
      :personal="personal"
      :require-auth="requireAuth"
    />
    <PersonalLibraryOrder
      v-else-if="tab === 'order'"
      :key="`order-${accountRevision}`"
      :personal="personal"
      :require-auth="requireAuth"
      @dirty-change="dirty = $event"
    />
    <VirtualUserLibraries v-else-if="tab === 'users' && !personal" :require-auth="requireAuth" />
    <VirtualMarketDefaults
      v-else-if="tab === 'defaults' && !personal"
      :require-auth="requireAuth"
      @dirty-change="dirty = $event"
    />
  </div>
</template>
<style src="./virtual-market.css"></style>
<style src="./virtual-market-workspace.css"></style>
