const fs = require("node:fs/promises");
const path = require("node:path");

const { ROOT } = require("../lib/config");
const {
  ensureDir,
  listFiles,
  listFilesRecursive,
  pathExists,
  readJson,
  statSafe,
  writeJson,
} = require("../lib/fsx");

const MAX_EVENTS = 500;
const MAX_DOCUMENTS = 8000;

function buildPaths(root) {
  return {
    root,
    setupState: path.join(root, "docs", "ACTIVE", "SETUP_STATE.json"),
    caseRegistry: path.join(root, "case_registry.json"),
    inboxDir: path.join(root, "00_inbox"),
    processedDir: path.join(root, "10_processed"),
    eventsDir: path.join(root, "50_events"),
    intentsDir: path.join(root, "60_intents"),
    reportsDir: path.join(root, "70_runtime", "reports"),
    exportDir: path.join(root, "80_export"),
    outputFile: path.join(root, "80_export", "dashboard_state.json"),
  };
}

function toTsScore(tsValue) {
  const ms = Date.parse(String(tsValue || ""));
  return Number.isFinite(ms) ? ms : -Infinity;
}

function toIsoOrNull(value) {
  const score = toTsScore(value);
  if (!Number.isFinite(score)) return null;
  return new Date(score).toISOString();
}

function safeRelative(root, absPath) {
  return path.relative(root, absPath);
}

async function listFilesSafe(dirPath) {
  const exists = await pathExists(dirPath);
  if (!exists) return [];
  return listFiles(dirPath);
}

async function listFilesRecursiveSafe(dirPath) {
  const exists = await pathExists(dirPath);
  if (!exists) return [];
  return listFilesRecursive(dirPath);
}

function jsonParseSafe(raw) {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function inferFileKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".md") return "markdown";
  if (ext === ".json" || ext === ".jsonl") return "json";
  if (ext === ".txt") return "text";
  return "other";
}

function collectPathSegments(relPath) {
  return relPath.split(path.sep).filter(Boolean);
}

function ensureTreeNode(tree, segments) {
  let node = tree;
  for (const seg of segments) {
    if (!node.children[seg]) {
      node.children[seg] = {
        name: seg,
        children: {},
        files: [],
      };
    }
    node = node.children[seg];
  }
  return node;
}

function jaccardSimilarity(a, b) {
  const left = new Set((Array.isArray(a) ? a : []).map((v) => String(v).toLowerCase()).filter(Boolean));
  const right = new Set((Array.isArray(b) ? b : []).map((v) => String(v).toLowerCase()).filter(Boolean));
  if (left.size === 0 && right.size === 0) return 0;

  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection += 1;
  }
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function calculateUrgencyFromReport(report) {
  const errorCount = Number(report?.error_count || 0);
  const warningCount = Number(report?.warning_count || 0);
  if (errorCount > 0) return "urgent";
  if (warningCount > 0) return "attention";
  return "ok";
}

function urgencyRank(level) {
  if (level === "urgent") return 2;
  if (level === "attention") return 1;
  return 0;
}

function buildSimilarityMap(cases) {
  const byCase = {};
  for (const source of cases) {
    const sourceId = String(source.case_id || "");
    const sourceTags = Array.isArray(source.tags) ? source.tags : [];
    const scores = [];

    for (const target of cases) {
      const targetId = String(target.case_id || "");
      if (!targetId || targetId === sourceId) continue;
      const value = jaccardSimilarity(sourceTags, Array.isArray(target.tags) ? target.tags : []);
      if (value <= 0) continue;
      scores.push({
        case_id: targetId,
        score: Number(value.toFixed(4)),
      });
    }

    scores.sort((a, b) => b.score - a.score || a.case_id.localeCompare(b.case_id));
    byCase[sourceId] = scores;
  }
  return byCase;
}

async function readSetupState(paths) {
  const exists = await pathExists(paths.setupState);
  if (!exists) return {};
  return readJson(paths.setupState);
}

async function readCaseRegistry(paths) {
  const exists = await pathExists(paths.caseRegistry);
  if (!exists) return [];
  const registry = await readJson(paths.caseRegistry);
  return Array.isArray(registry?.cases) ? registry.cases : [];
}

async function readInbox(paths) {
  const files = await listFilesRecursiveSafe(paths.inboxDir);
  const items = [];

  for (const file of files) {
    const stat = await statSafe(file);
    if (!stat || !stat.isFile()) continue;
    const rel = safeRelative(paths.root, file);
    items.push({
      name: path.basename(file),
      path: rel,
      size: stat.size,
      mtime: new Date(stat.mtimeMs).toISOString(),
      kind: inferFileKind(file),
    });
  }

  items.sort((a, b) => toTsScore(b.mtime) - toTsScore(a.mtime));
  return {
    count: items.length,
    items,
  };
}

async function readProcessedDocuments(paths) {
  const files = await listFilesRecursiveSafe(paths.processedDir);
  const tree = {
    name: "10_processed",
    children: {},
    files: [],
  };

  const documents = [];

  for (const file of files) {
    const stat = await statSafe(file);
    if (!stat || !stat.isFile()) continue;

    const rel = safeRelative(paths.root, file);
    const relFromProcessed = path.relative(paths.processedDir, file);
    const segments = collectPathSegments(relFromProcessed);
    const parentSegments = segments.slice(0, -1);
    const node = ensureTreeNode(tree, parentSegments);

    const doc = {
      name: path.basename(file),
      path: rel,
      size: stat.size,
      mtime: new Date(stat.mtimeMs).toISOString(),
      ext: path.extname(file).toLowerCase(),
      kind: inferFileKind(file),
      case_id: null,
    };

    const joined = rel.replaceAll("\\", "/");
    const m = joined.match(/\/juristische_faelle\/[^/]+\/([^/]+)\//);
    if (m) doc.case_id = m[1];

    node.files.push({
      name: doc.name,
      path: doc.path,
      kind: doc.kind,
    });
    documents.push(doc);
  }

  documents.sort((a, b) => toTsScore(b.mtime) - toTsScore(a.mtime));
  return {
    total: documents.length,
    capped: Math.min(documents.length, MAX_DOCUMENTS),
    tree,
    files: documents.slice(0, MAX_DOCUMENTS),
  };
}

async function readEventsWithErrors(paths, { maxEvents = MAX_EVENTS } = {}) {
  const files = (await listFilesSafe(paths.eventsDir))
    .filter((f) => f.toLowerCase().endsWith(".jsonl"))
    .sort((a, b) => a.localeCompare(b));

  const items = [];
  const parseErrors = [];

  for (const file of files) {
    const raw = await fs.readFile(file, "utf8").catch(() => "");
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) continue;

      const parsed = jsonParseSafe(line);
      if (!parsed.ok) {
        parseErrors.push({
          filename: path.basename(file),
          line: i + 1,
          error: parsed.error,
        });
        continue;
      }

      items.push({
        ...parsed.value,
        __filename: path.basename(file),
        __line: i + 1,
      });
    }
  }

  items.sort((a, b) => toTsScore(b?.ts) - toTsScore(a?.ts));
  return {
    events: items.slice(0, Math.max(1, Number(maxEvents) || MAX_EVENTS)),
    parse_errors: parseErrors,
  };
}

function toReportView(root, filePath, stat, content) {
  const warnings = Array.isArray(content?.warnings) ? content.warnings : [];
  const errors = Array.isArray(content?.errors) ? content.errors : [];

  return {
    filename: path.basename(filePath),
    path: safeRelative(root, filePath),
    mtime: stat ? new Date(stat.mtimeMs).toISOString() : null,
    ts: content && typeof content === "object" ? content.ts || null : null,
    status: content && typeof content === "object" ? content.status || null : null,
    warning_count: warnings.length,
    error_count: errors.length,
    urgency: calculateUrgencyFromReport({ warning_count: warnings.length, error_count: errors.length }),
    content,
  };
}

async function readReports(paths) {
  const files = (await listFilesSafe(paths.reportsDir))
    .filter((f) => f.toLowerCase().endsWith(".json"))
    .sort((a, b) => a.localeCompare(b));

  const items = [];
  for (const file of files) {
    const stat = await statSafe(file);
    if (!stat || !stat.isFile()) continue;

    const raw = await fs.readFile(file, "utf8").catch(() => "");
    const parsed = jsonParseSafe(raw);
    const content = parsed.ok ? parsed.value : { parse_error: parsed.error };
    items.push(toReportView(paths.root, file, stat, content));
  }

  items.sort((a, b) => {
    const left = Number.isFinite(toTsScore(a.ts)) ? toTsScore(a.ts) : toTsScore(a.mtime);
    const right = Number.isFinite(toTsScore(b.ts)) ? toTsScore(b.ts) : toTsScore(b.mtime);
    return right - left;
  });

  return items;
}

function toIntentView(root, filePath, stat, content) {
  const safeContent = content && typeof content === "object" ? content : {};
  return {
    filename: path.basename(filePath),
    path: safeRelative(root, filePath),
    mtime: stat ? new Date(stat.mtimeMs).toISOString() : null,
    schema: safeContent.schema || null,
    id: safeContent.id || null,
    ts: safeContent.ts || null,
    type: safeContent.type || null,
    status: safeContent.status || null,
    content: safeContent,
  };
}

async function readIntents(paths) {
  const files = (await listFilesSafe(paths.intentsDir))
    .filter((f) => f.toLowerCase().endsWith(".json"))
    .sort((a, b) => a.localeCompare(b));

  const items = [];
  for (const file of files) {
    const stat = await statSafe(file);
    if (!stat || !stat.isFile()) continue;

    const raw = await fs.readFile(file, "utf8").catch(() => "");
    const parsed = jsonParseSafe(raw);
    const content = parsed.ok ? parsed.value : { parse_error: parsed.error };
    items.push(toIntentView(paths.root, file, stat, content));
  }

  items.sort((a, b) => {
    const left = Number.isFinite(toTsScore(a.ts)) ? toTsScore(a.ts) : toTsScore(a.mtime);
    const right = Number.isFinite(toTsScore(b.ts)) ? toTsScore(b.ts) : toTsScore(b.mtime);
    return right - left;
  });

  return items;
}

function buildCaseRuntimeMeta(cases, { events, reports, documents }) {
  const similarityByCase = buildSimilarityMap(cases);

  return cases.map((c) => {
    const caseId = String(c.case_id || "");

    const relatedEvents = events.filter((ev) => {
      if (String(ev.entity_id || "") === caseId) return true;
      if (String(ev?.payload?.case_id || "") === caseId) return true;
      return false;
    });

    const relatedReports = reports.filter((report) => JSON.stringify(report.content || {}).includes(caseId));
    const relatedDocs = documents.files.filter((file) => String(file.case_id || "") === caseId);

    let urgency = "ok";
    for (const report of relatedReports) {
      const next = report.urgency || "ok";
      if (urgencyRank(next) > urgencyRank(urgency)) urgency = next;
    }

    const lastActivity = [
      ...relatedEvents.map((e) => e.ts),
      ...relatedReports.map((r) => r.ts || r.mtime),
      ...relatedDocs.map((d) => d.mtime),
    ]
      .map((value) => toTsScore(value))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => b - a)[0];

    return {
      ...c,
      runtime: {
        urgency,
        last_activity_ts: Number.isFinite(lastActivity) ? new Date(lastActivity).toISOString() : null,
        event_count: relatedEvents.length,
        report_count: relatedReports.length,
        document_count: relatedDocs.length,
        similarity: similarityByCase[caseId] || [],
      },
    };
  });
}

function computeLastActivityTs({ events, reports, intents, documents, inbox }) {
  const candidates = [
    ...events.map((e) => e.ts),
    ...reports.map((r) => r.ts || r.mtime),
    ...intents.map((i) => i.ts || i.mtime),
    ...documents.files.map((f) => f.mtime),
    ...inbox.items.map((f) => f.mtime),
  ]
    .map((value) => toTsScore(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a);

  if (candidates.length === 0) return null;
  return new Date(candidates[0]).toISOString();
}

async function buildDashboardState({ root = ROOT, maxEvents = MAX_EVENTS } = {}) {
  const absRoot = path.resolve(root);
  const paths = buildPaths(absRoot);

  const [setup_state, rawCases, inbox, eventsResult, reports, intents, documents] = await Promise.all([
    readSetupState(paths),
    readCaseRegistry(paths),
    readInbox(paths),
    readEventsWithErrors(paths, { maxEvents }),
    readReports(paths),
    readIntents(paths),
    readProcessedDocuments(paths),
  ]);

  const cases = buildCaseRuntimeMeta(rawCases, {
    events: eventsResult.events,
    reports,
    documents,
  });

  const globalUrgency = cases
    .map((c) => c.runtime?.urgency || "ok")
    .sort((a, b) => urgencyRank(b) - urgencyRank(a))[0] || "ok";

  return {
    generated_at: new Date().toISOString(),
    setup_state,
    last_activity_ts: computeLastActivityTs({
      events: eventsResult.events,
      reports,
      intents,
      documents,
      inbox,
    }),
    urgency: globalUrgency,
    cases,
    events: eventsResult.events,
    reports,
    intents,
    inbox,
    documents,
    event_parse_errors: eventsResult.parse_errors,
  };
}

async function exportDashboardState({ root = ROOT, outputPath = null, maxEvents = MAX_EVENTS } = {}) {
  const absRoot = path.resolve(root);
  const paths = buildPaths(absRoot);
  const filePath = outputPath ? path.resolve(outputPath) : paths.outputFile;

  const state = await buildDashboardState({ root: absRoot, maxEvents });
  await ensureDir(path.dirname(filePath));
  await writeJson(filePath, state);

  return {
    ok: true,
    output_path: filePath,
    generated_at: state.generated_at,
    counts: {
      cases: state.cases.length,
      events: state.events.length,
      reports: state.reports.length,
      intents: state.intents.length,
      inbox_items: state.inbox.count,
      documents: state.documents.total,
      event_parse_errors: Array.isArray(state.event_parse_errors) ? state.event_parse_errors.length : 0,
    },
  };
}

async function main() {
  const result = await exportDashboardState();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error?.stack || error);
    process.exit(1);
  });
}

module.exports = {
  MAX_EVENTS,
  MAX_DOCUMENTS,
  buildDashboardState,
  buildPaths,
  calculateUrgencyFromReport,
  exportDashboardState,
  jaccardSimilarity,
  readEventsWithErrors,
};
