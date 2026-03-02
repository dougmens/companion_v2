const fs = require("node:fs/promises");
const path = require("node:path");

const { DIRS, FILES } = require("./config");
const {
  appendLine,
  ensureDir,
  getUniquePath,
  moveFile,
  pathExists,
  readJson,
  safeRelative,
  writeJson,
} = require("./fsx");
const { jurCaseBaseDir, jurCaseIndexPath } = require("./case_paths");
const { normalizeCaseId } = require("./registry");

async function moveDirContentsRecursive(srcDir, destDir) {
  if (!(await pathExists(srcDir))) return { movedFiles: 0 };
  await ensureDir(destDir);

  let movedFiles = 0;
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const e of entries) {
    const src = path.join(srcDir, e.name);
    const dest = path.join(destDir, e.name);
    if (e.isDirectory()) {
      const res = await moveDirContentsRecursive(src, dest);
      movedFiles += res.movedFiles;
      try {
        await fs.rmdir(src);
      } catch {
        // ignore
      }
      continue;
    }
    if (!e.isFile()) continue;
    const uniqueDest = await getUniquePath(dest);
    await moveFile(src, uniqueDest);
    movedFiles += 1;
  }

  return { movedFiles };
}

function remapJurCasePathString(p, fromCaseId, toCaseId) {
  if (typeof p !== "string" || !p) return p;
  const toBase = jurCaseBaseDir("juristische_faelle", toCaseId);
  const toUnix = `/${toBase.split(path.sep).join("/")}/`;
  const toWin = `\\${toBase.split(path.sep).join("\\")}\\`;

  const escapedFrom = String(fromCaseId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const unixRe = new RegExp(`/juristische_faelle/(?:[^/]+/)?${escapedFrom}/`, "g");
  const winRe = new RegExp(`\\\\juristische_faelle\\\\(?:[^\\\\]+\\\\)?${escapedFrom}\\\\`, "g");

  return p.replace(unixRe, toUnix).replace(winRe, toWin);
}

function readJsonlLines(raw) {
  return String(raw ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

async function mergeJurIndex({ fromCaseId, toCaseId, ragIndexDir = DIRS.ragIndex }) {
  const jurDir = path.join(ragIndexDir, "jur");
  const preferredFromPath = jurCaseIndexPath(jurDir, fromCaseId);
  const preferredToPath = jurCaseIndexPath(jurDir, toCaseId);
  const legacyFromPath = path.join(jurDir, `${fromCaseId}.jsonl`);
  const legacyToPath = path.join(jurDir, `${toCaseId}.jsonl`);

  const fromCandidates = Array.from(new Set([preferredFromPath, legacyFromPath]));
  const toCandidates = Array.from(new Set([preferredToPath, legacyToPath]));

  const existingFrom = [];
  for (const p of fromCandidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await pathExists(p)) existingFrom.push(p);
  }
  if (existingFrom.length === 0) {
    return { merged: false, added: 0, deduped: 0, toPath: preferredToPath };
  }

  let toLinesRaw = "";
  for (const p of toCandidates) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await pathExists(p))) continue;
    // eslint-disable-next-line no-await-in-loop
    toLinesRaw += `${await fs.readFile(p, "utf8")}\n`;
  }

  let fromLinesRaw = "";
  for (const p of existingFrom) {
    // eslint-disable-next-line no-await-in-loop
    fromLinesRaw += `${await fs.readFile(p, "utf8")}\n`;
  }

  const out = [];
  const seen = new Set();
  let deduped = 0;

  for (const line of readJsonlLines(toLinesRaw)) {
    try {
      const rec = JSON.parse(line);
      const key = String(rec?.chunk_id ?? "");
      if (!key) continue;
      if (seen.has(key)) {
        deduped += 1;
        continue;
      }
      seen.add(key);
      out.push(JSON.stringify(rec));
    } catch {
      // ignore broken lines
    }
  }

  let added = 0;
  for (const line of readJsonlLines(fromLinesRaw)) {
    try {
      const rec = JSON.parse(line);
      const key = String(rec?.chunk_id ?? "");
      if (!key) continue;
      if (seen.has(key)) {
        deduped += 1;
        continue;
      }
      seen.add(key);
      const next = {
        ...rec,
        case_id: toCaseId,
        source_pdf: remapJurCasePathString(rec.source_pdf, fromCaseId, toCaseId),
        source_md: remapJurCasePathString(rec.source_md, fromCaseId, toCaseId),
      };
      out.push(JSON.stringify(next));
      added += 1;
    } catch {
      // ignore broken lines
    }
  }

  await ensureDir(path.dirname(preferredToPath));
  await fs.writeFile(preferredToPath, `${out.join("\n")}\n`, "utf8");

  for (const p of existingFrom) {
    // eslint-disable-next-line no-await-in-loop
    await fs.unlink(p);
  }
  for (const p of toCandidates) {
    if (p === preferredToPath) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await pathExists(p)) await fs.unlink(p);
  }

  return { merged: true, added, deduped, toPath: preferredToPath };
}

async function mergeCases({
  from,
  to,
  registryPath = FILES.caseRegistry,
  processedJurCasesDir = DIRS.processedJurCases,
  ragIndexDir = DIRS.ragIndex,
  logsDir = DIRS.logs,
  logPath = null,
} = {}) {
  const fromCaseId = normalizeCaseId(from);
  const toCaseId = normalizeCaseId(to);
  if (!fromCaseId || !toCaseId) throw new Error("--from/--to must match /^[A-Za-z0-9_]+$/");
  if (fromCaseId === toCaseId) throw new Error("--from and --to must be different");

  const effectiveLogPath = logPath || path.join(logsDir, "case_merge.log");

  const registry = await readJson(registryPath);
  if (!registry || !Array.isArray(registry.cases)) {
    throw new Error(`Invalid case registry: ${registryPath}`);
  }

  const fromEntry = registry.cases.find((c) => c?.case_id === fromCaseId);
  const toEntry = registry.cases.find((c) => c?.case_id === toCaseId);
  if (!toEntry || toEntry.archived) throw new Error(`Target case not found/active: ${toCaseId}`);
  if (!fromEntry) throw new Error(`Source case not found: ${fromCaseId}`);
  if (fromEntry.archived && fromEntry.merged_into === toCaseId) {
    return { ok: true, skipped: true, reason: "already_merged" };
  }
  if (fromEntry.archived) throw new Error(`Source case is archived: ${fromCaseId}`);

  const fromBase = jurCaseBaseDir(processedJurCasesDir, fromCaseId);
  const toBase = jurCaseBaseDir(processedJurCasesDir, toCaseId);
  if (!(await pathExists(fromBase))) throw new Error(`Source case folder not found: ${fromBase}`);

  await Promise.all([
    ensureDir(path.join(toBase, "pdf")),
    ensureDir(path.join(toBase, "md")),
    ensureDir(path.join(toBase, "meta")),
    ensureDir(path.join(toBase, "evidence")),
  ]);

  const moved = { pdf: 0, md: 0, meta: 0, evidence: 0 };
  for (const sub of Object.keys(moved)) {
    // eslint-disable-next-line no-await-in-loop
    const res = await moveDirContentsRecursive(path.join(fromBase, sub), path.join(toBase, sub));
    moved[sub] = res.movedFiles;
  }

  const indexRes = await mergeJurIndex({ fromCaseId, toCaseId, ragIndexDir });

  fromEntry.archived = true;
  fromEntry.merged_into = toCaseId;
  fromEntry.merged_at = new Date().toISOString();

  await writeJson(registryPath, registry);

  const logRecord = {
    ts: new Date().toISOString(),
    from: fromCaseId,
    to: toCaseId,
    moved,
    index: indexRes,
  };
  await appendLine(effectiveLogPath, JSON.stringify(logRecord));

  return {
    ok: true,
    from: fromCaseId,
    to: toCaseId,
    moved,
    index: { ...indexRes, toPath: safeRelative(process.cwd(), indexRes.toPath) },
    registry: safeRelative(process.cwd(), registryPath),
    log: safeRelative(process.cwd(), effectiveLogPath),
  };
}

module.exports = { mergeCases, mergeJurIndex, remapJurCasePathString };
