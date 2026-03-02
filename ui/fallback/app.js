const app = document.getElementById("app");

function toDate(value) {
  const ms = Date.parse(String(value || ""));
  if (!Number.isFinite(ms)) return "-";
  return new Date(ms).toLocaleString();
}

function jsonPretty(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function scoreTs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : -Infinity;
}

async function loadSnapshot() {
  const res = await fetch("/dashboard_state.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`dashboard_state.json unavailable (${res.status})`);
  return res.json();
}

function renderNav(route) {
  const pages = [
    ["overview", "Overview"],
    ["cases", "Cases"],
    ["events", "Events"],
    ["reports", "Reports"],
    ["intents", "Intents"],
  ];

  return `
    <nav>
      ${pages
    .map(([id, label]) => `<a href="#/${id}" class="${route === id ? "active" : ""}">${label}</a>`)
    .join("")}
    </nav>
  `;
}

function renderOverview(state) {
  const setup = state.setup_state || {};
  return `
    <section>
      <h2>Overview</h2>
      <div class="grid">
        <div class="card">
          <h3>System</h3>
          <p><strong>mode:</strong> ${String(setup.mode || "-")}</p>
          <p><strong>watcher_configured:</strong> ${String(Boolean(setup.watcher_configured))}</p>
          <p><strong>last_successful_ingest:</strong> ${toDate(setup.last_successful_ingest)}</p>
          <p><strong>reset_required_before_go_live:</strong> ${String(Boolean(setup.reset_required_before_go_live))}</p>
        </div>
        <div class="card">
          <h3>Counts</h3>
          <p><strong>generated_at:</strong> ${toDate(state.generated_at)}</p>
          <p><strong>cases:</strong> ${state.cases.length}</p>
          <p><strong>events:</strong> ${state.events.length}</p>
          <p><strong>reports:</strong> ${state.reports.length}</p>
          <p><strong>intents:</strong> ${state.intents.length}</p>
        </div>
      </div>
    </section>
  `;
}

function getCaseParam() {
  const hash = String(location.hash || "");
  const qIndex = hash.indexOf("?");
  if (qIndex < 0) return "";
  const query = new URLSearchParams(hash.slice(qIndex + 1));
  return query.get("case_id") || "";
}

function renderCases(state) {
  const caseId = getCaseParam();
  const selected = state.cases.find((c) => c.case_id === caseId) || null;

  const rows = state.cases
    .slice()
    .sort((a, b) => String(a.case_id).localeCompare(String(b.case_id)))
    .map((c) => `
      <tr>
        <td><a href="#/cases?case_id=${encodeURIComponent(c.case_id)}">${c.case_id}</a></td>
        <td>${String(c.title || "")}</td>
        <td>${Array.isArray(c.aliases) ? c.aliases.join(", ") : ""}</td>
        <td>${Array.isArray(c.tags) ? c.tags.join(", ") : ""}</td>
      </tr>
    `)
    .join("");

  let detail = "";
  if (selected) {
    const caseEvents = state.events.filter((e) => {
      if (String(e.entity_id || "") === selected.case_id) return true;
      if (String(e?.payload?.case_id || "") === selected.case_id) return true;
      return jsonPretty(e).includes(selected.case_id);
    }).slice(0, 30);

    const caseReports = state.reports.filter((r) => jsonPretty(r.content || r).includes(selected.case_id)).slice(0, 30);

    detail = `
      <div class="card">
        <h3>Case detail: ${selected.case_id}</h3>
        <p><strong>title:</strong> ${String(selected.title || "-")}</p>
        <p><strong>aliases:</strong> ${Array.isArray(selected.aliases) ? selected.aliases.join(", ") : "-"}</p>
        <p><strong>tags:</strong> ${Array.isArray(selected.tags) ? selected.tags.join(", ") : "-"}</p>

        <h4>Recent events (${caseEvents.length})</h4>
        ${caseEvents.map((event, idx) => `
          <details>
            <summary>${String(event.type || "event")} · ${toDate(event.ts)} · ${idx + 1}</summary>
            <pre>${jsonPretty(event)}</pre>
          </details>
        `).join("") || '<p class="small">No related events.</p>'}

        <h4>Recent reports (${caseReports.length})</h4>
        ${caseReports.map((report, idx) => `
          <details>
            <summary>${String(report.filename || `report-${idx + 1}`)} · ${toDate(report.ts || report.mtime)}</summary>
            <pre>${jsonPretty(report.content || report)}</pre>
          </details>
        `).join("") || '<p class="small">No related reports.</p>'}
      </div>
    `;
  }

  return `
    <section>
      <h2>Cases</h2>
      <table class="table">
        <thead>
          <tr><th>case_id</th><th>title</th><th>aliases</th><th>tags</th></tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="4">No cases found.</td></tr>'}</tbody>
      </table>
      ${detail}
    </section>
  `;
}

function renderEvents(state) {
  return `
    <section>
      <h2>Events</h2>
      <div class="filters">
        <label>Type<select id="f_type"><option value="">All</option>${Array.from(new Set(state.events.map((e) => String(e.type || "")).filter(Boolean))).sort().map((v) => `<option value="${v}">${v}</option>`).join("")}</select></label>
        <label>Domain<select id="f_domain"><option value="">All</option>${Array.from(new Set(state.events.map((e) => String(e.domain || "")).filter(Boolean))).sort().map((v) => `<option value="${v}">${v}</option>`).join("")}</select></label>
        <label>Entity ID<input id="f_entity" placeholder="free text" /></label>
        <label>Limit<input id="f_limit" type="number" value="100" min="10" max="500" /></label>
      </div>
      <div id="events_list"></div>
    </section>
  `;
}

function renderReports(state) {
  const items = state.reports
    .slice()
    .sort((a, b) => scoreTs(b.ts || b.mtime) - scoreTs(a.ts || a.mtime));

  return `
    <section>
      <h2>Reports</h2>
      ${items.length === 0 ? '<p class="small">No reports found.</p>' : items.map((report, idx) => `
        <details>
          <summary>${String(report.filename || `report-${idx + 1}`)} · ${String(report.status || "unknown")} · ${toDate(report.ts || report.mtime)}</summary>
          <pre>${jsonPretty(report.content || report)}</pre>
        </details>
      `).join("")}
    </section>
  `;
}

function command(type, caseId, title, aliases, tags) {
  if (type === "SHOW_DASHBOARD") return "npm run ui:intent:new -- --type SHOW_DASHBOARD";
  const base = `npm run ui:intent:new -- --type ${type}`;
  const parts = [base];
  if (caseId) parts.push(`--case_id ${JSON.stringify(caseId)}`);
  if (title) parts.push(`--title ${JSON.stringify(title)}`);
  if (aliases) parts.push(`--aliases ${JSON.stringify(aliases)}`);
  if (tags) parts.push(`--tags ${JSON.stringify(tags)}`);
  return parts.join(" ");
}

function renderIntents(state) {
  const rows = state.intents
    .slice()
    .sort((a, b) => scoreTs(b.ts || b.mtime) - scoreTs(a.ts || a.mtime))
    .map((intent, idx) => `
      <details>
        <summary>${String(intent.filename || `intent-${idx + 1}`)} · ${String(intent.type || "-")} · ${String(intent.status || "-")} · ${toDate(intent.ts || intent.mtime)}</summary>
        <pre>${jsonPretty(intent.content || intent)}</pre>
      </details>
    `)
    .join("");

  return `
    <section>
      <h2>Intents</h2>
      <div class="card">
        <p>Generate intents via Node CLI (browser does not write files):</p>
        <div class="filters">
          <label>case_id<input id="intent_case" /></label>
          <label>title<input id="intent_title" /></label>
          <label>aliases CSV<input id="intent_aliases" /></label>
          <label>tags CSV<input id="intent_tags" /></label>
        </div>
        <p class="small">Use one of these commands in terminal, then run <code>npm run ui:export && npm run ui:sync</code> and refresh.</p>
        <pre id="intent_cmd_show"></pre>
        <pre id="intent_cmd_add"></pre>
        <pre id="intent_cmd_update"></pre>
      </div>
      ${rows || '<p class="small">No intents found.</p>'}
    </section>
  `;
}

function renderEventList(state) {
  const type = document.getElementById("f_type")?.value || "";
  const domain = document.getElementById("f_domain")?.value || "";
  const entity = (document.getElementById("f_entity")?.value || "").toLowerCase();
  const limit = Math.max(10, Math.min(500, Number(document.getElementById("f_limit")?.value || 100)));

  const filtered = state.events.filter((e) => {
    if (type && String(e.type || "") !== type) return false;
    if (domain && String(e.domain || "") !== domain) return false;
    if (entity && !String(e.entity_id || "").toLowerCase().includes(entity)) return false;
    return true;
  }).slice(0, limit);

  const host = document.getElementById("events_list");
  host.innerHTML = filtered.length === 0
    ? '<p class="small">No matching events.</p>'
    : filtered.map((event, idx) => `
      <details>
        <summary>${String(event.type || "event")} · ${String(event.domain || "-")} · ${String(event.entity_id || "-")} · ${toDate(event.ts)} · ${idx + 1}</summary>
        <pre>${jsonPretty(event)}</pre>
      </details>
    `).join("");
}

function bindIntentCommands() {
  const caseEl = document.getElementById("intent_case");
  const titleEl = document.getElementById("intent_title");
  const aliasesEl = document.getElementById("intent_aliases");
  const tagsEl = document.getElementById("intent_tags");

  const cmdShow = document.getElementById("intent_cmd_show");
  const cmdAdd = document.getElementById("intent_cmd_add");
  const cmdUpdate = document.getElementById("intent_cmd_update");

  if (!cmdShow || !cmdAdd || !cmdUpdate) return;

  const update = () => {
    const caseId = caseEl?.value || "";
    const title = titleEl?.value || "";
    const aliases = aliasesEl?.value || "";
    const tags = tagsEl?.value || "";

    cmdShow.textContent = command("SHOW_DASHBOARD", caseId, title, aliases, tags);
    cmdAdd.textContent = command("UPDATE_DASHBOARD_DATA_CASE_ADD", caseId, title, aliases, tags);
    cmdUpdate.textContent = command("UPDATE_DASHBOARD_DATA_CASE_UPDATE", caseId, title, aliases, tags);
  };

  [caseEl, titleEl, aliasesEl, tagsEl].forEach((el) => el && el.addEventListener("input", update));
  update();
}

async function render() {
  app.innerHTML = `<div class="app"><header><h1>Companion Runtime Dashboard</h1><p class="small">Loading snapshot...</p></header></div>`;
  try {
    const state = await loadSnapshot();
    const hash = String(location.hash || "#/overview").replace(/^#\/?/, "");
    const route = hash.split("?")[0] || "overview";

    let page = "";
    if (route === "cases") page = renderCases(state);
    else if (route === "events") page = renderEvents(state);
    else if (route === "reports") page = renderReports(state);
    else if (route === "intents") page = renderIntents(state);
    else page = renderOverview(state);

    app.innerHTML = `
      <div class="app">
        <header>
          <h1>Companion Runtime Dashboard</h1>
          <p class="small">generated_at: ${toDate(state.generated_at)} · cases=${state.cases.length} · events=${state.events.length} · reports=${state.reports.length} · intents=${state.intents.length}</p>
        </header>
        ${renderNav(route)}
        ${page}
      </div>
    `;

    if (route === "events") {
      ["f_type", "f_domain", "f_entity", "f_limit"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("input", () => renderEventList(state));
        if (el) el.addEventListener("change", () => renderEventList(state));
      });
      renderEventList(state);
    }

    if (route === "intents") {
      bindIntentCommands();
    }
  } catch (error) {
    app.innerHTML = `
      <div class="app">
        <section>
          <h2>Failed to load snapshot</h2>
          <p>${String(error?.message || error)}</p>
          <p>Run: <code>npm run ui:export && npm run ui:sync</code> then refresh.</p>
        </section>
      </div>
    `;
  }
}

window.addEventListener("hashchange", () => void render());
void render();
