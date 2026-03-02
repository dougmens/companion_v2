const fs = require("node:fs/promises");
const path = require("node:path");

const { DIRS, ROOT } = require("./config");
const { ensureDir, listFilesRecursive, readJson, writeJson } = require("./fsx");
const { loadRegistry } = require("./registry");

function toIsoOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function maxIso(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function isMetaPathInJurCaseMeta(p) {
  return p.toLowerCase().endsWith(".json") && p.split(path.sep).includes("meta");
}

async function collectCanonicalMetaFiles() {
  const out = [];

  const globalMeta = await listFilesRecursive(DIRS.metadata);
  out.push(...globalMeta.filter((p) => p.toLowerCase().endsWith(".json")));

  const jurAll = await listFilesRecursive(DIRS.processedJurCases);
  out.push(...jurAll.filter((p) => isMetaPathInJurCaseMeta(p)));

  return out;
}

async function readRuntimeErrors() {
  const filePath = path.join(DIRS.logs, "runtime.log");
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return { count: 0, last_error_at: null, file: path.relative(ROOT, filePath) };
  }

  let count = 0;
  let lastErrorAt = null;

  for (const line of String(raw).split("\n").map((l) => l.trim()).filter(Boolean)) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const errNum = Number(obj?.errors ?? 0);
    if (errNum > 0) {
      count += errNum;
      lastErrorAt = maxIso(lastErrorAt, toIsoOrNull(obj?.ts));
      continue;
    }
    if (String(obj?.status || "").toLowerCase() === "error") {
      count += 1;
      lastErrorAt = maxIso(lastErrorAt, toIsoOrNull(obj?.ts));
    }
  }

  return { count, last_error_at: lastErrorAt, file: path.relative(ROOT, filePath) };
}

async function generateCaseDashboard() {
  const registry = await loadRegistry();
  const cases = (registry.cases || []).filter((c) => c && !c.archived);

  const caseMap = new Map(
    cases.map((c) => [
      c.case_id,
      {
        case_id: c.case_id,
        title: c.title || c.case_id,
        document_count: 0,
        last_change: null,
      },
    ]),
  );

  const metaFiles = await collectCanonicalMetaFiles();
  let unassignedCount = 0;
  let unassignedLast = null;
  let globalLast = null;

  for (const metaPath of metaFiles) {
    let meta;
    try {
      meta = await readJson(metaPath);
    } catch {
      continue;
    }

    let st = null;
    try {
      st = await fs.stat(metaPath);
    } catch {
      // ignore
    }

    const docTs = toIsoOrNull(meta?.processed_at) || toIsoOrNull(st?.mtime);
    globalLast = maxIso(globalLast, docTs);

    const caseId = typeof meta?.case_id === "string" ? meta.case_id : null;
    const knownCase = caseId && caseMap.has(caseId);
    if (knownCase) {
      const row = caseMap.get(caseId);
      row.document_count += 1;
      row.last_change = maxIso(row.last_change, docTs);
      continue;
    }

    const isJur = String(meta?.domain || "") === "jur";
    const isUnassigned =
      isJur &&
      (String(meta?.routing || "") === "jur_unassigned" ||
        !caseId ||
        caseId === "NEW_CASE" ||
        !knownCase);

    if (isUnassigned) {
      unassignedCount += 1;
      unassignedLast = maxIso(unassignedLast, docTs);
    }
  }

  const runtimeErrors = await readRuntimeErrors();
  globalLast = maxIso(globalLast, runtimeErrors.last_error_at);

  const outCases = Array.from(caseMap.values()).sort((a, b) =>
    String(a.case_id).localeCompare(String(b.case_id)),
  );

  const dashboard = {
    generated_at: new Date().toISOString(),
    summary: {
      total_cases: outCases.length,
      total_documents: outCases.reduce((acc, c) => acc + Number(c.document_count || 0), 0),
      unassigned_documents: unassignedCount,
      runtime_errors: runtimeErrors.count,
      last_change: globalLast,
    },
    cases: outCases,
    unassigned: {
      document_count: unassignedCount,
      last_change: unassignedLast,
    },
    runtime: {
      errors: runtimeErrors.count,
      last_error_at: runtimeErrors.last_error_at,
      log_file: runtimeErrors.file,
    },
  };

  const exportPath = path.join(DIRS.export, "case_dashboard.json");
  await ensureDir(path.dirname(exportPath));
  await writeJson(exportPath, dashboard);

  return {
    exportPath: path.relative(ROOT, exportPath),
    dashboard,
  };
}

module.exports = {
  generateCaseDashboard,
};
