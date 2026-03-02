const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const { mergeCases } = require("../src/lib/case_merge");

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "companion-"));
}

async function writeJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

test("case:merge moves files, archives registry entry, merges index", async () => {
  const tmp = await makeTempDir();
  const registryPath = path.join(tmp, "case_registry.json");
  const processedJurCasesDir = path.join(tmp, "10_processed", "juristische_faelle");
  const ragIndexDir = path.join(tmp, "40_rag_index");
  const logsDir = path.join(tmp, "90_logs");

  await writeJson(registryPath, {
    version: 1,
    cases: [
      { case_id: "Case_A", title: "A" },
      { case_id: "Case_B", title: "B" },
    ],
  });

  const fromBase = path.join(processedJurCasesDir, "Case_A");
  const toBase = path.join(processedJurCasesDir, "Case_B");
  await fs.mkdir(path.join(fromBase, "pdf"), { recursive: true });
  await fs.mkdir(path.join(fromBase, "md"), { recursive: true });
  await fs.mkdir(path.join(fromBase, "meta"), { recursive: true });
  await fs.mkdir(path.join(fromBase, "evidence"), { recursive: true });
  await fs.mkdir(path.join(toBase, "pdf"), { recursive: true });
  await fs.mkdir(path.join(toBase, "md"), { recursive: true });
  await fs.mkdir(path.join(toBase, "meta"), { recursive: true });
  await fs.mkdir(path.join(toBase, "evidence"), { recursive: true });

  await fs.writeFile(path.join(fromBase, "pdf", "a.pdf"), "pdf-a", "utf8");
  await fs.writeFile(path.join(fromBase, "md", "a.md"), "md-a", "utf8");
  await fs.writeFile(path.join(fromBase, "meta", "a.json"), "meta-a", "utf8");
  await fs.writeFile(path.join(fromBase, "evidence", "a.txt"), "ev-a", "utf8");

  const fromIndexPath = path.join(ragIndexDir, "jur", "Case_A.jsonl");
  const toIndexPath = path.join(ragIndexDir, "jur", "Case_B.jsonl");
  await fs.mkdir(path.dirname(fromIndexPath), { recursive: true });

  const dupChunkId = "a.md::1";
  await fs.writeFile(
    toIndexPath,
    `${JSON.stringify({
      chunk_id: dupChunkId,
      domain: "jur",
      case_id: "Case_B",
      source_pdf: "10_processed/juristische_faelle/Case_B/pdf/a.pdf",
      source_md: "10_processed/juristische_faelle/Case_B/md/a.md",
      text: "existing",
      embedding: [0],
    })}\n`,
    "utf8",
  );

  await fs.writeFile(
    fromIndexPath,
    `${JSON.stringify({
      chunk_id: dupChunkId,
      domain: "jur",
      case_id: "Case_A",
      source_pdf: "10_processed/juristische_faelle/Case_A/pdf/a.pdf",
      source_md: "10_processed/juristische_faelle/Case_A/md/a.md",
      text: "dup",
      embedding: [1],
    })}\n${JSON.stringify({
      chunk_id: "a.md::2",
      domain: "jur",
      case_id: "Case_A",
      source_pdf: "10_processed/juristische_faelle/Case_A/pdf/a.pdf",
      source_md: "10_processed/juristische_faelle/Case_A/md/a.md",
      text: "new",
      embedding: [2],
    })}\n`,
    "utf8",
  );

  const res = await mergeCases({
    from: "Case_A",
    to: "Case_B",
    registryPath,
    processedJurCasesDir,
    ragIndexDir,
    logsDir,
  });

  assert.equal(res.ok, true);
  assert.equal(res.from, "Case_A");
  assert.equal(res.to, "Case_B");
  assert.equal(res.moved.pdf, 1);
  assert.equal(res.moved.md, 1);
  assert.equal(res.moved.meta, 1);
  assert.equal(res.moved.evidence, 1);

  await assert.rejects(() => fs.access(path.join(fromBase, "pdf", "a.pdf")));
  await assert.doesNotReject(() => fs.access(path.join(toBase, "pdf")));
  await assert.doesNotReject(() => fs.access(path.join(toBase, "pdf", "a.pdf")));

  const saved = JSON.parse(await fs.readFile(registryPath, "utf8"));
  const fromSaved = saved.cases.find((c) => c.case_id === "Case_A");
  assert.equal(fromSaved.archived, true);
  assert.equal(fromSaved.merged_into, "Case_B");

  await assert.rejects(() => fs.access(fromIndexPath));
  const mergedLines = (await fs.readFile(toIndexPath, "utf8"))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  assert.equal(mergedLines.length, 2);
  const merged = mergedLines.map((l) => JSON.parse(l));
  const newRec = merged.find((r) => r.chunk_id === "a.md::2");
  assert.equal(newRec.case_id, "Case_B");
  assert.ok(newRec.source_md.includes("/juristische_faelle/Case_B/"));

  await assert.doesNotReject(() => fs.access(path.join(logsDir, "case_merge.log")));
});

test("case:merge supports rechtsgebiet-nested jur index paths", async () => {
  const tmp = await makeTempDir();
  const registryPath = path.join(tmp, "case_registry.json");
  const processedJurCasesDir = path.join(tmp, "10_processed", "juristische_faelle");
  const ragIndexDir = path.join(tmp, "40_rag_index");
  const logsDir = path.join(tmp, "90_logs");

  await writeJson(registryPath, {
    version: 1,
    cases: [
      { case_id: "Strafrecht_Case_A", title: "A" },
      { case_id: "Strafrecht_Case_B", title: "B" },
    ],
  });

  const fromBase = path.join(processedJurCasesDir, "strafrecht", "Strafrecht_Case_A");
  const toBase = path.join(processedJurCasesDir, "strafrecht", "Strafrecht_Case_B");
  await fs.mkdir(path.join(fromBase, "pdf"), { recursive: true });
  await fs.mkdir(path.join(fromBase, "md"), { recursive: true });
  await fs.mkdir(path.join(fromBase, "meta"), { recursive: true });
  await fs.mkdir(path.join(fromBase, "evidence"), { recursive: true });
  await fs.mkdir(path.join(toBase, "pdf"), { recursive: true });
  await fs.mkdir(path.join(toBase, "md"), { recursive: true });
  await fs.mkdir(path.join(toBase, "meta"), { recursive: true });
  await fs.mkdir(path.join(toBase, "evidence"), { recursive: true });

  await fs.writeFile(path.join(fromBase, "pdf", "a.pdf"), "pdf-a", "utf8");

  const fromIndexPath = path.join(ragIndexDir, "jur", "strafrecht", "Strafrecht_Case_A.jsonl");
  const toIndexPath = path.join(ragIndexDir, "jur", "strafrecht", "Strafrecht_Case_B.jsonl");
  await fs.mkdir(path.dirname(fromIndexPath), { recursive: true });
  await fs.writeFile(
    fromIndexPath,
    `${JSON.stringify({
      chunk_id: "a.md::1",
      domain: "jur",
      case_id: "Strafrecht_Case_A",
      source_pdf: "10_processed/juristische_faelle/strafrecht/Strafrecht_Case_A/pdf/a.pdf",
      source_md: "10_processed/juristische_faelle/strafrecht/Strafrecht_Case_A/md/a.md",
      text: "new",
      embedding: [1],
    })}\n`,
    "utf8",
  );

  const res = await mergeCases({
    from: "Strafrecht_Case_A",
    to: "Strafrecht_Case_B",
    registryPath,
    processedJurCasesDir,
    ragIndexDir,
    logsDir,
  });

  assert.equal(res.ok, true);
  await assert.rejects(() => fs.access(fromIndexPath));
  await assert.doesNotReject(() => fs.access(toIndexPath));

  const mergedLines = (await fs.readFile(toIndexPath, "utf8"))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  assert.equal(mergedLines.length, 1);
  const merged = JSON.parse(mergedLines[0]);
  assert.equal(merged.case_id, "Strafrecht_Case_B");
  assert.ok(merged.source_md.includes("/juristische_faelle/strafrecht/Strafrecht_Case_B/"));
});
