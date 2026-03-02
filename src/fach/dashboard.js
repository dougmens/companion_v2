const fs = require("node:fs/promises");
const path = require("node:path");

const { DIRS } = require("../lib/config");
const { loadRegistry } = require("../lib/registry");
const { listFilesRecursive } = require("../lib/fsx");

function isDocFile(filePath) {
  const lower = String(filePath || "").toLowerCase();
  return lower.endsWith(".pdf") || lower.endsWith(".md") || lower.endsWith(".json");
}

async function safeStat(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

async function generateFachDashboard() {
  const registry = await loadRegistry();
  const cases = Array.isArray(registry.cases) ? registry.cases : [];

  const roots = [DIRS.processedJurCases, DIRS.markdown, DIRS.metadata];
  const documents = [];

  for (const root of roots) {
    const files = await listFilesRecursive(root);
    for (const file of files) {
      if (!isDocFile(file)) continue;
      const st = await safeStat(file);
      documents.push({ file, mtimeMs: st?.mtimeMs || 0 });
    }
  }

  const newest = documents.sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null;

  return {
    generated_at: new Date().toISOString(),
    cases_total: cases.length,
    documents_total: documents.length,
    last_activity: newest ? new Date(newest.mtimeMs).toISOString() : null,
  };
}

module.exports = {
  generateFachDashboard,
};
