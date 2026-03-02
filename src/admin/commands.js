const path = require("node:path");

const { ingestOnce, ingestWatch } = require("../lib/ingest");
const { runIngestRetry } = require("../lib/ingest_retry");
const { runIngestReprocess } = require("../lib/ingest_reprocess");
const { generateCaseDashboard } = require("../lib/case_dashboard");
const { tailEvents, appendEvent } = require("../lib/events");
const { rebuildRagIndex } = require("../lib/rag_rebuild");
const { runSystemDoctor } = require("../lib/system_doctor");
const { promoteSystem, setSystemMode } = require("../lib/system_mode");
const { ROOT } = require("../lib/config");
const { readJson, writeJson } = require("../lib/fsx");
const { normalizeV2, validateV2, mapV2ToInternal } = require("../lib/intent_v2");
const { appendRuntimeSummaryLine, writeIntentReport } = require("../lib/runtime_reports");
const { applyIntent } = require("../lib/intents");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    args[key] = val;
    args[key.replace(/-/g, "_")] = val;
  }
  return args;
}

function usage() {
  // eslint-disable-next-line no-console
  console.log(`Admin commands:
  node src/cli.js admin ingest:once [--auto-create-case true]
  node src/cli.js admin ingest:watch [--auto-create-case true]
  node src/cli.js admin ingest:retry [--max 50] [--dry-run] [--older-than-minutes 30] [--status queued|failed|all]
  node src/cli.js admin ingest:reprocess [--max 50] [--dry-run] [--older-than-minutes 30] [--only-openai-errors]
  node src/cli.js admin intent:apply <intent.json>
  node src/cli.js admin intent:apply-v2 <intent_v2.json>
  node src/cli.js admin events:tail [--n 20]
  node src/cli.js admin rag:rebuild [--mock-embeddings] [--domain <global|jur|fin|allg|familienrecht|strafrecht|verwaltungsrecht|versicherungsrecht|mietrecht>]
  node src/cli.js admin system:doctor [--strict] [--quick] [--run-tests] [--write-probe]
  node src/cli.js admin system:mode --set <test|staged>
  node src/cli.js admin system:promote
`);
}

function buildReport({
  intent_id,
  status,
  applied_actions = [],
  events_written = [],
  registry_changes = [],
  warnings = [],
  errors = [],
}) {
  return {
    intent_id: String(intent_id),
    ts: new Date().toISOString(),
    status: String(status),
    applied_actions: Array.isArray(applied_actions) ? applied_actions : [],
    events_written: Array.isArray(events_written) ? events_written : [],
    registry_changes: Array.isArray(registry_changes) ? registry_changes : [],
    warnings: Array.isArray(warnings) ? warnings : [],
    errors: Array.isArray(errors) ? errors : [],
  };
}

function eventRef(event, filePath) {
  const fp = filePath ? String(filePath) : null;
  const normalizedFile = !fp ? null : (path.isAbsolute(fp) ? path.relative(process.cwd(), fp) : fp);
  return {
    id: event?.id || null,
    ts: event?.ts || null,
    type: event?.type || null,
    file: normalizedFile,
  };
}

async function writeReportAndLog(report) {
  const { reportPath } = await writeIntentReport(report);
  await appendRuntimeSummaryLine({
    intent_id: report.intent_id,
    status: report.status,
    applied_actions: report.applied_actions,
    events_written: report.events_written.length,
    registry_changes: report.registry_changes.length,
    errors: report.errors.length,
    warnings: report.warnings.length,
    report: reportPath,
  });
  return { reportPath };
}

async function cmdIntentApply(argv) {
  const args = parseArgs(argv);
  const intentPath = args.path || argv.find((a) => a && !a.startsWith("--"));
  if (!intentPath) throw new Error("Missing intent path. Usage: intent:apply <intent.json>");

  if (args.validate_only === "true" || args["validate-only"] === "true") {
    const raw = await readJson(path.resolve(intentPath));
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ok: true, intent: raw }, null, 2));
    return;
  }

  let res;
  let report;
  let raw = null;
  try {
    raw = await readJson(path.resolve(intentPath));
    res = await applyIntent(raw, { eventSource: "intent:apply" });
    const registry_changes = [];
    if (res?.result?.added) registry_changes.push({ type: "case:add", case_id: res.result.added });
    if (res?.result?.updated) registry_changes.push({ type: "case:update", case_id: res.result.updated });

    report = buildReport({
      intent_id: res.intent.id,
      status: "applied",
      applied_actions: [res.intent.action],
      events_written: [eventRef(res.event, res.eventFile)],
      registry_changes,
    });
  } catch (error) {
    const intent_id = raw?.id ? String(raw.id) : `intent_error_${Date.now()}`;
    report = buildReport({
      intent_id,
      status: "error",
      applied_actions: ["intent:apply"],
      events_written: [],
      registry_changes: [],
      errors: [String(error?.message || error)],
    });
    await writeReportAndLog(report);
    throw error;
  }

  const { reportPath } = await writeReportAndLog(report);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ok: true, result: res.result, event: res.event, report: reportPath }, null, 2));
}

async function cmdIntentApplyV2(argv) {
  const args = parseArgs(argv);
  const intentPath = args.path || argv.find((a) => a && !a.startsWith("--"));
  if (!intentPath) throw new Error("Missing intent path. Usage: intent:apply-v2 <intent_v2.json>");

  let raw;
  try {
    raw = await readJson(path.resolve(intentPath));
  } catch (error) {
    const report = buildReport({
      intent_id: `intent_v2_parse_error_${Date.now()}`,
      status: "error",
      applied_actions: ["intent:apply-v2"],
      errors: [`invalid_json: ${String(error?.message || error)}`],
    });
    await writeReportAndLog(report);
    throw error;
  }

  const v2 = normalizeV2(raw);

  let mapping;
  try {
    validateV2(v2);
    mapping = mapV2ToInternal(v2);
  } catch (error) {
    mapping = { decision: "rejected", reason: String(error?.message || error) };
  }

  const status = mapping.decision === "rejected" ? "rejected" : "applied";

  const processedEventPayload = {
    v2_id: v2.id,
    v2_ts: v2.ts,
    v2_type: v2.type,
    status,
    decision: mapping.decision,
    reason: mapping.reason || null,
    mapped_action: mapping.internal?.action || null,
  };

  const processed = await appendEvent({
    ts: new Date().toISOString(),
    type: mapping.decision === "rejected" ? "intent.v2.rejected" : "intent.v2.processed",
    domain: "runtime",
    entity_id: v2.entity_id,
    source: "intent:apply-v2",
    payload: processedEventPayload,
  });

  const events_written = [eventRef(processed.event, processed.filePath)];
  const registry_changes = [];
  const applied_actions = [`v2:${v2.type}`];
  const warnings = [];
  const errors = [];

  let internalRes = null;
  if (mapping.decision === "mapped") {
    applied_actions.push(mapping.internal.action);
    try {
      internalRes = await applyIntent(mapping.internal, { eventSource: "intent:apply-v2" });
      events_written.push(eventRef(internalRes.event, internalRes.eventFile));
      if (internalRes?.result?.added) registry_changes.push({ type: "case:add", case_id: internalRes.result.added });
      if (internalRes?.result?.updated) registry_changes.push({ type: "case:update", case_id: internalRes.result.updated });
    } catch (error) {
      errors.push(String(error?.message || error));
    }
  } else if (mapping.decision === "noop") {
    applied_actions.push("noop");
    if (mapping.reason) warnings.push(mapping.reason);
  } else if (mapping.decision === "rejected") {
    if (mapping.reason) errors.push(mapping.reason);
  }

  const report = buildReport({
    intent_id: v2.id,
    status: errors.length > 0 && status !== "rejected" ? "error" : status,
    applied_actions,
    events_written,
    registry_changes,
    warnings,
    errors,
  });

  const { reportPath } = await writeReportAndLog(report);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ok: report.status === "applied", status: report.status, report: reportPath }, null, 2));
}

async function cmdEventsTail(argv) {
  const args = parseArgs(argv);
  const n = Number(args.n || 20);
  const res = await tailEvents({ n });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(res, null, 2));
}

async function cmdRagRebuild(argv) {
  const args = parseArgs(argv);
  const domainScope = args.domain || args.scope || null;
  const mockEmbeddings =
    args.mock_embeddings === "true" ||
    args.mock_embeddings === true ||
    args.mock_embeddings === "1" ||
    args.mock_embeddings === "yes" ||
    args.mock_embeddings === "on" ||
    args.mockEmbeddings === "true" ||
    args["mock-embeddings"] === "true";

  const res = await rebuildRagIndex({ mockEmbeddings, domainScope });

  try {
    const statePath = path.join(ROOT, "docs", "ACTIVE", "SETUP_STATE.json");
    const state = await readJson(statePath);
    const scopeKey = String(res.scope || "global")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const pointerKey =
      scopeKey && scopeKey !== "global"
        ? `rag_index_current_${scopeKey}`
        : "rag_index_current";
    const next = {
      ...state,
      [pointerKey]: res.currentValue,
      rag_index_current_updated_at: new Date().toISOString(),
    };
    await writeJson(statePath, next);
  } catch {
    // ignore
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(res, null, 2));
}

async function cmdSystemDoctor(argv) {
  const args = parseArgs(argv);
  const quick = args.quick === "true" || args.quick === true;
  const strictFlag = args.strict === "true" || args.strict === true;
  const strict = strictFlag || quick;
  const runTestsFlag = args.run_tests === "true" || args["run-tests"] === "true" || args.runTests === "true";
  const runTests = quick ? false : runTestsFlag;
  const writeProbe = args.write_probe === "true" || args["write-probe"] === "true" || args.writeProbe === "true";
  const res = await runSystemDoctor({ strict, quick, runTests, writeProbe });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(res, null, 2));
  if (!res.readiness) process.exitCode = 1;
}

async function cmdSystemMode(argv) {
  const args = parseArgs(argv);
  const mode = args.set;
  if (!mode) {
    throw new Error("Missing --set <test|staged>");
  }
  const res = await setSystemMode({ mode });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(res, null, 2));
}

async function cmdSystemPromote() {
  const res = await promoteSystem();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(res, null, 2));
  if (!res.ok) process.exitCode = 1;
}

function parseAutoCreateCase(argv) {
  const args = parseArgs(argv);
  const v = args.auto_create_case ?? args["auto-create-case"];
  return (
    v === "true" ||
    v === true ||
    v === "1" ||
    v === "yes" ||
    v === "on"
  );
}

async function cmdIngestOnce(argv) {
  const autoCreateCase = parseAutoCreateCase(argv);
  return ingestOnce({ autoCreateCase });
}

async function cmdIngestWatch(argv) {
  const autoCreateCase = parseAutoCreateCase(argv);
  return ingestWatch({ autoCreateCase });
}

async function cmdIngestRetry(argv) {
  const args = parseArgs(argv);
  const max = Number(args.max || 50);
  const dryRun = args.dry_run === "true" || args["dry-run"] === "true" || args.dryRun === "true";
  const olderThanRaw = args.older_than_minutes ?? args["older-than-minutes"] ?? null;
  const olderThanMinutes = olderThanRaw == null ? null : Number(olderThanRaw);
  const status = String(args.status || "queued");
  const res = await runIngestRetry({
    max,
    dryRun,
    olderThanMinutes,
    status,
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(res, null, 2));
}

async function cmdIngestReprocess(argv) {
  const args = parseArgs(argv);
  const max = Number(args.max || 50);
  const dryRun = args.dry_run === "true" || args["dry-run"] === "true" || args.dryRun === "true";
  const olderThanRaw = args.older_than_minutes ?? args["older-than-minutes"] ?? null;
  const olderThanMinutes = olderThanRaw == null ? null : Number(olderThanRaw);
  const onlyOpenAiErrors =
    args.only_openai_errors === "true"
    || args["only-openai-errors"] === "true"
    || args.onlyOpenaiErrors === "true";

  const res = await runIngestReprocess({
    max,
    dryRun,
    olderThanMinutes,
    onlyOpenAiErrors,
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(res, null, 2));
}

async function cmdCaseDashboard() {
  const res = await generateCaseDashboard();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(res, null, 2));
}

const ADMIN_COMMANDS = new Set([
  "ingest:once",
  "ingest:watch",
  "ingest:retry",
  "ingest:reprocess",
  "intent:apply",
  "intent:apply-v2",
  "events:tail",
  "rag:rebuild",
  "system:doctor",
  "system:mode",
  "system:promote",
  "case:dashboard",
]);

function isAdminCommand(cmd) {
  return ADMIN_COMMANDS.has(String(cmd || ""));
}

async function runAdminCommand(cmd, argv) {
  if (!cmd) {
    usage();
    return;
  }

  if (cmd === "ingest:once") return cmdIngestOnce(argv);
  if (cmd === "ingest:watch") return cmdIngestWatch(argv);
  if (cmd === "ingest:retry") return cmdIngestRetry(argv);
  if (cmd === "ingest:reprocess") return cmdIngestReprocess(argv);
  if (cmd === "intent:apply") return cmdIntentApply(argv);
  if (cmd === "intent:apply-v2") return cmdIntentApplyV2(argv);
  if (cmd === "events:tail") return cmdEventsTail(argv);
  if (cmd === "rag:rebuild") return cmdRagRebuild(argv);
  if (cmd === "system:doctor") return cmdSystemDoctor(argv);
  if (cmd === "system:mode") return cmdSystemMode(argv);
  if (cmd === "system:promote") return cmdSystemPromote();
  if (cmd === "case:dashboard") return cmdCaseDashboard();

  usage();
  process.exitCode = 1;
}

module.exports = {
  ADMIN_COMMANDS,
  isAdminCommand,
  runAdminCommand,
};
