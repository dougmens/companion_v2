const fs = require("node:fs/promises");
const fssync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { DIRS, FILES } = require("./config");
const { chunkText } = require("./chunking");
const { buildMarkdown } = require("./markdown");
const { buildPdfFilename } = require("./naming");
const { extractAktenzeichen } = require("./aktenzeichen");
const { decideRouting } = require("./routing");
const { createLogger } = require("./logger");
const {
  appendLine,
  ensureDir,
  getUniquePath,
  isPdfFilename,
  listFiles,
  moveFile,
  pathExists,
  safeBasename,
  safeRelative,
  statSafe,
  writeJson,
} = require("./fsx");
const { addCase, loadRegistry, registryCaseIds } = require("./registry");
const { validateSemanticJurCaseAssignment } = require("./semantic_case");

const { extractPdfText } = require("./pdf");
const { classifyDocument, embedTexts } = require("./openai");
const { appendChunksToIndex } = require("./indexer");

const DEFAULT_STABLE_MS = 3_000;
const DEFAULT_MAX_WAIT_MS = 120_000;
const DEFAULT_POLL_MS = 250;
const DEFAULT_MAX_POLL_MS = 2_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_STAGE_ATTEMPTS = 4;
const MAX_BACKOFF_MS = 10 * 60 * 1000;

async function ensureBaseDirs() {
  await Promise.all(
    Object.values(DIRS).map((dirPath) => ensureDir(dirPath)),
  );
}

async function writeMarkdownAndMetadata({
  mdPath,
  metaPath,
  mdContent,
  metadata,
}) {
  await ensureDir(path.dirname(mdPath));
  await ensureDir(path.dirname(metaPath));

  await fs.writeFile(mdPath, String(mdContent ?? ""), "utf8");
  await writeJson(metaPath, metadata);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeLockName(filePath) {
  const base = safeBasename(filePath).replace(/[^a-zA-Z0-9._-]+/g, "_");
  const hash = crypto.createHash("sha1").update(String(filePath)).digest("hex").slice(0, 10);
  return `${base}.${hash}.lock`;
}

async function acquireProcessingLock(filePath, { locksDir, staleMs = 10 * 60 * 1000 } = {}) {
  const targetLocksDir = locksDir || path.join(DIRS.runtime, "locks");
  await ensureDir(targetLocksDir);
  const lockPath = path.join(targetLocksDir, makeLockName(filePath));

  async function tryOpen() {
    const handle = await fs.open(lockPath, "wx");
    await handle.writeFile(
      `${JSON.stringify({ file: filePath, pid: process.pid, ts: new Date().toISOString() })}\n`,
      "utf8",
    );
    return handle;
  }

  try {
    const handle = await tryOpen();
    return {
      acquired: true,
      lockPath,
      async release() {
        try {
          await handle.close();
        } catch {
          // ignore
        }
        try {
          await fs.unlink(lockPath);
        } catch {
          // ignore
        }
      },
    };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const st = await statSafe(lockPath);
    if (st && (Date.now() - st.mtimeMs) > staleMs) {
      try {
        await fs.unlink(lockPath);
      } catch {
        // ignore
      }
      const handle = await tryOpen();
      return {
        acquired: true,
        lockPath,
        async release() {
          try {
            await handle.close();
          } catch {
            // ignore
          }
          try {
            await fs.unlink(lockPath);
          } catch {
            // ignore
          }
        },
      };
    }
    return {
      acquired: false,
      lockPath,
      async release() {},
    };
  }
}

async function moveFileIdempotent(srcPath, destPath, {
  allowUniqueOnConflict = true,
  idempotentIfDestExists = false,
  maxRetries = 1,
  retryDelayMs = 300,
} = {}) {
  await ensureDir(path.dirname(destPath));
  let targetPath = destPath;

  const srcExistsInitially = await pathExists(srcPath);
  if (!srcExistsInitially) {
    const dstExists = await pathExists(targetPath);
    return dstExists
      ? { ok: true, moved: false, idempotent: true, reason: "src_missing_dst_exists", destPath: targetPath }
      : { ok: false, moved: false, retryEligible: true, reason: "src_missing_dst_missing", destPath: targetPath };
  }

  if (idempotentIfDestExists && (await pathExists(targetPath))) {
    return {
      ok: true,
      moved: false,
      idempotent: true,
      reason: "dst_already_exists",
      destPath: targetPath,
    };
  }

  if (allowUniqueOnConflict && (await pathExists(targetPath))) {
    targetPath = await getUniquePath(targetPath);
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await moveFile(srcPath, targetPath);
      return { ok: true, moved: true, idempotent: false, reason: null, destPath: targetPath };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const dstExists = await pathExists(targetPath);
      if (dstExists) {
        return { ok: true, moved: false, idempotent: true, reason: "rename_enoent_dst_exists", destPath: targetPath };
      }
      if (attempt < maxRetries) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }
      return {
        ok: false,
        moved: false,
        retryEligible: true,
        reason: "rename_enoent_dst_missing",
        destPath: targetPath,
      };
    }
  }

  return {
    ok: false,
    moved: false,
    retryEligible: true,
    reason: "rename_unknown_failure",
    destPath: targetPath,
  };
}

function makeStagingFilename(originalName = "document.pdf") {
  const safeName = String(originalName)
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "document.pdf";
  const normalized = safeName.toLowerCase().endsWith(".pdf") ? safeName : `${safeName}.pdf`;
  return `${crypto.randomUUID()}__${normalized}`;
}

async function stageInboxFile(inboxPath, {
  logger,
  filename,
  stagingDir = DIRS.stagingPdf,
  stability = {},
  maxAttempts = DEFAULT_STAGE_ATTEMPTS,
  moveFn = moveFileIdempotent,
  waitForStableFn = waitForStableFile,
  sleepFn = sleep,
} = {}) {
  const name = filename || safeBasename(inboxPath);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const stableRes = await waitForStableFn(inboxPath, stability);
    if (!stableRes?.stable) {
      const isLast = attempt >= maxAttempts;
      if (isLast) {
        return {
          ok: false,
          retryEligible: true,
          reason: "staging_stability_timeout",
          stage_attempt: attempt,
          detail: stableRes,
        };
      }
      await sleepFn(computeBackoffMs(attempt));
      continue;
    }

    const stagedPath = path.join(stagingDir, makeStagingFilename(name));
    const moveRes = await moveFn(inboxPath, stagedPath, {
      allowUniqueOnConflict: false,
      maxRetries: 0,
      retryDelayMs: 0,
    });
    if (moveRes.ok) {
      await logger.info("Datei in Staging übernommen", {
        filename: name,
        stage_attempt: attempt,
        staged_path: safeRelative(process.cwd(), moveRes.destPath),
      });
      return {
        ok: true,
        stagedPath: moveRes.destPath,
        stage_attempt: attempt,
        move: moveRes,
      };
    }

    const retryable = moveRes.retryEligible
      || moveRes.reason === "src_missing_dst_missing"
      || moveRes.reason === "rename_enoent_dst_missing";
    if (!retryable) {
      return {
        ok: false,
        retryEligible: false,
        reason: moveRes.reason || "staging_move_failed",
        stage_attempt: attempt,
      };
    }

    if (attempt >= maxAttempts) {
      return {
        ok: false,
        retryEligible: true,
        reason: moveRes.reason || "staging_move_failed",
        stage_attempt: attempt,
      };
    }

    await logger.info("Staging-Move fehlgeschlagen, retry mit Backoff", {
      filename: name,
      stage_attempt: attempt,
      reason: moveRes.reason,
      backoff_ms: computeBackoffMs(attempt),
    });
    await sleepFn(computeBackoffMs(attempt));
  }

  return {
    ok: false,
    retryEligible: true,
    reason: "staging_unknown_failure",
    stage_attempt: maxAttempts,
  };
}

async function processOnePdf(pdfPath, {
  registry,
  logger,
  autoCreateCase = false,
  sourceInboxPath = null,
  sourceType = "unknown",
} = {}) {
  const filename = safeBasename(pdfPath);
  await logger.info("Eingang", {
    filename,
    source_type: sourceType,
    source_path: safeRelative(process.cwd(), pdfPath),
    inbox_path: sourceInboxPath ? safeRelative(process.cwd(), sourceInboxPath) : null,
  });

  if (!(await pathExists(pdfPath))) {
    await logger.info("Quelle bereits verschoben/verarbeitet, skip", { filename });
    return { status: "skipped_source_missing", pdf: null };
  }

  let nextRegistry = registry;

  let extracted;
  try {
    extracted = await extractPdfText(pdfPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      await logger.info("Quelle während Parsing verschwunden, vermutlich bereits verarbeitet", { filename });
      return { status: "skipped_source_missing", pdf: null };
    }
    const reviewTarget = path.join(DIRS.reviewRequired, filename);
    const moveRes = await moveFileIdempotent(pdfPath, reviewTarget, {
      allowUniqueOnConflict: true,
      maxRetries: 1,
      retryDelayMs: 250,
    });
    if (moveRes.ok) {
      await logger.error("PDF-Parse-Error -> REVIEW_REQUIRED", {
        filename,
        error: String(error?.message || error),
        moved_to: safeRelative(process.cwd(), moveRes.destPath),
      });
      return { status: "review_pdf_parse_error", pdf: moveRes.destPath };
    }
    await logger.warn("PDF-Parse-Error, Quelle fehlte beim Move (retry-eligible)", {
      filename,
      error: String(error?.message || error),
      reason: moveRes.reason,
    });
    return { status: "retry_eligible_missing_source", retry_eligible: true, retry_reason: moveRes.reason };
  }

  const text = extracted.text || "";
  if (text.trim().length === 0) {
    const reviewTarget = path.join(DIRS.reviewRequired, filename);
    const moveRes = await moveFileIdempotent(pdfPath, reviewTarget, {
      allowUniqueOnConflict: true,
      maxRetries: 1,
      retryDelayMs: 250,
    });
    if (!moveRes.ok) {
      await logger.warn("PDF-Text leer, Quelle fehlte beim Move (retry-eligible)", {
        filename,
        reason: moveRes.reason,
      });
      return { status: "retry_eligible_missing_source", retry_eligible: true, retry_reason: moveRes.reason };
    }
    await logger.warn("PDF-Text leer -> REVIEW_REQUIRED", {
      filename,
      moved_to: safeRelative(process.cwd(), moveRes.destPath),
    });
    return { status: "review_pdf_text_empty", pdf: moveRes.destPath };
  }

  const akz = extractAktenzeichen(text);
  await logger.info("Aktenzeichen-Erkennung", { filename, best: akz.best, all: akz.all });

  let classification;
  try {
    classification = await classifyDocument({
      filename,
      text,
      registry: nextRegistry,
      detectedAktenzeichen: akz.best,
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      await logger.info("Quelle während Klassifikation verschwunden, vermutlich bereits verarbeitet", { filename });
      return { status: "skipped_source_missing", pdf: null };
    }
    const reviewTarget = path.join(DIRS.reviewRequired, filename);
    const moveRes = await moveFileIdempotent(pdfPath, reviewTarget, {
      allowUniqueOnConflict: true,
      maxRetries: 1,
      retryDelayMs: 250,
    });
    if (moveRes.ok) {
      await logger.error("Klassifikation fehlgeschlagen -> REVIEW_REQUIRED", {
        filename,
        error: String(error?.message || error),
        moved_to: safeRelative(process.cwd(), moveRes.destPath),
      });
      return { status: "review_classification_failed", pdf: moveRes.destPath };
    }
    await logger.warn("Klassifikation fehlgeschlagen, Quelle fehlte beim Move (retry-eligible)", {
      filename,
      error: String(error?.message || error),
      reason: moveRes.reason,
    });
    return { status: "retry_eligible_missing_source", retry_eligible: true, retry_reason: moveRes.reason };
  }

  try {
    let registryIds = registryCaseIds(nextRegistry);
    const semanticRes = validateSemanticJurCaseAssignment(classification, registryIds, {
      text,
      autoCreateCase,
    });
    classification = semanticRes.classification;

    if (autoCreateCase && semanticRes?.create_case) {
      const proposal = semanticRes.create_case;
      if (!registryIds.has(proposal.case_id)) {
        const addRes = await addCase({
          case_id: proposal.case_id,
          title: proposal.title,
          aliasesCsv: (proposal.aliases || []).join(","),
          tagsCsv: (proposal.tags || []).join(","),
          registryPath: FILES.caseRegistry,
        });
        nextRegistry = addRes.registry;
        registryIds = registryCaseIds(nextRegistry);
      }
      if (registryIds.has(proposal.case_id)) {
        classification = {
          ...classification,
          case_id: proposal.case_id,
          case_confidence: Math.max(Number(classification.case_confidence ?? 0), 0.85),
        };
      }
    }

    if (semanticRes.changed || classification.proposed_case_id) {
      await logger.info("Semantische Case-Validierung", {
        filename,
        reason: semanticRes.reason,
        case_id: classification.case_id,
        proposed_case_id: classification.proposed_case_id || null,
        case_confidence: classification.case_confidence,
        auto_create_case: !!autoCreateCase,
      });
    }
  } catch (error) {
    await logger.error("Semantische Case-Validierung fehlgeschlagen (Dokument wird als UNASSIGNED geroutet)", {
      filename,
      error: String(error?.message || error),
    });
    classification = {
      ...classification,
      case_id: null,
      case_confidence: Math.min(Number(classification.case_confidence ?? 0), 0.79),
    };
  }

  const registryIds = registryCaseIds(nextRegistry);
  const routing = decideRouting(classification, registryIds);
  await logger.info("Klassifikation", { filename, classification, routing });

  const newPdfFilename = buildPdfFilename(classification);

  let pdfDestDir;
  let mdDestDir;
  let metaDestDir;
  let caseIdForIndex = null;

  if (routing.route === "jur_case" || routing.route === "jur_unassigned") {
    pdfDestDir = routing.pdfDir;
    mdDestDir = routing.mdDir;
    metaDestDir = routing.metaDir;
    caseIdForIndex = routing.route === "jur_case" ? routing.case_id : null;
    await Promise.all([
      ensureDir(routing.pdfDir),
      ensureDir(routing.mdDir),
      ensureDir(routing.metaDir),
      ensureDir(routing.evidenceDir),
    ]);
  } else {
    pdfDestDir = routing.pdfDir;
    mdDestDir = DIRS.markdown;
    metaDestDir = DIRS.metadata;
    await ensureDir(pdfDestDir);
  }

  const moveRes = await moveFileIdempotent(
    pdfPath,
    path.join(pdfDestDir, newPdfFilename),
    {
      allowUniqueOnConflict: false,
      idempotentIfDestExists: true,
      maxRetries: 1,
      retryDelayMs: 300,
    },
  );
  if (!moveRes.ok) {
    await logger.warn("PDF-Verschieben fehlgeschlagen (retry-eligible)", {
      filename,
      reason: moveRes.reason,
      source_type: sourceType,
      source_path: safeRelative(process.cwd(), pdfPath),
      target: safeRelative(process.cwd(), moveRes.destPath),
      missing_origin:
        moveRes.reason === "src_missing_dst_missing"
          ? (sourceType === "staging" ? "staging" : "inbox")
          : null,
    });
    await appendStagingStatus({
      sourceType,
      sourcePath: safeRelative(process.cwd(), pdfPath),
      inboxPath: sourceInboxPath ? safeRelative(process.cwd(), sourceInboxPath) : null,
      finalPath: safeRelative(process.cwd(), moveRes.destPath),
      status: "retry_eligible",
      reason: moveRes.reason,
    });
    return { status: "retry_eligible_move", retry_eligible: true, retry_reason: moveRes.reason };
  }
  const pdfDest = moveRes.destPath;
  if (moveRes.idempotent) {
    await logger.info("PDF bereits verschoben (idempotent)", {
      filename,
      reason: moveRes.reason,
      source_type: sourceType,
      source_path: safeRelative(process.cwd(), pdfPath),
      pdf_to: safeRelative(process.cwd(), pdfDest),
    });
    await appendStagingStatus({
      sourceType,
      sourcePath: safeRelative(process.cwd(), pdfPath),
      inboxPath: sourceInboxPath ? safeRelative(process.cwd(), sourceInboxPath) : null,
      finalPath: safeRelative(process.cwd(), pdfDest),
      status: "idempotent_success",
      reason: moveRes.reason,
    });
    return { status: "already_moved", pdf: pdfDest, registry: nextRegistry };
  }

  const mdDest = await getUniquePath(
    path.join(mdDestDir, `${path.basename(pdfDest, ".pdf")}.md`),
  );
  const metaDest = await getUniquePath(
    path.join(metaDestDir, `${path.basename(pdfDest, ".pdf")}.json`),
  );

  const frontmatter = {
    ...classification,
    source_pdf: safeRelative(process.cwd(), pdfDest),
    aktenzeichen_detected: akz.best,
    processed_at: new Date().toISOString(),
    routing: routing.route,
  };

  const meta = {
    ...frontmatter,
    extraction: {
      text_length: text.length,
      numpages: extracted.numpages,
      info: extracted.info,
    },
  };

  const mdContent = buildMarkdown({ frontmatter, text });
  await writeMarkdownAndMetadata({
    mdPath: mdDest,
    metaPath: metaDest,
    mdContent,
    metadata: meta,
  });

  await logger.info("Routing + Naming", {
    from: filename,
    inbox_path: sourceInboxPath ? safeRelative(process.cwd(), sourceInboxPath) : null,
    staged_path: sourceType === "staging" ? safeRelative(process.cwd(), pdfPath) : null,
    final_path: safeRelative(process.cwd(), pdfDest),
    pdf_to: safeRelative(process.cwd(), pdfDest),
    md_to: safeRelative(process.cwd(), mdDest),
    meta_to: safeRelative(process.cwd(), metaDest),
  });
  await appendStagingStatus({
    sourceType,
    sourcePath: safeRelative(process.cwd(), pdfPath),
    inboxPath: sourceInboxPath ? safeRelative(process.cwd(), sourceInboxPath) : null,
    finalPath: safeRelative(process.cwd(), pdfDest),
    status: "moved_to_final",
    reason: null,
  });

  // Embeddings + JSONL index
  try {
    if (mdContent.trim().length < 200) {
      await logger.warn("Text sehr kurz -> Embeddings/Index übersprungen", {
        md_len: mdContent.trim().length,
      });
      return { status: "processed", pdf: pdfDest, md: mdDest, meta: metaDest, registry: nextRegistry };
    }

    const chunks = chunkText({ text: mdContent });
    const embeddings = await embedTexts(chunks);

    const domainForIndex = classification.domain;
    const indexCaseId = domainForIndex === "jur" ? caseIdForIndex : null;
    const indexRes = await appendChunksToIndex({
      domain: domainForIndex,
      caseId: indexCaseId,
      sourcePdfPath: pdfDest,
      sourceMdPath: mdDest,
      chunks,
      embeddings,
    });

    await logger.info("Embeddings + Index", {
      chunks: indexRes.count,
      index: safeRelative(process.cwd(), indexRes.indexPath),
    });
  } catch (error) {
    await logger.error("Embeddings/Index fehlgeschlagen (Dokument bleibt verarbeitet)", {
      error: String(error?.message || error),
    });
  }

  return { status: "processed", pdf: pdfDest, md: mdDest, meta: metaDest, registry: nextRegistry };
}

async function ingestOnce({ autoCreateCase = false } = {}) {
  const logger = createLogger();
  await ensureBaseDirs();

  let registry = await loadRegistry();
  await logger.info("Start ingest:once", { inbox: safeRelative(process.cwd(), DIRS.inbox) });

  const all = await listFiles(DIRS.inbox);
  const pdfs = all.filter((p) => isPdfFilename(p));
  if (pdfs.length === 0) {
    await logger.info("Keine PDFs in 00_inbox/", { count: 0 });
    return;
  }

  for (const pdfPath of pdfs) {
    try {
      const stageRes = await stageInboxFile(pdfPath, {
        logger,
        filename: safeBasename(pdfPath),
        stagingDir: DIRS.stagingPdf,
        maxAttempts: DEFAULT_STAGE_ATTEMPTS,
      });
      if (!stageRes.ok) {
        await logger.warn("Staging fehlgeschlagen in ingest:once", {
          filename: safeBasename(pdfPath),
          reason: stageRes.reason,
          stage_attempt: stageRes.stage_attempt,
        });
        continue;
      }

      const res = await processOnePdf(stageRes.stagedPath, {
        registry,
        logger,
        autoCreateCase,
        sourceInboxPath: pdfPath,
        sourceType: "staging",
      });
      if (res?.registry) registry = res.registry;
    } catch (error) {
      await logger.error("Unerwarteter Fehler beim Verarbeiten", {
        pdf: safeBasename(pdfPath),
        error: String(error?.stack || error?.message || error),
      });
    }
  }

  await logger.info("Fertig ingest:once", { processed: pdfs.length });
}

async function waitForStableFile(filePath, {
  stableMs = DEFAULT_STABLE_MS,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  initialPollMs = DEFAULT_POLL_MS,
  maxPollMs = DEFAULT_MAX_POLL_MS,
  statFn = statSafe,
  sleepFn = sleep,
} = {}) {
  const start = Date.now();
  let pollMs = Math.max(50, Number(initialPollMs) || DEFAULT_POLL_MS);
  let lastSignature = null;
  let stableSince = null;
  let attempts = 0;

  while ((Date.now() - start) <= maxWaitMs) {
    attempts += 1;
    const st = await statFn(filePath);
    if (!st) {
      lastSignature = null;
      stableSince = null;
      await sleepFn(pollMs);
      pollMs = Math.min(maxPollMs, Math.round(pollMs * 1.35));
      continue;
    }

    const signature = `${st.size}:${Math.floor(st.mtimeMs)}`;
    if (signature === lastSignature) {
      stableSince = stableSince ?? Date.now();
      if ((Date.now() - stableSince) >= stableMs) {
        return {
          stable: true,
          reason: "stable",
          attempts,
          elapsedMs: Date.now() - start,
          size: st.size,
          mtimeMs: st.mtimeMs,
        };
      }
    } else {
      lastSignature = signature;
      stableSince = null;
    }

    await sleepFn(pollMs);
    pollMs = Math.min(maxPollMs, Math.round(pollMs * 1.35));
  }

  return {
    stable: false,
    reason: "max_wait_exceeded",
    attempts,
    elapsedMs: Date.now() - start,
  };
}

function computeBackoffMs(attempt) {
  const exp = Math.max(0, Number(attempt || 1) - 1);
  return Math.min(MAX_BACKOFF_MS, 2_000 * (2 ** exp));
}

async function appendRetryQueueEntry({
  retryQueuePath,
  filePath,
  filename,
  reason,
  attempt,
  nextRetryAt,
  entryId = null,
  originalTs = null,
  originalFilename = null,
  phase = "watch",
  stagedPath = null,
  sourceInboxPath = null,
  sourcePathKind = null,
}) {
  const ts = new Date().toISOString();
  const computedEntryId = entryId
    || crypto.createHash("sha1").update(`${ts}|${filename || ""}|${filePath || ""}`).digest("hex");
  const entry = {
    ts,
    entry_id: computedEntryId,
    ref: {
      entry_id: computedEntryId,
      original_ts: originalTs || ts,
      original_filename: originalFilename || (filename || safeBasename(filePath)),
    },
    filename: filename || safeBasename(filePath),
    file: filePath,
    phase: String(phase || "watch"),
    source_inbox_path: sourceInboxPath || filePath,
    staged_path: stagedPath,
    source_path_kind: sourcePathKind,
    reason: String(reason || "retry_eligible"),
    attempt: Number(attempt || 1),
    next_retry_at: nextRetryAt,
    status: "queued",
  };
  await appendLine(retryQueuePath, JSON.stringify(entry));
  return entry;
}

async function appendStagingStatus({
  sourceType,
  sourcePath,
  inboxPath,
  finalPath,
  status,
  reason = null,
}) {
  if (sourceType !== "staging" || !sourcePath) return;
  const stagingStatusPath = path.join(DIRS.staging, "staging_status.jsonl");
  const entry = {
    ts: new Date().toISOString(),
    status,
    reason,
    inbox_path: inboxPath || null,
    staging_path: sourcePath,
    final_path: finalPath || null,
  };
  await appendLine(stagingStatusPath, JSON.stringify(entry));
}

function createWatchEventHandler({
  logger,
  processPdf = processOnePdf,
  registryRef,
  autoCreateCase = false,
  inboxDir = DIRS.inbox,
  runtimeDir = DIRS.runtime,
  stagingDir = DIRS.stagingPdf,
  stageInboxFileFn = stageInboxFile,
  stability = {},
  maxRetries = DEFAULT_MAX_RETRIES,
  stageAttempts = DEFAULT_STAGE_ATTEMPTS,
} = {}) {
  const inProgress = new Set();
  const retryState = new Map();
  const locksDir = path.join(runtimeDir, "locks");
  const retryQueuePath = path.join(runtimeDir, "retry_queue.jsonl");

  async function markRetry(sourcePath, filename, reason, {
    phase = "watch",
    stagedPath = null,
    sourceInboxPath = null,
    sourcePathKind = null,
  } = {}) {
    const prev = retryState.get(sourcePath) || { attempt: 0, nextTryAt: 0 };
    const nowTs = new Date().toISOString();
    const entryId = prev.entryId
      || crypto.createHash("sha1").update(`${nowTs}|${filename || ""}|${sourcePath || ""}`).digest("hex");
    const originalTs = prev.originalTs || nowTs;
    const originalFilename = prev.originalFilename || filename;
    const attempt = prev.attempt + 1;
    const delayMs = computeBackoffMs(attempt);
    const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    retryState.set(sourcePath, {
      attempt,
      nextTryAt: Date.now() + delayMs,
      reason,
      entryId,
      originalTs,
      originalFilename,
    });
    await appendRetryQueueEntry({
      retryQueuePath,
      filePath: sourcePath,
      filename,
      reason,
      attempt,
      nextRetryAt,
      entryId,
      originalTs,
      originalFilename,
      phase,
      stagedPath,
      sourceInboxPath: sourceInboxPath || sourcePath,
      sourcePathKind,
    });
    return { attempt, nextRetryAt, exceeded: attempt > maxRetries };
  }

  function clearRetry(sourcePath) {
    retryState.delete(sourcePath);
  }

  return async function handleWatchEvent(name) {
    if (!name || !isPdfFilename(name)) return;
    const filename = String(name);
    const full = path.join(inboxDir, filename);

    const pending = retryState.get(full);
    if (pending && Date.now() < pending.nextTryAt) {
      await logger.info("Retry-Backoff aktiv, skip", {
        filename,
        reason: pending.reason,
        retry_attempt: pending.attempt,
        retry_at: new Date(pending.nextTryAt).toISOString(),
      });
      return;
    }

    if (inProgress.has(full)) {
      await logger.info("Datei bereits in Verarbeitung, skip Doppeltrigger", { filename });
      return;
    }
    inProgress.add(full);

    let lock = { acquired: false, release: async () => {} };
    try {
      lock = await acquireProcessingLock(full, { locksDir });
      if (!lock.acquired) {
        await logger.info("Lock aktiv, skip Doppeltrigger", { filename });
        return;
      }

      const staged = await stageInboxFileFn(full, {
        logger,
        filename,
        stagingDir,
        stability,
        maxAttempts: stageAttempts,
      });
      if (!staged.ok) {
        const retry = await markRetry(full, filename, staged.reason || "staging_failed", {
          phase: "staging",
          sourceInboxPath: full,
          sourcePathKind: "inbox",
        });
        await logger.warn("Staging fehlgeschlagen (retry-eligible)", {
          filename,
          reason: staged.reason,
          stage_attempt: staged.stage_attempt,
          retry_attempt: retry.attempt,
          retry_at: retry.nextRetryAt,
          max_retries: maxRetries,
        });
        return;
      }

      const stagedPath = staged.stagedPath;

      const res = await processPdf(stagedPath, {
        registry: registryRef.current,
        logger,
        autoCreateCase,
        sourceInboxPath: full,
        sourceType: "staging",
      });

      if (res?.registry) {
        registryRef.current = res.registry;
      }

      if (res?.retry_eligible) {
        const retry = await markRetry(full, filename, res.retry_reason || "retry_eligible", {
          phase: "pipeline",
          stagedPath,
          sourceInboxPath: full,
          sourcePathKind: "staging",
        });
        if (retry.exceeded) {
          await logger.warn("Max retries erreicht; Datei bleibt in Retry-Queue", {
            filename,
            retry_attempt: retry.attempt,
            max_retries: maxRetries,
            retry_at: retry.nextRetryAt,
            staged_path: safeRelative(process.cwd(), stagedPath),
          });
        }
        return;
      }

      clearRetry(full);
    } catch (error) {
      if (error?.code === "ENOENT") {
        const retry = await markRetry(full, filename, "watch_enoent", {
          phase: "staging",
          sourceInboxPath: full,
          sourcePathKind: "inbox",
        });
        await logger.warn("ENOENT im Watcher, einmalig retry-eligible markiert", {
          filename,
          retry_attempt: retry.attempt,
          retry_at: retry.nextRetryAt,
        });
      } else {
        await logger.error("Fehler in ingest:watch", { filename, error: String(error?.message || error) });
      }
    } finally {
      await lock.release();
      inProgress.delete(full);
    }
  };
}

async function ingestWatch({ autoCreateCase = false } = {}) {
  const logger = createLogger();
  await ensureBaseDirs();
  const registryRef = { current: await loadRegistry() };

  await logger.info("Start ingest:watch", { inbox: safeRelative(process.cwd(), DIRS.inbox) });
  if (typeof fssync.watch !== "function") {
    throw new Error("fs.watch not available in this environment");
  }

  const handleEvent = createWatchEventHandler({
    logger,
    processPdf: processOnePdf,
    registryRef,
    autoCreateCase,
  });

  const watcher = fssync.watch(DIRS.inbox, { persistent: true }, (_eventType, name) => {
    handleEvent(name).catch(async (error) => {
      await logger.error("Watcher callback failed", {
        filename: String(name || ""),
        error: String(error?.message || error),
      });
    });
  });

  await logger.info("Watcher aktiv (CTRL+C zum Beenden)", {});

  return new Promise((_resolve) => {
    process.on("SIGINT", async () => {
      watcher.close();
      await logger.info("Beende ingest:watch", {});
      process.exit(0);
    });
  });
}

module.exports = {
  ingestOnce,
  ingestWatch,
  processOnePdf,
  waitForStableFile,
  computeBackoffMs,
  moveFileIdempotent,
  stageInboxFile,
  acquireProcessingLock,
  createWatchEventHandler,
};
