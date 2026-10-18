import { inject, provide, type InjectionKey, type Ref } from "vue";

import type { useIntegrations } from "../composables/useIntegrations";
import type { useLibrary } from "../composables/useLibrary";
import type { useSystem } from "../composables/useSystem";
import type { useTasks } from "../composables/useTasks";
import type { AppView } from "../types";

/**
 * 管理端共享服务（P4）。
 *
 * 之前这些 composable 都挂在 App.vue/AdminShell 上，视图只能靠 props 拿到数据，
 * 因此没法变成真正的路由组件。现在由 AdminShell 创建并 provide，各路由页面 inject，
 * 数据源仍然只有一份（不是全局单例，测试里可以注入替身）。
 */
export interface AppUiState {
  query: Ref<string>;
  authChecking: Ref<boolean>;
  authRequired: Ref<boolean>;
  lockChecking: Ref<boolean>;
  lockRemaining: Ref<number>;
  goToView(view: AppView): void;
  handleLogout(): Promise<void>;
  handleLockExpired(): void;
}

export interface AppServices {
  tasks: ReturnType<typeof useTasks>;
  library: ReturnType<typeof useLibrary>;
  system: ReturnType<typeof useSystem>;
  integrations: ReturnType<typeof useIntegrations>;
  requireAuth: () => void;
  ui: AppUiState;
}

/** 注入键（导出供测试直接 provide，路由页面本身仍走 provideAppServices/useAppServices）。 */
export const APP_SERVICES: InjectionKey<AppServices> = Symbol("emby-task-center.app-services");

export function provideAppServices(services: AppServices): void {
  provide(APP_SERVICES, services);
}

export function useAppServices(): AppServices {
  const services = inject(APP_SERVICES);
  if (!services) throw new Error("AppServices 未提供：路由页面必须在 AdminShell 内渲染。");
  return services;
}
