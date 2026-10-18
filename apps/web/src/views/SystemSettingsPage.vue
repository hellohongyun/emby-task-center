<script setup lang="ts">
import { onBeforeUnmount } from "vue";
import { useAppServices } from "../state/app-services";
import ContentMailSettings from "../components/ContentMailSettings.vue";
import SettingsCenterView from "../components/SettingsCenterView.vue";
import SettingsView from "../components/SettingsView.vue";

/**
 * 系统设置（原「系统配置」+「外部集成」合并）。
 *
 * 两页原本是同一批东西的两个入口：外部集成页放 Emby/邮件的连接状态与自检、并发面板、
 * 全局收件人；系统配置页放注册表里的键值设置（其中就包括 emby.* / email.* / concurrency）。
 * 现在一页三段：连接与自检 → 公告/平台说明/邮件偏好 → 配置项。
 * （「全局收件人」那一块随任务更新通知整条链删除，2026-09：那条邮件链已无发送方。）
 * （「公告与邮件偏好」原先是「会员与运营 → 运营设置」里的几块，随那一段一起搬过来。）
 */
const services = useAppServices();
onBeforeUnmount(() => services.integrations.cancel());
</script>

<template>
  <div class="system-settings">
    <header class="page-head">
      <div>
        <h1>系统设置</h1>
        <p>连接自检与全部配置项：所有配置都存在数据库里，密钥只显示掩码，留空表示保持原值。</p>
      </div>
    </header>
    <SettingsView
      :require-auth="services.requireAuth"
      :status="services.integrations.status.value"
      :loading="services.integrations.loading.value"
      :error="services.integrations.error.value"
      :test-emby="services.integrations.testEmby"
      :test-email="services.integrations.testEmail"
      @refresh="services.integrations.load"
    />
    <ContentMailSettings :require-auth="services.requireAuth" />
    <SettingsCenterView :require-auth="services.requireAuth" @saved="services.integrations.load" />
  </div>
</template>

<style scoped>
.system-settings {
  padding: 0 0 32px;
}
.page-head {
  padding: 22px 22px 0;
  max-width: 1180px;
  margin: 0 auto;
}
.page-head h1 {
  margin: 0 0 6px;
  color: var(--text);
  font-size: 23px;
  font-weight: 760;
}
.page-head p {
  margin: 0;
  color: var(--text-dim);
  font-size: 13px;
}
</style>
