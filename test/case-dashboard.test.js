const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const CLI_PATH = path.join(__dirname, "..", "src", "cli.js");

async function mkTmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "companion-dashboard-"));
}

async function writeJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
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

test("case dashboard contains all cases with correct document counts", async () => {
  const root = await mkTmpRoot();

  await writeJson(path.join(root, "case_registry.json"), {
    version: 1,
    cases: [
      { case_id: "Strafrecht_Strafanzeigen_Schoenlein", title: "A" },
      { case_id: "Familienrecht_Unterhalt_Schoenlein", title: "B" },
      { case_id: "Prora_Immobilienkauf", title: "C" },
    ],
  });

  await writeJson(
    path.join(
      root,
      "10_processed",
      "juristische_faelle",
      "strafrecht",
      "Strafrecht_Strafanzeigen_Schoenlein",
      "meta",
      "doc1.json",
    ),
    {
      domain: "jur",
      routing: "jur_case",
      case_id: "Strafrecht_Strafanzeigen_Schoenlein",
      processed_at: "2026-03-02T00:00:00Z",
    },
  );
  await writeJson(
    path.join(
      root,
      "10_processed",
      "juristische_faelle",
      "strafrecht",
      "Strafrecht_Strafanzeigen_Schoenlein",
      "meta",
      "doc2.json",
    ),
    {
      domain: "jur",
      routing: "jur_case",
      case_id: "Strafrecht_Strafanzeigen_Schoenlein",
      processed_at: "2026-03-02T01:00:00Z",
    },
  );
  await writeJson(path.join(root, "30_metadata", "fin_doc.json"), {
    domain: "fin",
    routing: "finanzen",
    case_id: "Familienrecht_Unterhalt_Schoenlein",
    processed_at: "2026-03-02T02:00:00Z",
  });
  await writeJson(
    path.join(
      root,
      "10_processed",
      "juristische_faelle",
      "UNASSIGNED",
      "meta",
      "unassigned.json",
    ),
    {
      domain: "jur",
      routing: "jur_unassigned",
      case_id: null,
      processed_at: "2026-03-02T03:00:00Z",
    },
  );

  await fs.mkdir(path.join(root, "90_logs"), { recursive: true });
  await fs.writeFile(
    path.join(root, "90_logs", "runtime.log"),
    `${JSON.stringify({ ts: "2026-03-02T01:00:00Z", errors: 2 })}\n${JSON.stringify({ ts: "2026-03-02T01:30:00Z", status: "error" })}\n`,
    "utf8",
  );

  const res = await runCli(["case:dashboard"], { cwd: root });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout);
  assert.equal(out.exportPath, "80_export/case_dashboard.json");

  const exported = JSON.parse(
    await fs.readFile(path.join(root, "80_export", "case_dashboard.json"), "utf8"),
  );

  const byId = new Map(exported.cases.map((c) => [c.case_id, c.document_count]));
  assert.equal(byId.get("Strafrecht_Strafanzeigen_Schoenlein"), 2);
  assert.equal(byId.get("Familienrecht_Unterhalt_Schoenlein"), 1);
  assert.equal(byId.get("Prora_Immobilienkauf"), 0);

  assert.equal(exported.unassigned.document_count, 1);
  assert.equal(exported.runtime.errors, 3);
});
