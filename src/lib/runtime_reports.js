const path = require("node:path");
const fs = require("node:fs/promises");

const { DIRS, ROOT } = require("./config");
const { appendLine, ensureDir, safeRelative, writeJson } = require("./fsx");

function nowIso() {
  return new Date().toISOString();
}

function safeIdForFilename(id) {
  const raw = String(id ?? "");
  if (/^[A-Za-z0-9._-]{1,120}$/.test(raw)) return raw;
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
  return cleaned || `intent_${Date.now()}`;
}

function reportFilePath(intentId) {
  const name = `${safeIdForFilename(intentId)}.json`;
  return path.join(DIRS.runtime, "reports", name);
}

async function writeIntentReport(report) {
  const intent_id = report?.intent_id;
  if (!intent_id) throw new Error("report.intent_id required");

  const reportPath = reportFilePath(intent_id);
  await ensureDir(path.dirname(reportPath));
  await writeJson(reportPath, report);
  return { reportPath: safeRelative(ROOT, reportPath) };
}

async function appendRuntimeSummaryLine(summary) {
  const filePath = path.join(DIRS.logs, "runtime.log");
  await ensureDir(path.dirname(filePath));
  const line = {
    ts: nowIso(),
    ...summary,
  };
  await appendLine(filePath, JSON.stringify(line));
  return { filePath: safeRelative(ROOT, filePath) };
}

async function reportExists(intentId) {
  const p = reportFilePath(intentId);
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  appendRuntimeSummaryLine,
  reportExists,
  reportFilePath,
  safeIdForFilename,
  writeIntentReport,
};
