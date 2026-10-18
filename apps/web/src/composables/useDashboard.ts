import { ref } from "vue";

import type { DashboardSummary } from "../types";

export function useDashboard(requireAuth: () => void) {
  const summary = ref<DashboardSummary | null>(null);
  const loading = ref(false);
  const error = ref("");

  async function load(): Promise<void> {
    loading.value = true;
    error.value = "";
    try {
      const response = await fetch("/api/dashboard", { credentials: "include" });
      if (response.status === 401) {
        requireAuth();
        throw new Error("unauthorized");
      }
      if (!response.ok) throw new Error("读取失败");
      const body = (await response.json()) as { summary: DashboardSummary };
      summary.value = body.summary;
    } catch (caught) {
      if ((caught as Error).message !== "unauthorized") error.value = "无法读取数据总览";
    } finally {
      loading.value = false;
    }
  }

  return { summary, loading, error, load };
}
