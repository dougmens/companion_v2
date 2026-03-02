import { useEffect, useMemo, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";

import type { CaseItem, DashboardState, DocumentItem, EventItem, ReportItem } from "./types";
import {
  buildCaseIntentCommand,
  caseCardText,
  eventBelongsToCase,
  filterEvents,
  flattenTree,
  reportBelongsToCase,
} from "./lib/ui_helpers";

type AppProps = {
  state: DashboardState;
  error: string | null;
  loading: boolean;
  onRefresh: () => Promise<void>;
};

type EventFilters = {
  type: string;
  domain: string;
  entity: string;
};

function fmtDate(value: unknown): string {
  const ms = Date.parse(String(value || ""));
  if (!Number.isFinite(ms)) return "-";
  return new Date(ms).toLocaleString();
}

function fmtSize(bytes: unknown): string {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function toJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { parse_error: "invalid_json_preview", raw };
  }
}

function scoreTs(value: unknown): number {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : -Infinity;
}

function urgencyClass(level: string | undefined) {
  if (level === "urgent") return "urgent";
  if (level === "attention") return "attention";
  return "ok";
}

function Header({ state, loading, onRefresh }: { state: DashboardState; loading: boolean; onRefresh: () => Promise<void> }) {
  return (
    <header className="app-header">
      <div>
        <h1>Companion System v2 — Local UI</h1>
        <p className="muted">
          generated_at: {fmtDate(state.generated_at)} · last_activity: {fmtDate(state.last_activity_ts)}
        </p>
      </div>
      <div className="header-right">
        <span className={`pill ${urgencyClass(state.urgency)}`}>urgency: {state.urgency || "ok"}</span>
        <span className="pill">cases: {state.cases.length}</span>
        <span className="pill">events: {state.events.length}</span>
        <span className="pill">reports: {state.reports.length}</span>
        <span className="pill">intents: {state.intents.length}</span>
        <button onClick={() => void onRefresh()} disabled={loading}>{loading ? "Refreshing..." : "Refresh Snapshot"}</button>
      </div>
    </header>
  );
}

function Navigation() {
  return (
    <nav className="app-nav">
      <NavLink to="/" end>Overview</NavLink>
      <NavLink to="/cases">Fälle</NavLink>
      <NavLink to="/documents">Dokumente</NavLink>
      <NavLink to="/inbox">Inbox</NavLink>
      <NavLink to="/chat">Chat</NavLink>
      <NavLink to="/events">Events</NavLink>
    </nav>
  );
}

function OverviewPage({ state }: { state: DashboardState }) {
  const setup = state.setup_state || {};
  return (
    <section className="page">
      <h2>Overview</h2>
      <div className="grid two">
        <article className="card">
          <h3>Setup State</h3>
          <p><strong>mode:</strong> {String(setup.mode || "-")}</p>
          <p><strong>watcher_configured:</strong> {String(Boolean(setup.watcher_configured))}</p>
          <p><strong>last_successful_ingest:</strong> {fmtDate(setup.last_successful_ingest)}</p>
          <p><strong>reset_required_before_go_live:</strong> {String(Boolean(setup.reset_required_before_go_live))}</p>
        </article>
        <article className="card">
          <h3>Runtime Snapshot</h3>
          <p><strong>inbox:</strong> {state.inbox.count}</p>
          <p><strong>documents:</strong> {state.documents.total}</p>
          <p><strong>event_parse_errors:</strong> {state.event_parse_errors?.length || 0}</p>
          <p><strong>global urgency:</strong> <span className={`pill ${urgencyClass(state.urgency)}`}>{state.urgency || "ok"}</span></p>
        </article>
      </div>
    </section>
  );
}

function CaseEditDrawer({
  open,
  onClose,
  selected,
}: {
  open: boolean;
  onClose: () => void;
  selected: CaseItem | null;
}) {
  const [caseId, setCaseId] = useState("");
  const [title, setTitle] = useState("");
  const [aliases, setAliases] = useState("");
  const [tags, setTags] = useState("");
  const [mode, setMode] = useState<"case_add" | "case_update">("case_update");

  useEffect(() => {
    if (!selected) return;
    setCaseId(String(selected.case_id || ""));
    setTitle(String(selected.title || ""));
    setAliases(Array.isArray(selected.aliases) ? selected.aliases.join(",") : "");
    setTags(Array.isArray(selected.tags) ? selected.tags.join(",") : "");
    setMode("case_update");
  }, [selected]);

  const command = buildCaseIntentCommand(mode, {
    case_id: caseId,
    title,
    aliases,
    tags,
  });

  if (!open) return null;

  return (
    <aside className="drawer">
      <div className="drawer-head">
        <h3>Case Edit (Intent only)</h3>
        <button onClick={onClose}>Close</button>
      </div>
      <label>Mode
        <select value={mode} onChange={(e) => setMode(e.target.value as "case_add" | "case_update")}> 
          <option value="case_update">case_update</option>
          <option value="case_add">case_add</option>
        </select>
      </label>
      <label>case_id
        <input value={caseId} onChange={(e) => setCaseId(e.target.value)} />
      </label>
      <label>title
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>aliases CSV
        <input value={aliases} onChange={(e) => setAliases(e.target.value)} />
      </label>
      <label>tags CSV
        <input value={tags} onChange={(e) => setTags(e.target.value)} />
      </label>
      <p className="muted">No direct writes from UI. Copy command and run in terminal:</p>
      <pre>{command}</pre>
      <button onClick={() => navigator.clipboard.writeText(command)}>Copy command</button>
      <p className="muted">Then apply via: <code>npm run intent:apply-v2 -- &lt;file&gt;</code></p>
    </aside>
  );
}

function CasesPage({ state }: { state: DashboardState }) {
  const [view, setView] = useState<"cards" | "table">("cards");
  const [showSimilarity, setShowSimilarity] = useState(false);
  const [selected, setSelected] = useState<CaseItem | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const sorted = useMemo(() => {
    return state.cases
      .slice()
      .sort((a, b) => String(a.case_id || "").localeCompare(String(b.case_id || "")));
  }, [state.cases]);

  return (
    <section className="page">
      <div className="row">
        <h2>Fälle</h2>
        <div className="row compact">
          <button onClick={() => setView("cards")} className={view === "cards" ? "active" : ""}>Cards</button>
          <button onClick={() => setView("table")} className={view === "table" ? "active" : ""}>Table</button>
          <label className="check-inline">
            <input type="checkbox" checked={showSimilarity} onChange={(e) => setShowSimilarity(e.target.checked)} />
            Similarity
          </label>
        </div>
      </div>

      {sorted.length === 0 ? <p className="muted">No cases available.</p> : null}

      {view === "cards" ? (
        <div className="card-grid">
          {sorted.map((item) => (
            <article key={item.case_id} className="card clickable" onClick={() => setSelected(item)}>
              <div className="row">
                <h3>{item.case_id}</h3>
                <span className={`pill ${urgencyClass(item.runtime?.urgency)}`}>{item.runtime?.urgency || "ok"}</span>
              </div>
              <p>{String(item.title || "-")}</p>
              <p className="muted">aliases: {Array.isArray(item.aliases) ? item.aliases.join(", ") : "-"}</p>
              <p className="muted">tags: {Array.isArray(item.tags) ? item.tags.join(", ") : "-"}</p>
              <p className="muted">{caseCardText(item)}</p>
              {showSimilarity ? (
                <div>
                  <strong>similar:</strong>
                  <ul>
                    {(item.runtime?.similarity || []).slice(0, 3).map((sim) => (
                      <li key={`${item.case_id}-${sim.case_id}`}>{sim.case_id} ({sim.score})</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <button onClick={(e) => { e.stopPropagation(); setSelected(item); setDrawerOpen(true); }}>Edit via Intent</button>
            </article>
          ))}
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>case_id</th>
              <th>title</th>
              <th>urgency</th>
              <th>last_activity</th>
              <th>actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((item) => (
              <tr key={item.case_id} onClick={() => setSelected(item)}>
                <td>{item.case_id}</td>
                <td>{String(item.title || "")}</td>
                <td><span className={`pill ${urgencyClass(item.runtime?.urgency)}`}>{item.runtime?.urgency || "ok"}</span></td>
                <td>{fmtDate(item.runtime?.last_activity_ts)}</td>
                <td><button onClick={(e) => { e.stopPropagation(); setSelected(item); setDrawerOpen(true); }}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selected ? (
        <div className="card">
          <h3>Case detail: {selected.case_id}</h3>
          <p className="muted">event_count: {selected.runtime?.event_count || 0} · report_count: {selected.runtime?.report_count || 0} · document_count: {selected.runtime?.document_count || 0}</p>
          <h4>Related Events</h4>
          {(state.events.filter((e) => eventBelongsToCase(e, selected.case_id)).slice(0, 10)).map((event, idx) => (
            <details key={`ce-${idx}`}>
              <summary>{String(event.type || "event")} · {fmtDate(event.ts)}</summary>
              <pre>{toJson(event)}</pre>
            </details>
          ))}
          <h4>Related Reports</h4>
          {(state.reports.filter((r) => reportBelongsToCase(r, selected.case_id)).slice(0, 10)).map((report) => (
            <details key={`cr-${report.filename}`}>
              <summary>{report.filename} · {report.status || "-"} · {fmtDate(report.ts || report.mtime)}</summary>
              <pre>{toJson(report.content)}</pre>
            </details>
          ))}
        </div>
      ) : null}

      <CaseEditDrawer open={drawerOpen} selected={selected} onClose={() => setDrawerOpen(false)} />
    </section>
  );
}

function DocumentPreview({ selected }: { selected: DocumentItem | null }) {
  const [textPreview, setTextPreview] = useState<string>("");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    setTextPreview("");
    setError("");

    async function run() {
      if (!selected) return;
      if (selected.kind === "markdown" || selected.kind === "json") {
        try {
          const res = await fetch(`/${selected.path}`, { cache: "no-store" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const raw = await res.text();
          if (!cancelled) setTextPreview(raw);
        } catch (err) {
          if (!cancelled) setError(String((err as Error)?.message || err));
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  if (!selected) return <p className="muted">Select a document to preview.</p>;

  return (
    <div className="card">
      <div className="row compact">
        <strong>{selected.name}</strong>
        <span className="chip">{selected.kind}</span>
      </div>
      <p className="muted">{selected.path}</p>
      <button onClick={() => navigator.clipboard.writeText(selected.path)}>Copy path</button>

      {selected.kind === "pdf" ? (
        <iframe title={selected.name} src={`/${selected.path}`} className="preview-frame" />
      ) : null}

      {(selected.kind === "markdown" || selected.kind === "json") ? (
        <pre>{error ? `Preview unavailable (${error})` : (selected.kind === "json" ? toJson(safeParseJson(textPreview || "{}")) : textPreview || "Loading...")}</pre>
      ) : null}
    </div>
  );
}

function DocumentsPage({ state }: { state: DashboardState }) {
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string>("");

  const treeEntries = useMemo(() => flattenTree(state.documents.tree), [state.documents.tree]);

  const files = useMemo(() => {
    return state.documents.files
      .filter((file) => {
        if (!query) return true;
        const needle = query.toLowerCase();
        return `${file.name} ${file.path}`.toLowerCase().includes(needle);
      })
      .slice(0, 500);
  }, [state.documents.files, query]);

  const selected = files.find((f) => f.path === selectedPath) || null;

  return (
    <section className="page">
      <h2>Dokumente</h2>
      <p className="muted">virtual tree entries: {treeEntries.length} · files: {state.documents.total}</p>
      <div className="grid two-thirds">
        <div>
          <div className="card">
            <h3>Virtual Tree</h3>
            <div className="tree-list">
              {treeEntries.slice(0, 250).map((entry, idx) => (
                <div key={`tree-${idx}`} className={`tree-row ${entry.type}`}>
                  <span>{entry.type === "dir" ? "📁" : "📄"}</span>
                  <span>{entry.path}</span>
                </div>
              ))}
              {treeEntries.length === 0 ? <p className="muted">No tree data.</p> : null}
            </div>
          </div>

          <div className="card">
            <h3>File List</h3>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter path/name" />
            <table className="table">
              <thead>
                <tr>
                  <th>name</th>
                  <th>kind</th>
                  <th>size</th>
                  <th>mtime</th>
                </tr>
              </thead>
              <tbody>
                {files.map((file) => (
                  <tr key={file.path} className={selectedPath === file.path ? "active-row" : ""} onClick={() => setSelectedPath(file.path)}>
                    <td>{file.name}</td>
                    <td>{file.kind}</td>
                    <td>{fmtSize(file.size)}</td>
                    <td>{fmtDate(file.mtime)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <DocumentPreview selected={selected} />
      </div>
    </section>
  );
}

function InboxPage({ state }: { state: DashboardState }) {
  const [caseId, setCaseId] = useState("");
  const [title, setTitle] = useState("");

  const quickCommand = buildCaseIntentCommand("case_add", {
    case_id: caseId,
    title,
  });

  return (
    <section className="page">
      <h2>Inbox</h2>
      <p className="muted">queued files: {state.inbox.count}</p>

      <div className="card">
        <h3>Queue</h3>
        {state.inbox.items.length === 0 ? <p className="muted">Inbox is empty.</p> : (
          <table className="table">
            <thead>
              <tr>
                <th>name</th>
                <th>kind</th>
                <th>size</th>
                <th>mtime</th>
                <th>path</th>
              </tr>
            </thead>
            <tbody>
              {state.inbox.items.map((item) => (
                <tr key={item.path}>
                  <td>{item.name}</td>
                  <td>{item.kind}</td>
                  <td>{fmtSize(item.size)}</td>
                  <td>{fmtDate(item.mtime)}</td>
                  <td><code>{item.path}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Quick action: create case intent command</h3>
        <div className="grid two">
          <label>case_id<input value={caseId} onChange={(e) => setCaseId(e.target.value)} /></label>
          <label>title<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        </div>
        <pre>{quickCommand}</pre>
        <button onClick={() => navigator.clipboard.writeText(quickCommand)}>Copy command</button>
      </div>
    </section>
  );
}

function ChatPage() {
  const [messages, setMessages] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const [input, setInput] = useState("");

  function send() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    setMessages((prev) => [
      ...prev,
      { role: "user", text },
      { role: "assistant", text: "Placeholder: Chat scope is local UI context only. No model call is executed." },
    ]);
  }

  return (
    <section className="page">
      <h2>Chat</h2>
      <div className="scope-banner">Scope: Current snapshot only (read-only UI placeholder)</div>
      <div className="chat-box">
        {messages.length === 0 ? <p className="muted">No messages yet.</p> : messages.map((m, idx) => (
          <div key={`msg-${idx}`} className={`chat-msg ${m.role}`}>
            <strong>{m.role === "user" ? "You" : "Companion"}:</strong> {m.text}
          </div>
        ))}
      </div>
      <div className="row compact">
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Type a message" />
        <button onClick={send}>Send</button>
      </div>
    </section>
  );
}

function EventsPage({ state }: { state: DashboardState }) {
  const [filters, setFilters] = useState<EventFilters>({ type: "", domain: "", entity: "" });

  const types = useMemo(
    () => Array.from(new Set(state.events.map((e) => String(e.type || "")).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [state.events],
  );
  const domains = useMemo(
    () => Array.from(new Set(state.events.map((e) => String(e.domain || "")).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [state.events],
  );

  const timeline = useMemo(() => {
    return filterEvents(state.events, filters)
      .slice()
      .sort((a, b) => scoreTs(b.ts) - scoreTs(a.ts))
      .slice(0, 200);
  }, [state.events, filters]);

  const reports = useMemo(() => {
    return state.reports
      .slice()
      .sort((a, b) => scoreTs(b.ts || b.mtime) - scoreTs(a.ts || a.mtime));
  }, [state.reports]);

  return (
    <section className="page">
      <h2>Events</h2>
      <div className="filters">
        <label>
          type
          <select value={filters.type} onChange={(e) => setFilters((prev) => ({ ...prev, type: e.target.value }))}>
            <option value="">all</option>
            {types.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label>
          domain
          <select value={filters.domain} onChange={(e) => setFilters((prev) => ({ ...prev, domain: e.target.value }))}>
            <option value="">all</option>
            {domains.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label>
          entity_id
          <input value={filters.entity} onChange={(e) => setFilters((prev) => ({ ...prev, entity: e.target.value }))} />
        </label>
      </div>

      <div className="grid two">
        <div className="card">
          <h3>Timeline ({timeline.length})</h3>
          {timeline.length === 0 ? <p className="muted">No matching events.</p> : timeline.map((event: EventItem, idx) => (
            <details key={`ev-${idx}`}>
              <summary>{String(event.type || "event")} · {String(event.domain || "-")} · {String(event.entity_id || "-")} · {fmtDate(event.ts)}</summary>
              <pre>{toJson(event)}</pre>
            </details>
          ))}
        </div>

        <div className="card">
          <h3>Reports ({reports.length})</h3>
          {reports.length === 0 ? <p className="muted">No reports found.</p> : reports.map((report: ReportItem) => (
            <details key={report.filename}>
              <summary>
                {report.filename} · status={report.status || "-"} · warnings={report.warning_count || 0} · errors={report.error_count || 0}
                <span className={`pill ${urgencyClass(report.urgency)}`}>{report.urgency || "ok"}</span>
              </summary>
              <pre>{toJson(report.content)}</pre>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

export function App({ state, error, loading, onRefresh }: AppProps) {
  return (
    <div className="app-shell">
      <Header state={state} loading={loading} onRefresh={onRefresh} />
      <Navigation />

      {error ? (
        <div className="card error">
          <h2>Snapshot load error</h2>
          <p>{error}</p>
          <p>Run: <code>npm run ui:export && npm run ui:sync</code> and refresh.</p>
        </div>
      ) : null}

      <Routes>
        <Route path="/" element={<OverviewPage state={state} />} />
        <Route path="/cases" element={<CasesPage state={state} />} />
        <Route path="/documents" element={<DocumentsPage state={state} />} />
        <Route path="/inbox" element={<InboxPage state={state} />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/events" element={<EventsPage state={state} />} />
      </Routes>
    </div>
  );
}
