const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const CLI_PATH = path.join(__dirname, "..", "src", "cli.js");

async function mkTmpRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "companion-runtime-"));
  return dir;
}

async function writeJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

async function listFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => path.join(dir, e.name));
}

async function writeJurCaseDoc({
  root,
  caseId,
  filename,
  body = "jur content",
}) {
  const legalArea = String(caseId).split("_")[0].toLowerCase();
  const base = path.join(
    root,
    "10_processed",
    "juristische_faelle",
    legalArea,
    caseId,
  );
  await fs.mkdir(path.join(base, "pdf"), { recursive: true });
  await fs.mkdir(path.join(base, "md"), { recursive: true });
  await fs.mkdir(path.join(base, "meta"), { recursive: true });

  const pdfRel = path.join(
    "10_processed",
    "juristische_faelle",
    legalArea,
    caseId,
    "pdf",
    `${filename}.pdf`,
  ).replaceAll(path.sep, "/");
  const mdRel = path.join(
    "10_processed",
    "juristische_faelle",
    legalArea,
    caseId,
    "md",
    `${filename}.md`,
  ).replaceAll(path.sep, "/");
  const metaPath = path.join(base, "meta", `${filename}.json`);

  await fs.writeFile(path.join(root, pdfRel), "%PDF-1.4\n", "utf8");
  await fs.writeFile(path.join(root, mdRel), `---\ndomain: "jur"\n---\n\n${body}\n`, "utf8");
  await writeJson(metaPath, {
    domain: "jur",
    routing: "jur_case",
    case_id: caseId,
    source_pdf: pdfRel,
    source_md: mdRel,
  });
}

function runCli(args, { cwd }) {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, [CLI_PATH, ...args], { cwd });
    let stdout = "";
    let stderr = "";
    cp.stdout.on("data", (d) => { stdout += String(d); });
    cp.stderr.on("data", (d) => { stderr += String(d); });
    cp.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("intent:apply validates and produces an event + registry update", async () => {
  const root = await mkTmpRoot();
  await fs.mkdir(path.join(root, "50_events"), { recursive: true });
  await fs.mkdir(path.join(root, "60_intents"), { recursive: true });

  await writeJson(path.join(root, "case_registry.json"), { version: 1, cases: [] });

  const intentPath = path.join(root, "60_intents", "intent1.json");
  await writeJson(intentPath, {
    id: "intent_test_1",
    ts: "2026-02-24T00:00:00Z",
    action: "case:add",
    params: { case_id: "Case_X", title: "Case X", aliases: ["x"], tags: ["t1"] },
    source: "test",
    status: "new",
  });

  const res = await runCli(["intent:apply", intentPath], { cwd: root });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}`);

  const reg = JSON.parse(await fs.readFile(path.join(root, "case_registry.json"), "utf8"));
  assert.equal(reg.cases.length, 1);
  assert.equal(reg.cases[0].case_id, "Case_X");

  const eventFiles = (await listFiles(path.join(root, "50_events"))).filter((p) =>
    p.endsWith(".jsonl"),
  );
  assert.ok(eventFiles.length >= 1);

  const lines = (await fs.readFile(eventFiles[0], "utf8")).trim().split("\n");
  const ev = JSON.parse(lines[lines.length - 1]);
  assert.equal(ev.type, "intent.applied");
  assert.equal(ev.payload.action, "case:add");
  assert.equal(ev.payload.result.added, "Case_X");
});

test("intent:apply-v2 maps companion-json-v2 and writes a deterministic report", async () => {
  const root = await mkTmpRoot();
  await writeJson(path.join(root, "case_registry.json"), { version: 1, cases: [] });

  const intentId = "intent_v2_test_1";
  const intentPath = path.join(root, "intent_v2_1.json");
  await writeJson(intentPath, {
    schema: "companion-json-v2",
    id: intentId,
    ts: "2026-02-24T00:00:00Z",
    type: "UPDATE_DASHBOARD_DATA",
    payload: {
      registry_case_add: {
        case_id: "Case_V2",
        title: "Case V2",
        aliases: ["v2"],
        tags: ["t2"],
      },
    },
    source: "chatgpt",
    status: "new",
  });

  const res = await runCli(["intent:apply-v2", intentPath], { cwd: root });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}`);

  const reg = JSON.parse(await fs.readFile(path.join(root, "case_registry.json"), "utf8"));
  assert.equal(reg.cases.length, 1);
  assert.equal(reg.cases[0].case_id, "Case_V2");

  const eventFiles = (await listFiles(path.join(root, "50_events"))).filter((p) =>
    p.endsWith(".jsonl"),
  );
  assert.ok(eventFiles.length >= 1);

  const allLines = (await fs.readFile(eventFiles[0], "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const hasV2Processed = allLines.some((e) => e.type === "intent.v2.processed");
  const hasApplied = allLines.some((e) => e.type === "intent.applied");
  assert.equal(hasV2Processed, true);
  assert.equal(hasApplied, true);

  const reportPath = path.join(root, "70_runtime", "reports", `${intentId}.json`);
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  assert.equal(report.intent_id, intentId);
  assert.equal(report.status, "applied");
  assert.ok(Array.isArray(report.events_written));
  assert.ok(report.events_written.length >= 1);
});

test("intent:apply-v2 rejects unsupported actions (event + report)", async () => {
  const root = await mkTmpRoot();
  await writeJson(path.join(root, "case_registry.json"), { version: 1, cases: [] });

  const intentId = "intent_v2_reject_1";
  const intentPath = path.join(root, "intent_v2_reject.json");
  await writeJson(intentPath, {
    schema: "companion-json-v2",
    id: intentId,
    ts: "2026-02-24T00:00:00Z",
    type: "DELETE_EVERYTHING",
    payload: {},
    source: "chatgpt",
  });

  const res = await runCli(["intent:apply-v2", intentPath], { cwd: root });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}`);

  const eventFiles = (await listFiles(path.join(root, "50_events"))).filter((p) =>
    p.endsWith(".jsonl"),
  );
  assert.ok(eventFiles.length >= 1);

  const allLines = (await fs.readFile(eventFiles[0], "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const hasRejected = allLines.some((e) => e.type === "intent.v2.rejected");
  assert.equal(hasRejected, true);

  const reportPath = path.join(root, "70_runtime", "reports", `${intentId}.json`);
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  assert.equal(report.status, "rejected");
  assert.ok(Array.isArray(report.errors));
  assert.ok(report.errors.join("\n").includes("Unsupported v2 type"));
});

test("events:tail returns last events", async () => {
  const root = await mkTmpRoot();
  await fs.mkdir(path.join(root, "50_events"), { recursive: true });

  const today = "2026-02-24";
  const eventLog = path.join(root, "50_events", `${today}.jsonl`);
  await fs.writeFile(
    eventLog,
    `${JSON.stringify({
      id: "evt1",
      ts: "2026-02-24T00:00:00Z",
      type: "test.event",
      domain: "runtime",
      entity_id: null,
      payload: { ok: true },
      source: "test",
    })}\n`,
    "utf8",
  );

  const res = await runCli(["events:tail", "--n", "1"], { cwd: root });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}`);
  const obj = JSON.parse(res.stdout);
  assert.ok(Array.isArray(obj.events));
  assert.equal(obj.events.length, 1);
  assert.equal(obj.events[0].type, "test.event");
});

test("rag:rebuild creates a new build folder and updates CURRENT pointer", async () => {
  const root = await mkTmpRoot();

  await fs.mkdir(path.join(root, "10_processed", "finanzen"), { recursive: true });
  await fs.mkdir(path.join(root, "20_markdown"), { recursive: true });
  await fs.mkdir(path.join(root, "30_metadata"), { recursive: true });
  await fs.mkdir(path.join(root, "40_rag_index"), { recursive: true });
  await fs.mkdir(path.join(root, "docs", "ACTIVE"), { recursive: true });

  const pdfRel = "10_processed/finanzen/doc.pdf";
  const mdRel = "20_markdown/doc.md";
  const metaRel = "30_metadata/doc.json";

  await fs.writeFile(path.join(root, pdfRel), "%PDF-1.4\n", "utf8");
  await fs.writeFile(path.join(root, mdRel), "---\ndomain: \"fin\"\n---\n\nhello world\n", "utf8");
  await writeJson(path.join(root, metaRel), {
    domain: "fin",
    routing: "finanzen",
    source_pdf: pdfRel,
    source_md: mdRel,
  });

  await writeJson(path.join(root, "docs", "ACTIVE", "SETUP_STATE.json"), {
    version: "local-v1",
    mode: "test",
    watcher_configured: false,
    reset_required_before_go_live: true,
    last_successful_ingest: null,
    notes: "test",
  });

  const res = await runCli(["rag:rebuild", "--mock-embeddings"], { cwd: root });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}`);

  const currentPath = path.join(root, "40_rag_index", "CURRENT");
  const current = (await fs.readFile(currentPath, "utf8")).trim();
  assert.ok(current.startsWith("_builds/"));

  const buildRoot = path.join(root, "40_rag_index", current);
  const finIndex = path.join(buildRoot, "fin", "general.jsonl");
  const finExists = await fs
    .access(finIndex)
    .then(() => true)
    .catch(() => false);
  assert.equal(finExists, true);

  const state = JSON.parse(
    await fs.readFile(path.join(root, "docs", "ACTIVE", "SETUP_STATE.json"), "utf8"),
  );
  assert.equal(state.rag_index_current, current);
});

test("rag:rebuild --domain strafrecht creates isolated strafrecht build + CURRENT", async () => {
  const root = await mkTmpRoot();
  await fs.mkdir(path.join(root, "40_rag_index"), { recursive: true });

  await writeJurCaseDoc({
    root,
    caseId: "Strafrecht_Strafanzeigen_Schoenlein",
    filename: "straf_doc",
    body: "strafanzeige test",
  });
  await writeJurCaseDoc({
    root,
    caseId: "Familienrecht_Unterhalt_Schoenlein",
    filename: "familie_doc",
    body: "unterhalt test",
  });

  const res = await runCli(
    ["rag:rebuild", "--mock-embeddings", "--domain", "strafrecht"],
    { cwd: root },
  );
  assert.equal(res.code, 0, `stderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout);
  assert.equal(out.scope, "strafrecht");

  const domainCurrentPath = path.join(root, "40_rag_index", "strafrecht", "CURRENT");
  const domainCurrent = (await fs.readFile(domainCurrentPath, "utf8")).trim();
  assert.ok(domainCurrent.startsWith("_builds/"));

  const buildRoot = path.join(root, "40_rag_index", "strafrecht", domainCurrent);
  const strafIndex = path.join(
    buildRoot,
    "jur",
    "strafrecht",
    "Strafrecht_Strafanzeigen_Schoenlein.jsonl",
  );
  const famIndex = path.join(
    buildRoot,
    "jur",
    "familienrecht",
    "Familienrecht_Unterhalt_Schoenlein.jsonl",
  );

  await assert.doesNotReject(() => fs.access(strafIndex));
  await assert.rejects(() => fs.access(famIndex));
  await assert.rejects(() => fs.access(path.join(root, "40_rag_index", "CURRENT")));
});

test("rag:rebuild --domain familienrecht creates isolated familienrecht build + CURRENT", async () => {
  const root = await mkTmpRoot();
  await fs.mkdir(path.join(root, "40_rag_index"), { recursive: true });

  await writeJurCaseDoc({
    root,
    caseId: "Strafrecht_Strafanzeigen_Schoenlein",
    filename: "straf_doc",
    body: "strafanzeige test",
  });
  await writeJurCaseDoc({
    root,
    caseId: "Familienrecht_Unterhalt_Schoenlein",
    filename: "familie_doc",
    body: "unterhalt test",
  });

  const res = await runCli(
    ["rag:rebuild", "--mock-embeddings", "--domain", "familienrecht"],
    { cwd: root },
  );
  assert.equal(res.code, 0, `stderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout);
  assert.equal(out.scope, "familienrecht");

  const domainCurrentPath = path.join(root, "40_rag_index", "familienrecht", "CURRENT");
  const domainCurrent = (await fs.readFile(domainCurrentPath, "utf8")).trim();
  assert.ok(domainCurrent.startsWith("_builds/"));

  const buildRoot = path.join(root, "40_rag_index", "familienrecht", domainCurrent);
  const famIndex = path.join(
    buildRoot,
    "jur",
    "familienrecht",
    "Familienrecht_Unterhalt_Schoenlein.jsonl",
  );
  const strafIndex = path.join(
    buildRoot,
    "jur",
    "strafrecht",
    "Strafrecht_Strafanzeigen_Schoenlein.jsonl",
  );

  await assert.doesNotReject(() => fs.access(famIndex));
  await assert.rejects(() => fs.access(strafIndex));
});
