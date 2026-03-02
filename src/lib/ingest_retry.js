const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs/promises");

const { DIRS } = require("./config");
const { appendLine, ensureDir, pathExists, safeBasename } = require("./fsx");
const { createLogger } = require("./logger");
const { loadRegistry } = require("./registry");
const {
  acquireProcessingLock,
  computeBackoffMs,
  processOnePdf,
  stageInboxFile,
} = require("./ingest");

function toBool(v) {
  return v === true || v === "true" || v === "1" || v === "yes" || v === "on";
}

function parseIsoMs(v) {
  const ms = Date.parse(String(v || ""));
  return Number.isFinite(ms) ? ms : null;
}

function statusOf(line) {
  return String(line?.status || "queued").trim() || "queued";
}

function normalizeEntryId(line) {
  if (line?.entry_id) return String(line.entry_id);
  if (line?.ref?.entry_id) return String(line.ref.entry_id);
  const originalTs = line?.ref?.original_ts || line?.original_ts || line?.ts || "";
  const originalFilename = line?.ref?.original_filename || line?.original_filename || line?.filename || "";
  const file = line?.file || "";
  return crypto
    .createHash("sha1")
    .update(`${originalTs}|${originalFilename}|${file}`)
    .digest("hex");
}

function normalizeLine(line) {
  const entryId = normalizeEntryId(line);
  const originalTs = line?.ref?.original_ts || line?.original_ts || line?.ts || new Date().toISOString();
  const originalFilename =
    line?.ref?.original_filename || line?.original_filename || line?.filename || safeBasename(line?.file || "");

  return {
    entry_id: entryId,
    original_ts: String(originalTs),
    original_filename: String(originalFilename || "document.pdf"),
    ts: String(line?.ts || originalTs),
    status: statusOf(line),
    attempt: Number(line?.attempt || 0),
    next_retry_at: line?.next_retry_at || null,
    filename: String(line?.filename || originalFilename || "document.pdf"),
    file: line?.file || null,
    reason: line?.reason || null,
    phase: line?.phase || null,
    source_inbox_path: line?.source_inbox_path || line?.file || null,
    staged_path: line?.staged_path || null,
    final_path: line?.final_path || null,
    source_path_kind: line?.source_path_kind || null,
  };
}

async function readJsonl(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const out = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // ignore malformed lines but keep processor resilient
    }
  }
  return out;
}

function buildQueueState(lines) {
  const state = new Map();

  for (const rawLine of lines) {
    const line = normalizeLine(rawLine);
    if (!line.file) continue;

    const existing = state.get(line.entry_id);
    if (!existing) {
      state.set(line.entry_id, {
        ...line,
      });
      continue;
    }

    state.set(line.entry_id, {
      ...existing,
      ...line,
      original_ts: existing.original_ts || line.original_ts,
      original_filename: existing.original_filename || line.original_filename,
    });
  }

  return Array.from(state.values());
}

function shouldIncludeStatus(statusFilter, status) {
  if (statusFilter === "all") return status === "queued" || status === "failed";
  if (statusFilter === "failed") return status === "failed";
  return status === "queued";
}

function selectQueueEntries(entries, { max = 50, olderThanMinutes = null, status = "queued", nowMs = Date.now() } = {}) {
  const cutoffMs =
    olderThanMinutes == null
      ? null
      : nowMs - (Number(olderThanMinutes) * 60 * 1000);

  const selected = entries.filter((entry) => {
    if (!shouldIncludeStatus(status, entry.status)) return false;

    const nextRetryMs = parseIsoMs(entry.next_retry_at);
    if (nextRetryMs != null && nextRetryMs > nowMs) return false;

    if (cutoffMs != null) {
      const updatedMs = parseIsoMs(entry.ts);
      if (updatedMs == null || updatedMs > cutoffMs) return false;
    }
    return true;
  });

  selected.sort((a, b) => {
    const aMs = parseIsoMs(a.next_retry_at) ?? parseIsoMs(a.ts) ?? 0;
    const bMs = parseIsoMs(b.next_retry_at) ?? parseIsoMs(b.ts) ?? 0;
    return aMs - bMs;
  });

  return selected.slice(0, Math.max(0, Number(max) || 0));
}

async function appendQueueStatus({
  retryQueuePath,
  retryArchivePath,
  baseEntry,
  status,
  attempt,
  nextRetryAt = null,
  reason = null,
  phase = null,
  stagedPath = null,
  finalPath = null,
  sourcePathKind = null,
}) {
  const line = {
    ts: new Date().toISOString(),
    entry_id: baseEntry.entry_id,
    ref: {
      entry_id: baseEntry.entry_id,
      original_ts: baseEntry.original_ts,
      original_filename: baseEntry.original_filename,
    },
    filename: baseEntry.filename,
    file: baseEntry.file,
    source_inbox_path: baseEntry.source_inbox_path || baseEntry.file,
    staged_path: stagedPath || baseEntry.staged_path || null,
    final_path: finalPath || baseEntry.final_path || null,
    source_path_kind: sourcePathKind || baseEntry.source_path_kind || null,
    phase: phase || baseEntry.phase || "retry",
    status: String(status),
    attempt: Number(attempt || 0),
    next_retry_at: nextRetryAt,
    reason,
    trigger: "ingest:retry",
  };

  await appendLine(retryQueuePath, JSON.stringify(line));

  if (["resolved", "failed", "dropped_missing_source"].includes(line.status)) {
    await appendLine(
      retryArchivePath,
      JSON.stringify({
        ...line,
        archive_ts: new Date().toISOString(),
      }),
    );
  }

  return line;
}

async function runIngestRetry({
  max = 50,
  dryRun = false,
  olderThanMinutes = null,
  status = "queued",
  maxAttempts = 3,
  retryQueuePath = path.join(DIRS.runtime, "retry_queue.jsonl"),
  retryArchivePath = path.join(DIRS.runtime, "retry_queue_archive.jsonl"),
  stagingDir = DIRS.stagingPdf,
  logger = createLogger(),
  loadRegistryFn = loadRegistry,
  acquireLockFn = acquireProcessingLock,
  stageInboxFileFn = stageInboxFile,
  processPdfFn = processOnePdf,
  pathExistsFn = pathExists,
} = {}) {
  const normalizedStatus = ["queued", "failed", "all"].includes(String(status))
    ? String(status)
    : "queued";
  const runDry = toBool(dryRun);

  await ensureDir(path.dirname(retryQueuePath));
  await ensureDir(path.dirname(retryArchivePath));

  const lines = await readJsonl(retryQueuePath);
  const state = buildQueueState(lines);
  const selected = selectQueueEntries(state, {
    max,
    olderThanMinutes,
    status: normalizedStatus,
  });

  let registry = await loadRegistryFn();
  const summary = {
    ok: true,
    selected: selected.length,
    processed: 0,
    dry_run: runDry,
    status_filter: normalizedStatus,
    older_than_minutes: olderThanMinutes == null ? null : Number(olderThanMinutes),
    max: Number(max),
    results: {
      resolved: 0,
      dropped_missing_source: 0,
      requeued: 0,
      failed: 0,
      skipped_lock: 0,
    },
  };

  for (const entry of selected) {
    const sourceFile = entry.file;
    if (!sourceFile) continue;

    if (runDry) {
      const exists = await pathExistsFn(sourceFile);
      summary.processed += 1;
      summary.results[exists ? "requeued" : "dropped_missing_source"] += 1;
      continue;
    }

    const exists = await pathExistsFn(sourceFile);
    if (!exists) {
      await appendQueueStatus({
        retryQueuePath,
        retryArchivePath,
        baseEntry: entry,
        status: "dropped_missing_source",
        attempt: Number(entry.attempt || 0),
        reason: "source_missing",
        phase: "retry",
        sourcePathKind: entry.source_path_kind || "inbox",
      });
      await logger.info("Retry-Queue: Quelle fehlt, Eintrag abgeschlossen", {
        filename: entry.filename,
        source_path: sourceFile,
        status: "dropped_missing_source",
      });
      summary.processed += 1;
      summary.results.dropped_missing_source += 1;
      continue;
    }

    let lock = { acquired: false, release: async () => {} };
    try {
      lock = await acquireLockFn(sourceFile, {
        locksDir: path.join(DIRS.runtime, "locks"),
      });
      if (!lock.acquired) {
        const nextAttempt = Number(entry.attempt || 0) + 1;
        const nextStatus = nextAttempt >= maxAttempts ? "failed" : "queued";
        const nextRetryAt =
          nextStatus === "queued"
            ? new Date(Date.now() + computeBackoffMs(nextAttempt)).toISOString()
            : null;

        await appendQueueStatus({
          retryQueuePath,
          retryArchivePath,
          baseEntry: entry,
          status: nextStatus,
          attempt: nextAttempt,
          nextRetryAt,
          reason: "lock_exists",
          phase: "retry",
          sourcePathKind: entry.source_path_kind || "inbox",
        });
        summary.processed += 1;
        if (nextStatus === "failed") {
          summary.results.failed += 1;
        } else {
          summary.results.skipped_lock += 1;
          summary.results.requeued += 1;
        }
        continue;
      }

      const staged = await stageInboxFileFn(sourceFile, {
        logger,
        filename: entry.filename || safeBasename(sourceFile),
        stagingDir,
      });

      if (!staged.ok) {
        const nextAttempt = Number(entry.attempt || 0) + 1;
        const nextStatus = nextAttempt >= maxAttempts ? "failed" : "queued";
        const nextRetryAt =
          nextStatus === "queued"
            ? new Date(Date.now() + computeBackoffMs(nextAttempt)).toISOString()
            : null;

        await appendQueueStatus({
          retryQueuePath,
          retryArchivePath,
          baseEntry: entry,
          status: nextStatus,
          attempt: nextAttempt,
          nextRetryAt,
          reason: staged.reason || "staging_failed",
          phase: "staging",
          sourcePathKind: "inbox",
        });
        summary.processed += 1;
        if (nextStatus === "failed") {
          summary.results.failed += 1;
        } else {
          summary.results.requeued += 1;
        }
        continue;
      }

      const stagedPath = staged.stagedPath;
      const res = await processPdfFn(stagedPath, {
        registry,
        logger,
        autoCreateCase: false,
        sourceInboxPath: sourceFile,
        sourceType: "staging",
      });
      if (res?.registry) registry = res.registry;

      if (res?.retry_eligible) {
        const nextAttempt = Number(entry.attempt || 0) + 1;
        const nextStatus = nextAttempt >= maxAttempts ? "failed" : "queued";
        const nextRetryAt =
          nextStatus === "queued"
            ? new Date(Date.now() + computeBackoffMs(nextAttempt)).toISOString()
            : null;

        await appendQueueStatus({
          retryQueuePath,
          retryArchivePath,
          baseEntry: entry,
          status: nextStatus,
          attempt: nextAttempt,
          nextRetryAt,
          reason: res.retry_reason || "pipeline_retry",
          phase: "pipeline",
          stagedPath,
          finalPath: res?.pdf || null,
          sourcePathKind: "staging",
        });
        summary.processed += 1;
        if (nextStatus === "failed") {
          summary.results.failed += 1;
        } else {
          summary.results.requeued += 1;
        }
        continue;
      }

      await appendQueueStatus({
        retryQueuePath,
        retryArchivePath,
        baseEntry: entry,
        status: "resolved",
        attempt: Number(entry.attempt || 0),
        reason: null,
        phase: "pipeline",
        stagedPath,
        finalPath: res?.pdf || null,
        sourcePathKind: "staging",
      });
      await logger.info("Retry-Queue: Eintrag aufgelöst", {
        filename: entry.filename,
        source_path: sourceFile,
        staged_path: stagedPath,
        final_path: res?.pdf || null,
      });
      summary.processed += 1;
      summary.results.resolved += 1;
    } catch (error) {
      const nextAttempt = Number(entry.attempt || 0) + 1;
      const nextStatus = nextAttempt >= maxAttempts ? "failed" : "queued";
      const nextRetryAt =
        nextStatus === "queued"
          ? new Date(Date.now() + computeBackoffMs(nextAttempt)).toISOString()
          : null;

      await appendQueueStatus({
        retryQueuePath,
        retryArchivePath,
        baseEntry: entry,
        status: nextStatus,
        attempt: nextAttempt,
        nextRetryAt,
        reason: String(error?.message || error),
        phase: "retry",
        sourcePathKind: entry.source_path_kind || "inbox",
      });
      summary.processed += 1;
      if (nextStatus === "failed") {
        summary.results.failed += 1;
      } else {
        summary.results.requeued += 1;
      }
    } finally {
      await lock.release();
    }
  }

  return summary;
}

module.exports = {
  runIngestRetry,
  readJsonl,
  buildQueueState,
  selectQueueEntries,
};
