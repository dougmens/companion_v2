const fs = require("node:fs/promises");
const path = require("node:path");

const { DIRS, FILES, ROOT } = require("./config");
const { appendLine, ensureDir, listFilesRecursive, readJson, safeRelative } = require("./fsx");
const { chunkText } = require("./chunking");
const { normalizeLegalAreaToken } = require("./case_paths");
const { embedTexts } = require("./openai");

function buildTs(date = new Date()) {
  // 2026-02-24T20:45:37.123Z -> 20260224T204537Z
  const iso = date.toISOString();
  const ymd = iso.slice(0, 10).replace(/-/g, "");
  const hms = iso.slice(11, 19).replace(/:/g, "");
  return `${ymd}T${hms}Z`;
}

function normalizeDomain(domain) {
  const d = String(domain ?? "").trim();
  if (d === "jur" || d === "fin" || d === "allg") return d;
  return "allg";
}

const LEGAL_AREAS = new Set([
  "familienrecht",
  "strafrecht",
  "verwaltungsrecht",
  "versicherungsrecht",
  "mietrecht",
]);

function normalizeScope(domainScope) {
  const raw = String(domainScope ?? "").trim().toLowerCase();
  if (!raw || raw === "global" || raw === "all" || raw === "*") {
    return { kind: "all", value: "global" };
  }
  if (raw === "jur" || raw === "fin" || raw === "allg") {
    return { kind: "domain", value: raw };
  }
  if (LEGAL_AREAS.has(raw)) {
    return { kind: "legal_area", value: raw };
  }
  throw new Error(
    `Unsupported domain scope: ${raw}. Use one of: global, jur, fin, allg, ${Array.from(LEGAL_AREAS).join(", ")}`,
  );
}

function resolveBuildTargets(scope, buildTimestamp) {
  if (scope.kind === "all") {
    return {
      buildRoot: path.join(DIRS.ragBuilds, buildTimestamp),
      currentFile: FILES.ragCurrent,
      scopeValue: "global",
    };
  }

  const domainBase = path.join(DIRS.ragIndex, scope.value);
  return {
    buildRoot: path.join(domainBase, "_builds", buildTimestamp),
    currentFile: path.join(domainBase, "CURRENT"),
    scopeValue: scope.value,
  };
}

function matchesScope(scope, { domain, caseId }) {
  if (scope.kind === "all") return true;
  if (scope.kind === "domain") return domain === scope.value;
  if (domain !== "jur") return false;
  return normalizeLegalAreaToken(caseId) === scope.value;
}

function indexFilePath(buildRoot, { domain, caseId, legalArea }) {
  const d = normalizeDomain(domain);
  const file = `${caseId || "general"}.jsonl`;
  if (d === "jur" && legalArea) {
    return path.join(buildRoot, d, legalArea, file);
  }
  return path.join(buildRoot, d, file);
}

function mockEmbedTexts(texts, { dims = 8 } = {}) {
  return (texts || []).map((t, idx) => {
    const s = String(t ?? "");
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const base = (h >>> 0) / 2 ** 32;
    const vec = [];
    for (let i = 0; i < dims; i++) {
      vec.push((base + (idx + 1) * 0.0001 + i * 0.00001) % 1);
    }
    return vec;
  });
}

async function collectCanonicalMetaFiles() {
  const out = [];

  const metaGlobal = await listFilesRecursive(DIRS.metadata);
  out.push(...metaGlobal.filter((p) => p.toLowerCase().endsWith(".json")));

  const jurAll = await listFilesRecursive(DIRS.processedJurCases);
  out.push(
    ...jurAll.filter(
      (p) =>
        p.toLowerCase().endsWith(".json") &&
        p.split(path.sep).includes("meta"),
    ),
  );

  return out;
}

async function rebuildRagIndex({
  mockEmbeddings = false,
  buildTimestamp = buildTs(),
  domainScope = null,
} = {}) {
  const scope = normalizeScope(domainScope);
  const { buildRoot, currentFile, scopeValue } = resolveBuildTargets(scope, buildTimestamp);
  await ensureDir(buildRoot);

  const metaFiles = await collectCanonicalMetaFiles();
  const written = { docs: 0, chunks: 0, files: new Set() };
  const skipped = [];

  for (const metaPath of metaFiles) {
    let meta;
    try {
      meta = await readJson(metaPath);
    } catch (error) {
      skipped.push({ meta: safeRelative(ROOT, metaPath), reason: `read_json_failed: ${String(error?.message || error)}` });
      continue;
    }

    const domain = normalizeDomain(meta.domain);
    const routing = String(meta.routing ?? "");
    const isJurCase = domain === "jur" && routing === "jur_case" && typeof meta.case_id === "string";
    const caseId = isJurCase ? meta.case_id : null;
    const legalArea = domain === "jur" ? normalizeLegalAreaToken(caseId) : null;

    if (!matchesScope(scope, { domain, caseId })) {
      continue;
    }

    const sourceMdRel = meta.source_md;
    const sourcePdfRel = meta.source_pdf;
    if (!sourceMdRel || !sourcePdfRel) {
      skipped.push({ meta: safeRelative(ROOT, metaPath), reason: "missing source_md/source_pdf" });
      continue;
    }

    const sourceMdAbs = path.join(ROOT, sourceMdRel);
    let mdContent;
    try {
      mdContent = await fs.readFile(sourceMdAbs, "utf8");
    } catch (error) {
      skipped.push({ meta: safeRelative(ROOT, metaPath), reason: `missing source_md: ${sourceMdRel}` });
      continue;
    }

    const chunks = chunkText({ text: mdContent });
    const embeddings = mockEmbeddings
      ? mockEmbedTexts(chunks)
      : await embedTexts(chunks);

    const outPath = indexFilePath(buildRoot, { domain, caseId, legalArea });
    await ensureDir(path.dirname(outPath));

    for (let i = 0; i < chunks.length; i++) {
      const record = {
        chunk_id: `${path.basename(sourceMdRel)}::${i + 1}`,
        domain,
        case_id: caseId ?? null,
        source_pdf: String(sourcePdfRel),
        source_md: String(sourceMdRel),
        text: chunks[i],
        embedding: embeddings[i],
      };
      await appendLine(outPath, JSON.stringify(record));
      written.chunks += 1;
    }

    written.docs += 1;
    written.files.add(safeRelative(ROOT, outPath));
  }

  const currentRel = safeRelative(path.dirname(currentFile), buildRoot);
  await ensureDir(path.dirname(currentFile));
  await fs.writeFile(currentFile, `${currentRel}\n`, "utf8");

  return {
    scope: scopeValue,
    buildRoot: safeRelative(ROOT, buildRoot),
    current: safeRelative(ROOT, currentFile),
    currentValue: currentRel,
    written: { docs: written.docs, chunks: written.chunks, files: Array.from(written.files).sort() },
    skipped,
  };
}

module.exports = {
  buildTs,
  normalizeScope,
  rebuildRagIndex,
};
