const path = require("node:path");

const { DIRS } = require("../lib/config");
const { listFilesRecursive } = require("../lib/fsx");

function normalizeCaseId(caseId) {
  return String(caseId || "").trim();
}

async function listCaseDocuments(caseId) {
  const normalized = normalizeCaseId(caseId);
  if (!normalized) {
    throw new Error("Missing --case-id");
  }

  const roots = [DIRS.processedJurCases, DIRS.markdown, DIRS.metadata];
  const files = [];

  for (const root of roots) {
    const list = await listFilesRecursive(root);
    for (const fp of list) {
      const lower = fp.toLowerCase();
      if (!lower.endsWith(".pdf") && !lower.endsWith(".md") && !lower.endsWith(".json")) continue;
      if (!fp.includes(normalized)) continue;
      files.push(path.relative(process.cwd(), fp).replaceAll(path.sep, "/"));
    }
  }

  files.sort((a, b) => a.localeCompare(b));

  return {
    case_id: normalized,
    count: files.length,
    files,
  };
}

module.exports = {
  listCaseDocuments,
};
