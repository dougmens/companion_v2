const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const { maybeAutoCreateJurCase } = require("../src/lib/auto_case");

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "companion-"));
}

test("jur: creates new case when sender + party + reference present", async () => {
  const tmp = await makeTempDir();
  const registryPath = path.join(tmp, "case_registry.json");
  const processedJurCasesDir = path.join(tmp, "juristische_faelle");

  const registry = { version: 1, cases: [] };
  await fs.writeFile(registryPath, JSON.stringify(registry, null, 2), "utf8");

  const classification = {
    domain: "jur",
    sender: "Kanzlei Knauer",
    doc_type: "Schreiben",
    title_suggestion: "Räumung",
    case_id: null,
    case_confidence: 0.2,
    case_tags: ["miete"],
    doc_tags: ["korrespondenz"],
  };

  const text = "Firma: HD Immobilien GmbH\nReferenz: A-12/2024\n";

  const res = await maybeAutoCreateJurCase({
    classification,
    text,
    detectedAktenzeichen: null,
    registry,
    registryPath,
    processedJurCasesDir,
  });

  assert.equal(res.action, "created");
  assert.match(res.classification.case_id, /^[A-Za-z0-9_]{1,40}$/);
  assert.ok(res.classification.case_confidence >= 0.85);

  const base = path.join(processedJurCasesDir, res.classification.case_id);
  await assert.doesNotReject(() => fs.access(path.join(base, "pdf")));
  await assert.doesNotReject(() => fs.access(path.join(base, "md")));
  await assert.doesNotReject(() => fs.access(path.join(base, "meta")));
  await assert.doesNotReject(() => fs.access(path.join(base, "evidence")));

  const saved = JSON.parse(await fs.readFile(registryPath, "utf8"));
  assert.equal(saved.cases.length, 1);
  assert.equal(saved.cases[0].case_id, res.classification.case_id);
  assert.equal(saved.cases[0].signals.sender, "Kanzlei Knauer");
  assert.ok(Array.isArray(saved.cases[0].signals.parties));
  assert.ok(Array.isArray(saved.cases[0].signals.references));
});

test("jur: no new case for generic Schreiben without hard signals", async () => {
  const tmp = await makeTempDir();
  const registryPath = path.join(tmp, "case_registry.json");
  const processedJurCasesDir = path.join(tmp, "juristische_faelle");

  const registry = { version: 1, cases: [] };
  await fs.writeFile(registryPath, JSON.stringify(registry, null, 2), "utf8");

  const classification = {
    domain: "jur",
    sender: "Unbekannt",
    doc_type: "Schreiben",
    title_suggestion: "Allgemeine Information",
    case_id: null,
    case_confidence: 0.1,
    case_tags: [],
    doc_tags: ["sonstiges"],
  };

  const text = "Sehr geehrte Damen und Herren,\nwir informieren Sie über den Stand der Dinge.\n";

  const res = await maybeAutoCreateJurCase({
    classification,
    text,
    detectedAktenzeichen: null,
    registry,
    registryPath,
    processedJurCasesDir,
  });

  assert.equal(res.action, "no_hard_signals");
  assert.equal(res.classification.case_id, null);

  const saved = JSON.parse(await fs.readFile(registryPath, "utf8"));
  assert.equal(saved.cases.length, 0);
});

