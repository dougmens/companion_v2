import type { DashboardState } from "../types";
import { normalizeDashboardState } from "./ui_helpers";

export async function loadDashboardState(): Promise<DashboardState> {
  const res = await fetch("/dashboard_state.json", { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to load dashboard_state.json (HTTP ${res.status})`);
  }

  const json = await res.json();
  return normalizeDashboardState(json) as DashboardState;
}
