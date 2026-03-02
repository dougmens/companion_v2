const path = require("node:path");
const { appendLine, ensureDir, safeRelative } = require("./fsx");
const { DIRS, ROOT } = require("./config");
const { normalizeLegalAreaToken } = require("./case_paths");

function indexFilePath({ domain, caseId }) {
  const d = domain === "jur" || domain === "fin" || domain === "allg" ? domain : "allg";
  const file = `${caseId || "general"}.jsonl`;
  const legalArea = d === "jur" ? normalizeLegalAreaToken(caseId) : null;
  if (d === "jur" && legalArea) {
    return path.join(DIRS.ragIndex, d, legalArea, file);
  }
  return path.join(DIRS.ragIndex, d, file);
}

async function appendChunksToIndex({
  domain,
  caseId,
  sourcePdfPath,
  sourceMdPath,
  chunks,
  embeddings,
}) {
  if (!Array.isArray(chunks) || !Array.isArray(embeddings) || chunks.length !== embeddings.length) {
    throw new Error("chunks/embeddings length mismatch");
  }

  const indexPath = indexFilePath({ domain, caseId });
  await ensureDir(path.dirname(indexPath));

  const source_pdf = safeRelative(ROOT, sourcePdfPath);
  const source_md = safeRelative(ROOT, sourceMdPath);

  for (let i = 0; i < chunks.length; i++) {
    const record = {
      chunk_id: `${path.basename(sourceMdPath)}::${i + 1}`,
      domain,
      case_id: caseId ?? null,
      source_pdf,
      source_md,
      text: chunks[i],
      embedding: embeddings[i],
    };
    await appendLine(indexPath, JSON.stringify(record));
  }

  return { indexPath, count: chunks.length };
}

module.exports = { appendChunksToIndex, indexFilePath };
