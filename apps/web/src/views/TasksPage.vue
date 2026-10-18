<script setup lang="ts">
import { useAppServices } from "../state/app-services";
import TaskTrackingBoard from "../components/TaskTrackingBoard.vue";

/** 任务视图 = 任务看板（监控 + 新建入库任务）。 */
const services = useAppServices();
const { tasks, loading, error, demoMode, load, createTask, rebindTaskTmdb, deleteTask } = services.tasks;
</script>

<template>
  <div v-if="error" :class="['demo-banner', { 'service-error': !demoMode }]" role="status">
    <strong>{{ demoMode ? "演示数据" : "服务异常" }}</strong
    ><span>{{ error }}</span
    ><button type="button" @click="load()">重新连接</button>
  </div>
  <TaskTrackingBoard
    :tasks="tasks"
    :loading="loading"
    :create-task="createTask"
    :rebind-task="rebindTaskTmdb"
    :delete-task="deleteTask"
    :require-auth="services.requireAuth"
    @refresh="load()"
  />
</template>
