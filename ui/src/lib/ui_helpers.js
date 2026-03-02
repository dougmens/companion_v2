export function normalizeDashboardState(input) {
  const src = input && typeof input === "object" ? input : {};
  const setup = src.setup_state && typeof src.setup_state === "object" ? src.setup_state : {};
  const inbox = src.inbox && typeof src.inbox === "object" ? src.inbox : {};
  const documents = src.documents && typeof src.documents === "object" ? src.documents : {};

  return {
    generated_at: src.generated_at || null,
    setup_state: setup,
    last_activity_ts: src.last_activity_ts || null,
    urgency: src.urgency || "ok",
    cases: Array.isArray(src.cases) ? src.cases : [],
    events: Array.isArray(src.events) ? src.events : [],
    reports: Array.isArray(src.reports) ? src.reports : [],
    intents: Array.isArray(src.intents) ? src.intents : [],
    inbox: {
      count: Number(inbox.count || 0),
      items: Array.isArray(inbox.items) ? inbox.items : [],
    },
    documents: {
      total: Number(documents.total || 0),
      capped: Number(documents.capped || 0),
      tree: documents.tree && typeof documents.tree === "object" ? documents.tree : { name: "10_processed", children: {}, files: [] },
      files: Array.isArray(documents.files) ? documents.files : [],
    },
    event_parse_errors: Array.isArray(src.event_parse_errors) ? src.event_parse_errors : [],
  };
}

export function filterEvents(events, filters) {
  const source = Array.isArray(events) ? events : [];
  const type = String(filters?.type || "");
  const domain = String(filters?.domain || "");
  const entity = String(filters?.entity || "").toLowerCase();

  return source.filter((event) => {
    if (type && String(event?.type || "") !== type) return false;
    if (domain && String(event?.domain || "") !== domain) return false;
    if (entity && !String(event?.entity_id || "").toLowerCase().includes(entity)) return false;
    return true;
  });
}

export function caseCardText(caseItem) {
  const item = caseItem && typeof caseItem === "object" ? caseItem : {};
  const caseId = String(item.case_id || "-");
  const title = String(item.title || "-");
  const urgency = String(item?.runtime?.urgency || "ok");
  return `${caseId} | ${title} | ${urgency}`;
}

export function buildCaseIntentCommand(action, params) {
  const act = String(action || "").toLowerCase();
  const base = "npm run ui:intent:new --";

  if (act === "show_dashboard") {
    return `${base} --type show_dashboard`;
  }

  const type = act === "case_add" ? "case_add" : "case_update";
  const chunks = [`${base} --type ${type}`];
  if (params?.case_id) chunks.push(`--case_id ${JSON.stringify(params.case_id)}`);
  if (params?.title) chunks.push(`--title ${JSON.stringify(params.title)}`);
  if (params?.aliases) chunks.push(`--aliases ${JSON.stringify(params.aliases)}`);
  if (params?.tags) chunks.push(`--tags ${JSON.stringify(params.tags)}`);
  return chunks.join(" ");
}

export function reportBelongsToCase(report, caseId) {
  const id = String(caseId || "");
  if (!id) return false;
  const blob = JSON.stringify(report?.content || report || {});
  return blob.includes(id);
}

export function eventBelongsToCase(event, caseId) {
  const id = String(caseId || "");
  if (!id) return false;
  if (String(event?.entity_id || "") === id) return true;
  if (String(event?.payload?.case_id || "") === id) return true;
  return JSON.stringify(event || {}).includes(id);
}

export function flattenTree(tree, prefix = "") {
  const out = [];
  if (!tree || typeof tree !== "object") return out;

  const children = tree.children && typeof tree.children === "object" ? tree.children : {};
  const childNames = Object.keys(children).sort((a, b) => a.localeCompare(b));

  for (const name of childNames) {
    const next = children[name];
    const full = prefix ? `${prefix}/${name}` : name;
    out.push({
      type: "dir",
      name,
      path: full,
    });
    out.push(...flattenTree(next, full));
  }

  const files = Array.isArray(tree.files) ? tree.files : [];
  for (const file of files) {
    out.push({
      type: "file",
      name: String(file.name || ""),
      path: String(file.path || ""),
      kind: String(file.kind || "other"),
    });
  }

  return out;
}
