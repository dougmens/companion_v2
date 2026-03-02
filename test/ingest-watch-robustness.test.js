const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  waitForStableFile,
  moveFileIdempotent,
  stageInboxFile,
  createWatchEventHandler,
} = require("../src/lib/ingest");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mkTmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function createTestLogger() {
  const entries = [];
  return {
    entries,
    info: async (message, data) => entries.push({ level: "INFO", message, data }),
    warn: async (message, data) => entries.push({ level: "WARN", message, data }),
    error: async (message, data) => entries.push({ level: "ERROR", message, data }),
  };
}

test("double trigger -> exactly one processing pass, no ENOENT error spam", async () => {
  const root = await mkTmpDir("companion-watch-dedupe-");
  const inboxDir = path.join(root, "00_inbox");
  const runtimeDir = path.join(root, "70_runtime");
  const processedDir = path.join(root, "10_processed");

  await fs.mkdir(inboxDir, { recursive: true });
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.mkdir(processedDir, { recursive: true });

  const srcFile = path.join(inboxDir, "sample.pdf");
  const dstFile = path.join(processedDir, "sample.pdf");
  await fs.writeFile(srcFile, "%PDF-1.4\nhello\n", "utf8");

  const logger = createTestLogger();
  const registryRef = { current: { version: 1, cases: [] } };

  let processCalls = 0;
  const processPdf = async (fullPath) => {
    processCalls += 1;
    await sleep(120);
    await fs.rename(fullPath, dstFile);
    return { status: "processed", registry: registryRef.current };
  };

  const handleEvent = createWatchEventHandler({
    logger,
    processPdf,
    registryRef,
    autoCreateCase: false,
    inboxDir,
    runtimeDir,
    stability: {
      stableMs: 60,
      maxWaitMs: 2_000,
      initialPollMs: 15,
      maxPollMs: 50,
    },
    maxRetries: 2,
  });

  await Promise.all([
    handleEvent("sample.pdf"),
    handleEvent("sample.pdf"),
  ]);

  assert.equal(processCalls, 1);
  await assert.doesNotReject(() => fs.access(dstFile));

  const errorLogs = logger.entries.filter((e) => e.level === "ERROR");
  assert.equal(errorLogs.length, 0);

  const enoentLogs = logger.entries.filter((e) =>
    String(e.message || "").toLowerCase().includes("enoent")
      || String(e.data?.error || "").toLowerCase().includes("enoent"),
  );
  assert.equal(enoentLogs.length, 0);
});

test("safe move: missing src + existing dst is treated as idempotent success", async () => {
  const root = await mkTmpDir("companion-watch-move-");
  const src = path.join(root, "00_inbox", "already-moved.pdf");
  const dst = path.join(root, "10_processed", "already-moved.pdf");

  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.writeFile(dst, "%PDF-1.4\n", "utf8");

  const res = await moveFileIdempotent(src, dst, {
    allowUniqueOnConflict: true,
    maxRetries: 1,
    retryDelayMs: 10,
  });

  assert.equal(res.ok, true);
  assert.equal(res.idempotent, true);
  assert.equal(res.reason, "src_missing_dst_exists");
  await assert.doesNotReject(() => fs.access(dst));
});

test("stability wait waits until size+mtime are stable (prevents half-finished copy)", async () => {
  const root = await mkTmpDir("companion-watch-stable-");
  const file = path.join(root, "large.pdf");

  await fs.writeFile(file, "A", "utf8");

  const waiting = waitForStableFile(file, {
    stableMs: 220,
    maxWaitMs: 3_000,
    initialPollMs: 20,
    maxPollMs: 80,
  });

  await sleep(80);
  await fs.appendFile(file, "BBBBBBBB", "utf8");

  await sleep(120);
  await fs.appendFile(file, "CCCCCCCC", "utf8");

  const res = await waiting;

  assert.equal(res.stable, true);
  assert.ok(res.elapsedMs >= 320, `expected >=320ms, got ${res.elapsedMs}`);
  assert.ok(res.attempts >= 3);
});

test("staging retry: inbox file disappears after stability check -> retry then stage success", async () => {
  const root = await mkTmpDir("companion-watch-stage-retry-");
  const logger = createTestLogger();
  const inboxFile = path.join(root, "00_inbox", "flaky.pdf");
  const stagingDir = path.join(root, "10_processed", "_staging", "pdf");
  await fs.mkdir(path.dirname(inboxFile), { recursive: true });
  await fs.mkdir(stagingDir, { recursive: true });
  await fs.writeFile(inboxFile, "%PDF-1.4\nx\n", "utf8");

  let moveCalls = 0;
  const fakeMove = async (_src, destPath) => {
    moveCalls += 1;
    if (moveCalls === 1) {
      return {
        ok: false,
        moved: false,
        retryEligible: true,
        reason: "src_missing_dst_missing",
        destPath,
      };
    }
    await fs.writeFile(destPath, "%PDF-1.4\nstaged\n", "utf8");
    return { ok: true, moved: true, idempotent: false, reason: null, destPath };
  };

  const fakeWaitStable = async () => ({ stable: true, attempts: 1, elapsedMs: 10 });
  const stageRes = await stageInboxFile(inboxFile, {
    logger,
    filename: "flaky.pdf",
    stagingDir,
    maxAttempts: 3,
    moveFn: fakeMove,
    waitForStableFn: fakeWaitStable,
    sleepFn: async () => {},
  });

  assert.equal(stageRes.ok, true);
  assert.equal(stageRes.stage_attempt, 2);
  assert.ok(String(stageRes.stagedPath).includes(path.join("10_processed", "_staging", "pdf")));
  const warnCount = logger.entries.filter((e) => e.level === "WARN").length;
  assert.equal(warnCount, 0);
});

test("if staging exists, pipeline processing uses staged file and never inbox path", async () => {
  const root = await mkTmpDir("companion-watch-stage-only-");
  const inboxDir = path.join(root, "00_inbox");
  const runtimeDir = path.join(root, "70_runtime");
  const stagingDir = path.join(root, "10_processed", "_staging", "pdf");
  await fs.mkdir(inboxDir, { recursive: true });
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.mkdir(stagingDir, { recursive: true });

  const inboxFile = path.join(inboxDir, "source.pdf");
  const stagedFile = path.join(stagingDir, "123__source.pdf");
  await fs.writeFile(inboxFile, "%PDF-1.4\ninbox\n", "utf8");
  await fs.writeFile(stagedFile, "%PDF-1.4\nstaged\n", "utf8");

  const logger = createTestLogger();
  const registryRef = { current: { version: 1, cases: [] } };
  const seenPaths = [];

  const processPdf = async (fullPath) => {
    seenPaths.push(fullPath);
    return { status: "processed", registry: registryRef.current };
  };

  const stageInboxFileFn = async () => ({
    ok: true,
    stagedPath: stagedFile,
    stage_attempt: 1,
  });

  const handleEvent = createWatchEventHandler({
    logger,
    processPdf,
    registryRef,
    autoCreateCase: false,
    inboxDir,
    runtimeDir,
    stagingDir,
    stageInboxFileFn,
  });

  await handleEvent("source.pdf");

  assert.equal(seenPaths.length, 1);
  assert.equal(seenPaths[0], stagedFile);
  assert.notEqual(seenPaths[0], inboxFile);
});

test("final move idempotent: dst exists => success without deleting staging source", async () => {
  const root = await mkTmpDir("companion-watch-final-idempotent-");
  const stagingSrc = path.join(root, "10_processed", "_staging", "pdf", "abc__doc.pdf");
  const finalDst = path.join(root, "10_processed", "juristische_faelle", "strafrecht", "Case_X", "pdf", "doc.pdf");

  await fs.mkdir(path.dirname(stagingSrc), { recursive: true });
  await fs.mkdir(path.dirname(finalDst), { recursive: true });
  await fs.writeFile(stagingSrc, "%PDF-1.4\nstaging\n", "utf8");
  await fs.writeFile(finalDst, "%PDF-1.4\nfinal\n", "utf8");

  const res = await moveFileIdempotent(stagingSrc, finalDst, {
    allowUniqueOnConflict: false,
    idempotentIfDestExists: true,
    maxRetries: 1,
    retryDelayMs: 10,
  });

  assert.equal(res.ok, true);
  assert.equal(res.idempotent, true);
  assert.equal(res.reason, "dst_already_exists");
  await assert.doesNotReject(() => fs.access(stagingSrc));
  await assert.doesNotReject(() => fs.access(finalDst));
});
