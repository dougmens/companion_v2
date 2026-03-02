import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App";
import { loadDashboardState } from "./lib/loadDashboardState";
import type { DashboardState } from "./types";
import "./styles.css";

const EMPTY_STATE: DashboardState = {
  generated_at: null,
  setup_state: {},
  cases: [],
  events: [],
  reports: [],
  intents: [],
};

function Root() {
  const [state, setState] = useState<DashboardState>(EMPTY_STATE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await loadDashboardState();
      setState(next);
      setError(null);
    } catch (err) {
      setError(String((err as Error)?.message || err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <BrowserRouter>
      <App state={state} loading={loading} error={error} onRefresh={refresh} />
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
