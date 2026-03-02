const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const {
  buildDashboardState,
  buildPaths,
  calculateUrgencyFromReport,
  exportDashboardState,
  jaccardSimilarity,
  readEventsWithErrors,
} = require("../src/export/dashboard_export");

async function mkTmpRoot(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeJson(filePath, obj) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

async function setupFixture(root) {
  await writeJson(path.join(root, "docs", "ACTIVE", "SETUP_STATE.json"), {
    mode: "staged",
    watcher_configured: false,
    last_successful_ingest: null,
    reset_required_before_go_live: true,
  });

  await writeJson(path.join(root, "case_registry.json"), {
    version: 1,
    cases: [{ case_id: "Unterhalt_Schoenlein", title: "Unterhalt", tags: ["familienrecht", "unterhalt"] }],
  });

  await fs.mkdir(path.join(root, "00_inbox"), { recursive: true });
  await fs.mkdir(path.join(root, "10_processed", "juristische_faelle", "familienrecht", "Unterhalt_Schoenlein", "pdf"), { recursive: true });
  await fs.mkdir(path.join(root, "50_events"), { recursive: true });
  await fs.mkdir(path.join(root, "60_intents"), { recursive: true });
  await fs.mkdir(path.join(root, "70_runtime", "reports"), { recursive: true });
  await fs.mkdir(path.join(root, "80_export"), { recursive: true });

  await fs.writeFile(path.join(root, "10_processed", "juristische_faelle", "familienrecht", "Unterhalt_Schoenlein", "pdf", "a.pdf"), "%PDF-1.4\n", "utf8");
  await fs.writeFile(path.join(root, "00_inbox", "queued.pdf"), "%PDF-1.4\n", "utf8");
}

test("dashboard export parses JSONL robustly and keeps newest events first", async () => {
  const root = await mkTmpRoot("companion-dashboard-export-");
  await setupFixture(root);

  const eventsFile = path.join(root, "50_events", "2026-03-02.jsonl");
  await fs.writeFile(eventsFile, [
    '{"id":"e1","ts":"2026-03-02T10:00:00.000Z","type":"intent.v2.processed"}',
    "",
    "this is not json",
    '{"id":"e2","type":"legacy_no_ts"}',
    '{"id":"e3","ts":"2026-03-02T11:00:00.000Z","type":"intent.v2.rejected"}',
    "",
  ].join("\n"), "utf8");

  await writeJson(path.join(root, "60_intents", "i1.json"), {
    schema: "companion-json-v2",
    id: "i1",
    ts: "2026-03-02T12:00:00.000Z",
    type: "SHOW_DASHBOARD",
    status: "new",
  });

  await writeJson(path.join(root, "70_runtime", "reports", "r1.json"), {
    intent_id: "i1",
    ts: "2026-03-02T12:01:00.000Z",
    status: "applied",
    warnings: [],
    errors: [],
  });

  const result = await exportDashboardState({ root });
  assert.equal(result.ok, true);
  assert.equal(result.counts.event_parse_errors, 1);

  const outputFile = path.join(root, "80_export", "dashboard_state.json");
  const raw = await fs.readFile(outputFile, "utf8");
  const data = JSON.parse(raw);

  assert.equal(Array.isArray(data.events), true);
  assert.equal(data.events.length, 3);
  assert.equal(data.events[0].id, "e3");
  assert.equal(data.events[1].id, "e1");
  assert.equal(data.events[2].id, "e2");
  assert.equal(Array.isArray(data.event_parse_errors), true);
  assert.equal(data.event_parse_errors.length, 1);
  assert.equal(data.inbox.count, 1);
  assert.equal(typeof data.documents.tree, "object");
});

test("dashboard reports sort by ts desc with mtime fallback", async () => {
  const root = await mkTmpRoot("companion-dashboard-export-sort-");
  await setupFixture(root);

  const r1 = path.join(root, "70_runtime", "reports", "report_a.json");
  const r2 = path.join(root, "70_runtime", "reports", "report_b.json");

  await writeJson(r1, {
    intent_id: "a",
    ts: "2026-03-02T08:00:00.000Z",
    status: "applied",
    warnings: [],
    errors: [],
  });

  await writeJson(r2, {
    intent_id: "b",
    status: "applied",
    warnings: [],
    errors: [],
  });

  const future = new Date("2026-03-03T00:00:00.000Z");
  await fs.utimes(r2, future, future);

  const state = await buildDashboardState({ root });
  assert.equal(state.reports.length, 2);
  assert.equal(state.reports[0].filename, "report_b.json");
  assert.equal(state.reports[1].filename, "report_a.json");
});

test("dashboard events are limited to last 500 by ts desc", async () => {
  const root = await mkTmpRoot("companion-dashboard-export-limit-");
  await setupFixture(root);

  const lines = [];
  for (let i = 0; i < 520; i += 1) {
    const ts = new Date(Date.UTC(2026, 2, 1, 0, 0, i)).toISOString();
    lines.push(JSON.stringify({ id: `e${i}`, ts, type: "test.event" }));
  }
  await fs.writeFile(path.join(root, "50_events", "events.jsonl"), `${lines.join("\n")}\n`, "utf8");

  const paths = buildPaths(root);
  const { events, parse_errors } = await readEventsWithErrors(paths, { maxEvents: 500 });
  assert.equal(parse_errors.length, 0);
  assert.equal(events.length, 500);
  assert.equal(events[0].id, "e519");
  assert.equal(events[499].id, "e20");
});

test("urgency calculation and jaccard similarity helpers", () => {
  assert.equal(calculateUrgencyFromReport({ error_count: 1, warning_count: 5 }), "urgent");
  assert.equal(calculateUrgencyFromReport({ error_count: 0, warning_count: 2 }), "attention");
  assert.equal(calculateUrgencyFromReport({ error_count: 0, warning_count: 0 }), "ok");

  const score = jaccardSimilarity(["a", "b", "c"], ["b", "c", "d"]);
  assert.equal(Number(score.toFixed(4)), 0.5);
  assert.equal(jaccardSimilarity([], []), 0);
});

test("snapshot generation handles missing folders gracefully", async () => {
  const root = await mkTmpRoot("companion-dashboard-missing-");
  await writeJson(path.join(root, "docs", "ACTIVE", "SETUP_STATE.json"), { mode: "test" });
  await writeJson(path.join(root, "case_registry.json"), { version: 1, cases: [] });

  const state = await buildDashboardState({ root });
  assert.equal(Array.isArray(state.events), true);
  assert.equal(Array.isArray(state.reports), true);
  assert.equal(Array.isArray(state.intents), true);
  assert.equal(state.inbox.count, 0);
  assert.equal(state.documents.total, 0);
});
