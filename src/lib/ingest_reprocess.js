const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const { DIRS } = require("./config");
const {
  appendLine,
  ensureDir,
  isPdfFilename,
  listFiles,
  pathExists,
  safeBasename,
  statSafe,
} = require("./fsx");
const { createLogger } = require("./logger");
const { loadRegistry } = require("./registry");
const {
  acquireProcessingLock,
  moveFileIdempotent,
  processOnePdf,
  stageInboxFile,
} = require("./ingest");

function boolFlag(v) {
  return v === true || v === "true" || v === "1" || v === "yes" || v === "on";
}

function isOpenAiErrorText(s) {
  return /openai|connection\s*error|network|timeout|rate\s*limit|api\s*key/i.test(String(s || ""));
}

async function readJsonl(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function buildAttemptMap(lines) {
  const map = new Map();
  for (const line of lines) {
    const source = line?.source_file;
    const attempt = Number(line?.attempt || 0);
    if (!source) continue;
    map.set(source, Math.max(map.get(source) || 0, attempt));
  }
  return map;
}

async function hasOpenAiMarker(sourcePath, { statusLines = [] } = {}) {
  const sidecars = [
    sourcePath.replace(/\.pdf$/i, ".json"),
    sourcePath.replace(/\.pdf$/i, ".meta.json"),
  ];

  for (const sidecar of sidecars) {
    try {
      const raw = await fs.readFile(sidecar, "utf8");
      if (isOpenAiErrorText(raw)) return true;
    } catch {
      // ignore
    }
  }

  const statusHits = statusLines.filter((l) => l?.source_file === sourcePath);
  for (const hit of statusHits) {
    if (isOpenAiErrorText(hit?.reason) || isOpenAiErrorText(hit?.error)) return true;
  }

  return false;
}

async function listReprocessCandidates({
  reviewDir,
  max,
  olderThanMinutes,
  onlyOpenAiErrors,
  statusLines,
}) {
  await ensureDir(reviewDir);
  const files = (await listFiles(reviewDir)).filter((p) => isPdfFilename(p));
  const now = Date.now();
  const cutoff =
    olderThanMinutes == null
      ? null
      : now - (Number(olderThanMinutes) * 60 * 1000);

  const out = [];
  for (const file of files) {
    const st = await statSafe(file);
    if (!st) continue;
    if (cutoff != null && st.mtimeMs > cutoff) continue;

    if (onlyOpenAiErrors) {
      const marker = await hasOpenAiMarker(file, { statusLines });
      if (!marker) continue;
    }

    out.push({
      path: file,
      filename: safeBasename(file),
      mtimeMs: st.mtimeMs,
    });
  }

  out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return out.slice(0, Math.max(0, Number(max) || 0));
}

async function appendReprocessStatus(statusPath, line) {
  await ensureDir(path.dirname(statusPath));
  await appendLine(statusPath, JSON.stringify(line));
}

function makeStatusLine({
  sourceFile,
  filename,
  attempt,
  status,
  reason,
  stagedPath,
  finalPath,
}) {
  const ts = new Date().toISOString();
  const entryId = crypto
    .createHash("sha1")
    .update(`${sourceFile}|${filename}|${attempt}|${ts}`)
    .digest("hex");

  return {
    ts,
    entry_id: entryId,
    source_file: sourceFile,
    filename,
    attempt,
    status,
    reason: reason || null,
    staged_path: stagedPath || null,
    final_path: finalPath || null,
  };
}

async function restoreReviewFile({ stagedPath, reviewPath }) {
  if (!stagedPath) return { ok: false, reason: "no_staging_path" };
  if (!(await pathExists(stagedPath))) return { ok: false, reason: "staging_missing" };

  const res = await moveFileIdempotent(stagedPath, reviewPath, {
    allowUniqueOnConflict: true,
    idempotentIfDestExists: true,
    maxRetries: 1,
    retryDelayMs: 200,
  });
  return res;
}

async function runIngestReprocess({
  max = 50,
  dryRun = false,
  olderThanMinutes = null,
  onlyOpenAiErrors = false,
  reviewDir = DIRS.reviewRequired,
  runtimeDir = DIRS.runtime,
  stagingDir = DIRS.stagingPdf,
  statusPath = path.join(DIRS.runtime, "reprocess_status.jsonl"),
  logger = createLogger(),
  loadRegistryFn = loadRegistry,
  acquireLockFn = acquireProcessingLock,
  stageSourceFn = stageInboxFile,
  processPdfFn = processOnePdf,
} = {}) {
  const maxItems = Math.max(0, Number(max) || 0);
  const runDry = boolFlag(dryRun);
  const onlyOpenAi = boolFlag(onlyOpenAiErrors);
  const older = olderThanMinutes == null ? null : Number(olderThanMinutes);

  await ensureDir(reviewDir);
  await ensureDir(runtimeDir);

  const statusLines = await readJsonl(statusPath);
  const attempts = buildAttemptMap(statusLines);

  const candidates = await listReprocessCandidates({
    reviewDir,
    max: maxItems,
    olderThanMinutes: older,
    onlyOpenAiErrors: onlyOpenAi,
    statusLines,
  });

  const summary = {
    ok: true,
    selected: candidates.length,
    processed: 0,
    dry_run: runDry,
    only_openai_errors: onlyOpenAi,
    older_than_minutes: older,
    max: maxItems,
    results: {
      resolved: 0,
      failed: 0,
      skipped_locked: 0,
    },
  };

  if (runDry) {
    summary.processed = candidates.length;
    return summary;
  }

  let registry = await loadRegistryFn();

  for (const item of candidates) {
    const sourcePath = item.path;
    const filename = item.filename;
    const attempt = (attempts.get(sourcePath) || 0) + 1;
    let stagedPath = null;

    let lock = { acquired: false, release: async () => {} };
    try {
      lock = await acquireLockFn(sourcePath, {
        locksDir: path.join(runtimeDir, "locks"),
      });
      if (!lock.acquired) {
        await appendReprocessStatus(
          statusPath,
          makeStatusLine({
            sourceFile: sourcePath,
            filename,
            attempt,
            status: "failed",
            reason: "lock_exists",
            stagedPath: null,
            finalPath: null,
          }),
        );
        await logger.warn("Reprocess failed", { filename, reason: "lock_exists", attempt });
        summary.processed += 1;
        summary.results.failed += 1;
        summary.results.skipped_locked += 1;
        continue;
      }

      const staged = await stageSourceFn(sourcePath, {
        logger,
        filename,
        stagingDir,
      });
      if (!staged.ok) {
        await appendReprocessStatus(
          statusPath,
          makeStatusLine({
            sourceFile: sourcePath,
            filename,
            attempt,
            status: "failed",
            reason: staged.reason || "staging_failed",
            stagedPath: null,
            finalPath: null,
          }),
        );
        await logger.warn("Reprocess failed", {
          filename,
          reason: staged.reason || "staging_failed",
          attempt,
        });
        summary.processed += 1;
        summary.results.failed += 1;
        continue;
      }

      stagedPath = staged.stagedPath;

      const res = await processPdfFn(stagedPath, {
        registry,
        logger,
        autoCreateCase: false,
        sourceInboxPath: sourcePath,
        sourceType: "staging",
      });
      if (res?.registry) registry = res.registry;

      const success = res?.status === "processed" || res?.status === "already_moved";
      if (success) {
        await appendReprocessStatus(
          statusPath,
          makeStatusLine({
            sourceFile: sourcePath,
            filename,
            attempt,
            status: "resolved",
            reason: null,
            stagedPath,
            finalPath: res?.pdf || null,
          }),
        );
        await logger.info("Reprocess resolved", {
          filename,
          attempt,
          inbox_path: sourcePath,
          staging_path: stagedPath,
          final_path: res?.pdf || null,
        });
        summary.processed += 1;
        summary.results.resolved += 1;
        continue;
      }

      const restore = await restoreReviewFile({ stagedPath, reviewPath: sourcePath });
      const reason = res?.retry_reason || res?.status || "reprocess_failed";
      await appendReprocessStatus(
        statusPath,
        makeStatusLine({
          sourceFile: sourcePath,
          filename,
          attempt,
          status: "failed",
          reason,
          stagedPath,
          finalPath: res?.pdf || null,
        }),
      );
      await logger.warn("Reprocess failed", {
        filename,
        attempt,
        reason,
        inbox_path: sourcePath,
        staging_path: stagedPath,
        restore_reason: restore?.reason || null,
      });
      summary.processed += 1;
      summary.results.failed += 1;
    } catch (error) {
      const restore = await restoreReviewFile({ stagedPath, reviewPath: sourcePath });
      const reason = String(error?.message || error);
      await appendReprocessStatus(
        statusPath,
        makeStatusLine({
          sourceFile: sourcePath,
          filename,
          attempt,
          status: "failed",
          reason,
          stagedPath,
          finalPath: null,
        }),
      );
      await logger.warn("Reprocess failed", {
        filename,
        attempt,
        reason,
        inbox_path: sourcePath,
        staging_path: stagedPath,
        restore_reason: restore?.reason || null,
      });
      summary.processed += 1;
      summary.results.failed += 1;
    } finally {
      await lock.release();
    }
  }

  return summary;
}

module.exports = {
  runIngestReprocess,
  readJsonl,
  buildAttemptMap,
  listReprocessCandidates,
  hasOpenAiMarker,
};
