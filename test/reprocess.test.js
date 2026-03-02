const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { runIngestReprocess, readJsonl } = require("../src/lib/ingest_reprocess");

async function mkTmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function noopLogger() {
  return { info: async () => {}, warn: async () => {}, error: async () => {} };
}

test("reprocess moves REVIEW_REQUIRED file into final target (mock classifier/pipeline)", async () => {
  const root = await mkTmpDir("companion-reprocess-ok-");
  const reviewDir = path.join(root, "10_processed", "allgemein", "REVIEW_REQUIRED");
  const runtimeDir = path.join(root, "70_runtime");
  const stagingDir = path.join(root, "10_processed", "_staging", "pdf");
  const source = path.join(reviewDir, "doc.pdf");
  const statusPath = path.join(runtimeDir, "reprocess_status.jsonl");
  const finalPath = path.join(root, "10_processed", "finanzen", "versicherung", "resolved.pdf");

  await fs.mkdir(reviewDir, { recursive: true });
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(source, "%PDF-1.4\n", "utf8");

  const stageSourceFn = async (sourcePath, { stagingDir: sDir }) => {
    const stagedPath = path.join(sDir, "uuid__doc.pdf");
    await fs.mkdir(path.dirname(stagedPath), { recursive: true });
    await fs.rename(sourcePath, stagedPath);
    return { ok: true, stagedPath, stage_attempt: 1 };
  };

  const processPdfFn = async (stagedPath) => {
    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.rename(stagedPath, finalPath);
    return { status: "processed", pdf: finalPath, registry: { version: 1, cases: [] } };
  };

  const res = await runIngestReprocess({
    max: 10,
    reviewDir,
    runtimeDir,
    stagingDir,
    statusPath,
    logger: noopLogger(),
    loadRegistryFn: async () => ({ version: 1, cases: [] }),
    acquireLockFn: async () => ({ acquired: true, release: async () => {} }),
    stageSourceFn,
    processPdfFn,
  });

  assert.equal(res.results.resolved, 1);
  await assert.rejects(() => fs.access(source));
  await assert.doesNotReject(() => fs.access(finalPath));

  const lines = await readJsonl(statusPath);
  const last = lines[lines.length - 1];
  assert.equal(last.status, "resolved");
  assert.equal(last.final_path, finalPath);
});

test("reprocess failure keeps file in REVIEW_REQUIRED and writes failed status with attempt", async () => {
  const root = await mkTmpDir("companion-reprocess-failed-");
  const reviewDir = path.join(root, "10_processed", "allgemein", "REVIEW_REQUIRED");
  const runtimeDir = path.join(root, "70_runtime");
  const stagingDir = path.join(root, "10_processed", "_staging", "pdf");
  const source = path.join(reviewDir, "doc.pdf");
  const statusPath = path.join(runtimeDir, "reprocess_status.jsonl");

  await fs.mkdir(reviewDir, { recursive: true });
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(source, "%PDF-1.4\n", "utf8");

  const stageSourceFn = async (sourcePath, { stagingDir: sDir }) => {
    const stagedPath = path.join(sDir, "uuid__doc.pdf");
    await fs.mkdir(path.dirname(stagedPath), { recursive: true });
    await fs.rename(sourcePath, stagedPath);
    return { ok: true, stagedPath, stage_attempt: 1 };
  };

  const processPdfFn = async () => ({
    status: "retry_eligible_move",
    retry_eligible: true,
    retry_reason: "openai_connection_error",
  });

  const res = await runIngestReprocess({
    max: 10,
    reviewDir,
    runtimeDir,
    stagingDir,
    statusPath,
    logger: noopLogger(),
    loadRegistryFn: async () => ({ version: 1, cases: [] }),
    acquireLockFn: async () => ({ acquired: true, release: async () => {} }),
    stageSourceFn,
    processPdfFn,
  });

  assert.equal(res.results.failed, 1);
  await assert.doesNotReject(() => fs.access(source));

  const lines = await readJsonl(statusPath);
  const last = lines[lines.length - 1];
  assert.equal(last.status, "failed");
  assert.equal(last.reason, "openai_connection_error");
  assert.equal(last.attempt, 1);
});
