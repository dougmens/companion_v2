const path = require("node:path");
const { toAscii } = require("./sanitize");

const LEGAL_AREA_MAP = {
  familienrecht: "familienrecht",
  strafrecht: "strafrecht",
  verwaltungsrecht: "verwaltungsrecht",
  versicherungsrecht: "versicherungsrecht",
  mietrecht: "mietrecht",
};

function normalizeLegalAreaToken(caseId) {
  const raw = String(caseId ?? "").split("_")[0] || "";
  const normalized = toAscii(raw).toLowerCase().trim();
  return LEGAL_AREA_MAP[normalized] || null;
}

function jurCaseBaseDir(processedJurCasesDir, caseId) {
  const legalArea = normalizeLegalAreaToken(caseId);
  if (!legalArea) return path.join(processedJurCasesDir, String(caseId ?? ""));
  return path.join(processedJurCasesDir, legalArea, String(caseId ?? ""));
}

function jurCaseIndexPath(ragJurDir, caseId) {
  const legalArea = normalizeLegalAreaToken(caseId);
  if (!legalArea) return path.join(ragJurDir, `${caseId}.jsonl`);
  return path.join(ragJurDir, legalArea, `${caseId}.jsonl`);
}

module.exports = {
  jurCaseIndexPath,
  jurCaseBaseDir,
  normalizeLegalAreaToken,
};
