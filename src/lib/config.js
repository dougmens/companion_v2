const path = require("node:path");

const ROOT = process.env.COMPANION_ROOT
  ? path.resolve(process.env.COMPANION_ROOT)
  : process.cwd();

module.exports = {
  ROOT,
  DIRS: {
    inbox: path.join(ROOT, "00_inbox"),
    processed: path.join(ROOT, "10_processed"),
    staging: path.join(ROOT, "10_processed", "_staging"),
    stagingPdf: path.join(ROOT, "10_processed", "_staging", "pdf"),
    processedJurCases: path.join(ROOT, "10_processed", "juristische_faelle"),
    processedFin: path.join(ROOT, "10_processed", "finanzen"),
    processedAllg: path.join(ROOT, "10_processed", "allgemein"),
    reviewRequired: path.join(
      ROOT,
      "10_processed",
      "allgemein",
      "REVIEW_REQUIRED",
    ),
    markdown: path.join(ROOT, "20_markdown"),
    metadata: path.join(ROOT, "30_metadata"),
    ragIndex: path.join(ROOT, "40_rag_index"),
    ragBuilds: path.join(ROOT, "40_rag_index", "_builds"),
    logs: path.join(ROOT, "90_logs"),
    events: path.join(ROOT, "50_events"),
    intents: path.join(ROOT, "60_intents"),
    runtime: path.join(ROOT, "70_runtime"),
    export: path.join(ROOT, "80_export"),
  },
  FILES: {
    caseRegistry: path.join(ROOT, "case_registry.json"),
    ragCurrent: path.join(ROOT, "40_rag_index", "CURRENT"),
  },
};
