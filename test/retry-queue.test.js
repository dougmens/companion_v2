const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { runIngestRetry, readJsonl } = require("../src/lib/ingest_retry");

async function mkTmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function appendJsonl(filePath, obj) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(obj)}\n`, "utf8");
}

function makeBaseEntry({ entryId, filename, file, attempt = 0, status = "queued" }) {
  const ts = "2026-03-02T00:00:00.000Z";
  return {
    ts,
    entry_id: entryId,
    ref: {
      entry_id: entryId,
      original_ts: ts,
      original_filename: filename,
    },
    filename,
    file,
    source_inbox_path: file,
    phase: "staging",
    status,
    attempt,
    next_retry_at: null,
    reason: "test_seed",
  };
}

test("retry queue: missing source -> dropped_missing_source", async () => {
  const root = await mkTmpDir("companion-retry-missing-");
  const retryQueuePath = path.join(root, "70_runtime", "retry_queue.jsonl");
  const retryArchivePath = path.join(root, "70_runtime", "retry_queue_archive.jsonl");

  const missingFile = path.join(root, "00_inbox", "missing.pdf");
  await appendJsonl(
    retryQueuePath,
    makeBaseEntry({ entryId: "e_missing", filename: "missing.pdf", file: missingFile, attempt: 1 }),
  );

  const res = await runIngestRetry({
    retryQueuePath,
    retryArchivePath,
    logger: { info: async () => {}, warn: async () => {}, error: async () => {} },
    loadRegistryFn: async () => ({ version: 1, cases: [] }),
  });

  assert.equal(res.results.dropped_missing_source, 1);

  const qLines = await readJsonl(retryQueuePath);
  const last = qLines[qLines.length - 1];
  assert.equal(last.status, "dropped_missing_source");
  assert.equal(last.ref.original_filename, "missing.pdf");

  const aLines = await readJsonl(retryArchivePath);
  assert.equal(aLines[aLines.length - 1].status, "dropped_missing_source");
});

test("retry queue: existing source -> resolved", async () => {
  const root = await mkTmpDir("companion-retry-resolve-");
  const retryQueuePath = path.join(root, "70_runtime", "retry_queue.jsonl");
  const retryArchivePath = path.join(root, "70_runtime", "retry_queue_archive.jsonl");
  const sourceFile = path.join(root, "00_inbox", "source.pdf");
  const stagedFile = path.join(root, "10_processed", "_staging", "pdf", "uuid__source.pdf");
  const finalFile = path.join(root, "10_processed", "juristische_faelle", "strafrecht", "Case_X", "pdf", "target.pdf");

  await fs.mkdir(path.dirname(sourceFile), { recursive: true });
  await fs.writeFile(sourceFile, "%PDF-1.4\n", "utf8");
  await appendJsonl(
    retryQueuePath,
    makeBaseEntry({ entryId: "e_resolve", filename: "source.pdf", file: sourceFile, attempt: 0 }),
  );

  let stageCalls = 0;
  let processCalls = 0;

  const res = await runIngestRetry({
    retryQueuePath,
    retryArchivePath,
    logger: { info: async () => {}, warn: async () => {}, error: async () => {} },
    loadRegistryFn: async () => ({ version: 1, cases: [] }),
    acquireLockFn: async () => ({ acquired: true, release: async () => {} }),
    stageInboxFileFn: async (file) => {
      stageCalls += 1;
      assert.equal(file, sourceFile);
      return { ok: true, stagedPath: stagedFile, stage_attempt: 1 };
    },
    processPdfFn: async (pdfPath) => {
      processCalls += 1;
      assert.equal(pdfPath, stagedFile);
      return { status: "processed", pdf: finalFile, registry: { version: 1, cases: [] } };
    },
  });

  assert.equal(stageCalls, 1);
  assert.equal(processCalls, 1);
  assert.equal(res.results.resolved, 1);

  const qLines = await readJsonl(retryQueuePath);
  const last = qLines[qLines.length - 1];
  assert.equal(last.status, "resolved");
  assert.equal(last.staged_path, stagedFile);
  assert.equal(last.final_path, finalFile);
});

test("retry queue: max attempts reached -> failed", async () => {
  const root = await mkTmpDir("companion-retry-failed-");
  const retryQueuePath = path.join(root, "70_runtime", "retry_queue.jsonl");
  const retryArchivePath = path.join(root, "70_runtime", "retry_queue_archive.jsonl");
  const sourceFile = path.join(root, "00_inbox", "source.pdf");

  await fs.mkdir(path.dirname(sourceFile), { recursive: true });
  await fs.writeFile(sourceFile, "%PDF-1.4\n", "utf8");
  await appendJsonl(
    retryQueuePath,
    makeBaseEntry({ entryId: "e_failed", filename: "source.pdf", file: sourceFile, attempt: 2 }),
  );

  const res = await runIngestRetry({
    retryQueuePath,
    retryArchivePath,
    maxAttempts: 3,
    logger: { info: async () => {}, warn: async () => {}, error: async () => {} },
    loadRegistryFn: async () => ({ version: 1, cases: [] }),
    acquireLockFn: async () => ({ acquired: true, release: async () => {} }),
    stageInboxFileFn: async () => ({ ok: false, retryEligible: true, reason: "staging_stability_timeout" }),
  });

  assert.equal(res.results.failed, 1);

  const qLines = await readJsonl(retryQueuePath);
  const last = qLines[qLines.length - 1];
  assert.equal(last.status, "failed");
  assert.equal(last.attempt, 3);

  const aLines = await readJsonl(retryArchivePath);
  assert.equal(aLines[aLines.length - 1].status, "failed");
});
