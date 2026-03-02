const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const { ROOT, DIRS } = require("../lib/config");
const {
  ensureDir,
  getUniquePath,
  listFiles,
  listFilesRecursive,
  pathExists,
  readJson,
  safeRelative,
  statSafe,
} = require("../lib/fsx");
const { loadSetupState } = require("../lib/setup_state");
const { loadRegistry } = require("../lib/registry");
const { normalizeLegalAreaToken, jurCaseBaseDir } = require("../lib/case_paths");
const { appendEvent } = require("../lib/events");
const { readJsonl, buildQueueState } = require("../lib/ingest_retry");
const { sanitizeForFilename } = require("../lib/sanitize");

const WATCHER_LABEL = "com.companion.ingestwatch";
const WATCHER_LOG = path.join(DIRS.logs, "ingest-watch.log");

const SCRIPT_DESCRIPTIONS = {
  "ingest:watch": "Startet den Live-Watcher für 00_inbox.",
  "ingest:once": "Verarbeitet alle aktuellen PDFs einmalig.",
  "ingest:retry": "Arbeitet retry_queue Einträge ab.",
  "ingest:reprocess": "Reklassifiziert REVIEW_REQUIRED PDFs.",
  "system:doctor": "Technischer Systemcheck (Basis).",
  "system:doctor:quick": "Schneller Doctor ohne Tests.",
  "system:doctor:full": "Voller Doctor inkl. Testlauf.",
  "system:promote": "Setzt Production nur bei grünem Doctor.",
  "system:mode": "Setzt test/staged Mode manuell.",
  "rag:rebuild": "RAG Index Rebuild (global oder pro Domain).",
  test: "Führt die gesamte Test-Suite aus.",
  "case:list": "Listet Cases aus der Registry.",
  "case:add": "Fügt einen Case hinzu.",
  "case:merge": "Merged zwei Cases inkl. Dateien.",
  "case:dashboard": "Erzeugt Case-Dashboard Export.",
  "intent:apply": "Wendet internes Intent JSON an.",
  "intent:apply-v2": "Wendet Companion JSON v2 Intent an.",
  "events:tail": "Zeigt letzte Runtime Events.",
};

const openAiProbeCache = {
  ts: 0,
  value: null,
};

const launchctlMockState = {
  running: false,
  pid: 42420,
};

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function parseBool(v) {
  if (v === true) return true;
  const s = String(v || "").toLowerCase();
  return ["1", "true", "yes", "on"].includes(s);
}

function useMockLaunchctl() {
  return parseBool(process.env.UI_SERVER_MOCK_LAUNCHCTL);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("invalid_json");
  }
}

function parseMultipart(req, bodyBuffer) {
  const contentType = req.headers["content-type"] || "";
  const m = String(contentType).match(/boundary=([^;]+)/i);
  if (!m) throw new Error("multipart_boundary_missing");
  const boundary = m[1];
  const marker = `--${boundary}`;
  const raw = bodyBuffer.toString("binary");

  const parts = raw.split(marker).slice(1, -1);
  const files = [];

  for (const p of parts) {
    const trimmed = p.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const headerEnd = trimmed.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;

    const headerRaw = trimmed.slice(0, headerEnd);
    const dataBinary = trimmed.slice(headerEnd + 4);
    const headers = headerRaw.split("\r\n");
    const disposition = headers.find((h) => /^content-disposition:/i.test(h)) || "";
    const filenameMatch = disposition.match(/filename="([^"]*)"/i);
    const nameMatch = disposition.match(/name="([^"]*)"/i);
    if (!filenameMatch) continue;

    const filename = filenameMatch[1] || "upload.pdf";
    const field = (nameMatch && nameMatch[1]) || "file";
    const contentTypeHeader = headers.find((h) => /^content-type:/i.test(h)) || "";
    const contentTypeValue = contentTypeHeader.split(":").slice(1).join(":").trim() || null;

    files.push({
      field,
      filename,
      contentType: contentTypeValue,
      buffer: Buffer.from(dataBinary, "binary"),
    });
  }

  return { files };
}

function safeUploadFilename(rawName) {
  const base = path.basename(String(rawName || "upload.pdf"));
  const noExt = base.replace(/\.pdf$/i, "");
  const safeStem = sanitizeForFilename(noExt)
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const stem = safeStem || "upload";
  return `${stem}.pdf`;
}

function extractCaseDomain(caseId) {
  const area = normalizeLegalAreaToken(caseId);
  if (area) return area;
  return "jur";
}

function getWatcherPaths() {
  const home = process.env.COMPANION_HOME ? path.resolve(process.env.COMPANION_HOME) : os.homedir();
  const uid = process.getuid ? String(process.getuid()) : "";
  return {
    home,
    uid,
    plistPath: path.join(home, "Library", "LaunchAgents", `${WATCHER_LABEL}.plist`),
    service: `gui/${uid}/${WATCHER_LABEL}`,
  };
}

async function countDirFilesByExt(baseDir, ext) {
  const files = await listFilesRecursive(baseDir).catch(() => []);
  return files.filter((f) => f.toLowerCase().endsWith(ext)).length;
}

async function maxMtimeMs(paths) {
  let max = 0;
  for (const p of paths) {
    const st = await statSafe(p);
    if (st && st.mtimeMs > max) max = st.mtimeMs;
  }
  return max || null;
}

function buildCaseBadges(caseData) {
  const badges = [];
  const total = Number(caseData.pdf_count || 0) + Number(caseData.md_count || 0) + Number(caseData.meta_count || 0);
  if (total === 0) badges.push("empty");
  if (Number(caseData.meta_count || 0) < Number(caseData.pdf_count || 0)) badges.push("meta_gap");
  if (caseData.last_updated) {
    const ageMs = Date.now() - Date.parse(caseData.last_updated);
    if (Number.isFinite(ageMs) && ageMs < 7 * 24 * 60 * 60 * 1000) badges.push("active_7d");
  }
  return badges;
}

async function getCaseOverview(root) {
  const registry = await loadRegistry();
  const reviewRequiredCount = await countDirFilesByExt(DIRS.reviewRequired, ".pdf");
  const queues = await getQueueStats();

  const cases = [];
  for (const c of registry.cases || []) {
    if (!c || !c.case_id || c.archived) continue;
    const caseId = String(c.case_id);
    const rechtsgebiet = normalizeLegalAreaToken(caseId) || null;
    const domain = rechtsgebiet || "jur";
    const baseDir = jurCaseBaseDir(DIRS.processedJurCases, caseId);
    const pdfDir = path.join(baseDir, "pdf");
    const mdDir = path.join(baseDir, "md");
    const metaDir = path.join(baseDir, "meta");

    const [pdfCount, mdCount, metaCount] = await Promise.all([
      countDirFilesByExt(pdfDir, ".pdf"),
      countDirFilesByExt(mdDir, ".md"),
      countDirFilesByExt(metaDir, ".json"),
    ]);

    const allFiles = [
      ...(await listFilesRecursive(pdfDir).catch(() => [])),
      ...(await listFilesRecursive(mdDir).catch(() => [])),
      ...(await listFilesRecursive(metaDir).catch(() => [])),
    ];
    const latestMtime = await maxMtimeMs(allFiles);

    const item = {
      case_id: caseId,
      title: c.title || caseId,
      domain,
      rechtsgebiet,
      tags: Array.isArray(c.tags) ? c.tags : [],
      aliases: Array.isArray(c.aliases) ? c.aliases : [],
      pdf_count: pdfCount,
      md_count: mdCount,
      meta_count: metaCount,
      last_updated: latestMtime ? new Date(latestMtime).toISOString() : null,
      base_path: safeRelative(root, baseDir),
    };
    item.badges = buildCaseBadges(item);
    cases.push(item);
  }

  cases.sort((a, b) => String(a.case_id).localeCompare(String(b.case_id)));
  return {
    cases,
    review_required_count: reviewRequiredCount,
    retry_queue_count: queues.retry_queue_count,
    retry_failed_count: queues.retry_failed_count,
    updated_at: new Date().toISOString(),
  };
}

async function getCaseFiles(root, caseId, type) {
  const safeType = ["pdf", "md", "meta", "all"].includes(type) ? type : "pdf";
  const baseDir = jurCaseBaseDir(DIRS.processedJurCases, caseId);
  const targets = safeType === "all"
    ? ["pdf", "md", "meta"]
    : [safeType];

  const out = [];
  for (const t of targets) {
    const dir = path.join(baseDir, t);
    const files = await listFilesRecursive(dir).catch(() => []);
    for (const f of files) {
      const st = await statSafe(f);
      if (!st || !st.isFile()) continue;
      out.push({
        name: path.basename(f),
        type: t,
        size: st.size,
        mtime: new Date(st.mtimeMs).toISOString(),
        path: safeRelative(root, f),
      });
    }
  }

  out.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  return {
    case_id: caseId,
    type: safeType,
    files: out,
  };
}

async function tailEventsAll(limit = 200, caseId = null) {
  const max = Math.max(1, Number(limit) || 200);
  const files = (await listFiles(DIRS.events).catch(() => []))
    .filter((f) => f.toLowerCase().endsWith(".jsonl"))
    .sort();

  const events = [];
  for (const f of files) {
    const raw = await fs.readFile(f, "utf8").catch(() => "");
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        events.push(JSON.parse(s));
      } catch {
        // ignore malformed
      }
    }
  }

  let out = events;
  if (caseId) {
    const needle = String(caseId);
    out = out.filter((ev) => {
      if (String(ev?.entity_id || "") === needle) return true;
      if (String(ev?.payload?.case_id || "") === needle) return true;
      const payloadTxt = JSON.stringify(ev?.payload || {});
      return payloadTxt.includes(needle);
    });
  }

  return out.slice(Math.max(0, out.length - max));
}

async function listRuntimeReports(root, caseId = null, limit = 200) {
  const dir = path.join(DIRS.runtime, "reports");
  const files = await listFilesRecursive(dir).catch(() => []);
  const out = [];

  for (const f of files) {
    if (!f.toLowerCase().endsWith(".json")) continue;
    const st = await statSafe(f);
    if (!st || !st.isFile()) continue;

    let include = true;
    if (caseId) {
      const raw = await fs.readFile(f, "utf8").catch(() => "");
      include = raw.includes(String(caseId));
    }
    if (!include) continue;

    out.push({
      name: path.basename(f),
      size: st.size,
      mtime: new Date(st.mtimeMs).toISOString(),
      path: safeRelative(root, f),
    });
  }

  out.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  return out.slice(0, Math.max(1, Number(limit) || 200));
}

function runCommand(cmd, args, { cwd = ROOT, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const cp = spawn(cmd, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      cp.kill("SIGTERM");
    }, timeoutMs);

    cp.stdout.on("data", (d) => { stdout += String(d); });
    cp.stderr.on("data", (d) => { stderr += String(d); });
    cp.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr, timedOut, error: String(error?.message || error) });
    });
    cp.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut, error: null });
    });
  });
}

async function runLaunchctl(args, { timeoutMs = 8_000 } = {}) {
  if (!useMockLaunchctl()) {
    return runCommand("launchctl", args, { timeoutMs });
  }

  const joined = args.join(" ");
  if (args[0] === "print") {
    if (launchctlMockState.running) {
      return {
        ok: true,
        code: 0,
        stdout: `service = ${args[1]}\npid = ${launchctlMockState.pid}\nstate = running\n`,
        stderr: "",
        timedOut: false,
        error: null,
      };
    }
    return {
      ok: false,
      code: 113,
      stdout: "",
      stderr: `Could not find service "${args[1]}"`,
      timedOut: false,
      error: null,
    };
  }

  if (args[0] === "bootstrap" || args[0] === "enable" || args[0] === "kickstart") {
    launchctlMockState.running = true;
    launchctlMockState.pid += 1;
    return {
      ok: true,
      code: 0,
      stdout: `[mock launchctl] ${joined}`,
      stderr: "",
      timedOut: false,
      error: null,
    };
  }

  if (args[0] === "bootout") {
    if (launchctlMockState.running) {
      launchctlMockState.running = false;
      return {
        ok: true,
        code: 0,
        stdout: `[mock launchctl] ${joined}`,
        stderr: "",
        timedOut: false,
        error: null,
      };
    }
    return {
      ok: false,
      code: 3,
      stdout: "",
      stderr: "Could not find service",
      timedOut: false,
      error: null,
    };
  }

  return {
    ok: false,
    code: 1,
    stdout: "",
    stderr: `[mock launchctl] unsupported args: ${joined}`,
    timedOut: false,
    error: null,
  };
}

function extractLastJsonObject(output) {
  const text = String(output || "").trim();
  if (!text) return null;
  const start = text.lastIndexOf("\n{") >= 0 ? text.lastIndexOf("\n{") + 1 : text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  const candidate = text.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

async function runNpmJson(scriptName, extraArgs = [], { timeoutMs = 10 * 60_000 } = {}) {
  const args = ["run", "--silent", scriptName, ...(extraArgs.length > 0 ? ["--", ...extraArgs] : [])];
  const res = await runCommand("npm", args, { cwd: ROOT, timeoutMs });
  const payload = extractLastJsonObject(res.stdout) || extractLastJsonObject(res.stderr);
  return {
    ok: res.ok,
    code: res.code,
    timedOut: res.timedOut,
    error: res.error,
    stdout: res.stdout,
    stderr: res.stderr,
    json: payload,
  };
}

async function tailFile(filePath, lineLimit = 50) {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  const lines = raw.split("\n").filter(Boolean);
  return lines.slice(Math.max(0, lines.length - lineLimit)).join("\n");
}

async function probeOpenAiQuick({ timeoutMs = 2500 } = {}) {
  const now = Date.now();
  if (openAiProbeCache.value && (now - openAiProbeCache.ts) < 30_000) {
    return openAiProbeCache.value;
  }

  if (!process.env.OPENAI_API_KEY) {
    const v = { ok: false, skipped: true, reason: "api_key_missing" };
    openAiProbeCache.ts = now;
    openAiProbeCache.value = v;
    return v;
  }

  try {
    // eslint-disable-next-line global-require
    const OpenAI = require("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`timeout_after_${timeoutMs}ms`)), timeoutMs);
    });
    await Promise.race([client.models.list(), timeout]);
    const v = { ok: true, skipped: false };
    openAiProbeCache.ts = now;
    openAiProbeCache.value = v;
    return v;
  } catch (error) {
    const v = { ok: false, skipped: false, error: String(error?.message || error) };
    openAiProbeCache.ts = now;
    openAiProbeCache.value = v;
    return v;
  }
}

function parseWatcherPid(output) {
  const m = String(output || "").match(/\bpid\s*=\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

async function getWatcherStatusDetailed() {
  const { service } = getWatcherPaths();
  const res = await runLaunchctl(["print", service], { timeoutMs: 4_000 });
  const stdout = String(res.stdout || "");
  const stderr = String(res.stderr || "");
  const pid = parseWatcherPid(stdout);
  const running = !!res.ok || pid != null;

  return {
    running,
    label: WATCHER_LABEL,
    service,
    pid,
    code: res.code,
    error: res.error,
    ok: running,
    stdout,
    stderr,
    stdout_tail: stdout.split("\n").slice(-12).join("\n"),
    stderr_tail: stderr.split("\n").slice(-12).join("\n"),
    last_log_tail: await tailFile(WATCHER_LOG, 20),
  };
}

function launchctlErrorIsIdempotent(msg) {
  return /already loaded|already exists|service is disabled|not found|no such process|could not find service|does not exist/i.test(String(msg || ""));
}

async function watcherStart() {
  const { uid, plistPath, service } = getWatcherPaths();
  const out = { commands: [], ok: true, message: null, stdout: "", stderr: "" };

  if (!(await pathExists(plistPath))) {
    return {
      ok: false,
      message: `LaunchAgent plist missing: ${plistPath}`,
      commands: [],
      watcher: await getWatcherStatusDetailed(),
    };
  }

  const cmds = [
    ["launchctl", ["bootstrap", `gui/${uid}`, plistPath]],
    ["launchctl", ["enable", service]],
    ["launchctl", ["kickstart", "-k", service]],
  ];

  for (const [cmd, args] of cmds) {
    const run = cmd === "launchctl"
      ? await runLaunchctl(args, { timeoutMs: 8_000 })
      : await runCommand(cmd, args, { timeoutMs: 8_000 });
    out.commands.push({ cmd, args, ...run });
    out.stdout += `${run.stdout || ""}\n`;
    out.stderr += `${run.stderr || ""}\n`;
    if (!run.ok) {
      const errMsg = `${run.error || ""}\n${run.stderr || ""}`;
      if (!launchctlErrorIsIdempotent(errMsg)) {
        out.ok = false;
      }
    }
  }

  out.watcher = await getWatcherStatusDetailed();
  out.ok = out.ok && !!out.watcher.running;
  out.running = !!out.watcher.running;
  out.message = out.ok ? "watcher_started_or_already_running" : "watcher_start_failed";
  return out;
}

async function watcherStop() {
  const { service } = getWatcherPaths();
  const run = await runLaunchctl(["bootout", service], { timeoutMs: 8_000 });
  const errMsg = `${run.error || ""}\n${run.stderr || ""}`;
  const idempotent = !run.ok && launchctlErrorIsIdempotent(errMsg);
  const watcher = await getWatcherStatusDetailed();

  return {
    ok: run.ok || idempotent || !watcher.running,
    running: watcher.running,
    stdout: String(run.stdout || ""),
    stderr: String(run.stderr || ""),
    message: run.ok || idempotent ? "watcher_stopped_or_not_running" : "watcher_stop_failed",
    command: { cmd: "launchctl", args: ["bootout", service], ...run },
    watcher,
  };
}

async function getQueueStats() {
  const retryQueuePath = path.join(DIRS.runtime, "retry_queue.jsonl");
  const reviewRequiredCount = await countDirFilesByExt(DIRS.reviewRequired, ".pdf");

  const lines = await readJsonl(retryQueuePath).catch(() => []);
  const state = buildQueueState(lines);
  const retryQueued = state.filter((e) => String(e.status || "") === "queued").length;
  const retryFailed = state.filter((e) => String(e.status || "") === "failed").length;

  return {
    retry_queue_count: retryQueued,
    retry_failed_count: retryFailed,
    review_required_count: reviewRequiredCount,
    retry_queue_path: safeRelative(ROOT, retryQueuePath),
  };
}

async function getScriptsOverview() {
  const pkgPath = path.join(ROOT, "package.json");
  const pkg = await readJson(pkgPath).catch(() => ({ scripts: {} }));
  const scripts = pkg && pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};

  const out = Object.keys(scripts)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      command: scripts[name],
      description: SCRIPT_DESCRIPTIONS[name] || "Kein Beschreibungstext hinterlegt.",
    }));

  return {
    count: out.length,
    scripts: out,
  };
}

async function getHealthPayload() {
  const state = await loadSetupState();
  const watcher = await getWatcherStatusDetailed();
  const queues = await getQueueStats();
  const connectivity = await probeOpenAiQuick({ timeoutMs: 1800 });

  return {
    mode: state.mode,
    health_status: state.health_status,
    blockers: state.blockers || [],
    watcher,
    queues,
    openai: {
      api_key_present: !!process.env.OPENAI_API_KEY,
      connectivity,
    },
    setup_state_path: safeRelative(ROOT, path.join(ROOT, "docs", "ACTIVE", "SETUP_STATE.json")),
    updated_at: new Date().toISOString(),
  };
}

async function getOverviewPayload(root) {
  const [state, queues, watcher, connectivity] = await Promise.all([
    loadSetupState(),
    getQueueStats(),
    getWatcherStatusDetailed(),
    probeOpenAiQuick({ timeoutMs: 1800 }),
  ]);

  return {
    mode: state.mode,
    health_status: state.health_status,
    openai_ok: !!connectivity.ok,
    review_required_count: queues.review_required_count,
    retry_queue_count: queues.retry_queue_count,
    watcher_running: !!watcher.running,
    updated_at: new Date().toISOString(),
    setup_state_path: safeRelative(root, path.join(root, "docs", "ACTIVE", "SETUP_STATE.json")),
  };
}

async function getRecentDoctorReports(root, limit = 5) {
  const doctorDir = path.join(DIRS.logs, "doctor");
  const files = (await listFiles(doctorDir).catch(() => []))
    .filter((f) => f.endsWith(".json"))
    .sort((a, b) => b.localeCompare(a))
    .slice(0, Math.max(1, Number(limit) || 5));

  const reports = [];
  for (const file of files) {
    const st = await statSafe(file);
    const report = await readJson(file).catch(() => null);
    const summaryFile = file.replace(/\.json$/i, ".summary.txt");
    const summary = await fs.readFile(summaryFile, "utf8").catch(() => null);
    reports.push({
      file: safeRelative(root, file),
      summary_file: safeRelative(root, summaryFile),
      ts: report?.timestamp || (st ? new Date(st.mtimeMs).toISOString() : null),
      readiness: report?.readiness ?? null,
      blocker_count: Array.isArray(report?.blockers) ? report.blockers.length : null,
      warning_count: Array.isArray(report?.warnings) ? report.warnings.length : null,
      summary: summary ? summary.trim() : null,
    });
  }

  return {
    count: reports.length,
    reports,
  };
}

async function getReviewList(root) {
  const files = await listFilesRecursive(DIRS.reviewRequired).catch(() => []);
  const out = [];
  for (const f of files) {
    if (!f.toLowerCase().endsWith(".pdf")) continue;
    const st = await statSafe(f);
    if (!st || !st.isFile()) continue;
    out.push({
      name: path.basename(f),
      size: st.size,
      mtime: new Date(st.mtimeMs).toISOString(),
      path: safeRelative(root, f),
    });
  }
  out.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  return {
    count: out.length,
    files: out,
  };
}

async function getRetryQueuePayload(root) {
  const retryQueuePath = path.join(DIRS.runtime, "retry_queue.jsonl");
  const lines = await readJsonl(retryQueuePath).catch(() => []);
  const state = buildQueueState(lines);
  const summary = {
    queued: 0,
    failed: 0,
    resolved: 0,
    dropped_missing_source: 0,
    other: 0,
  };
  for (const entry of state) {
    const key = String(entry?.status || "other");
    if (Object.prototype.hasOwnProperty.call(summary, key)) summary[key] += 1;
    else summary.other += 1;
  }

  return {
    path: safeRelative(root, retryQueuePath),
    total_raw_entries: lines.length,
    current_entries: state.length,
    summary,
    entries: state.slice(-100),
  };
}

async function writeChatIntent(message) {
  await ensureDir(DIRS.intents);
  const ts = new Date().toISOString();
  const id = `chat_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const lower = String(message || "").toLowerCase();
  const type = /dashboard|status|cases|f(a|ä)lle/.test(lower)
    ? "SHOW_DASHBOARD"
    : "UPDATE_DASHBOARD_DATA";

  const intent = {
    schema: "companion-json-v2",
    id,
    ts,
    type,
    payload: {
      message: String(message || "").slice(0, 2000),
    },
    source: "ui-chat",
    status: "new",
  };

  const fileName = `${id}.json`;
  const full = path.join(DIRS.intents, fileName);
  await fs.writeFile(full, `${JSON.stringify(intent, null, 2)}\n`, "utf8");
  return { id, type, file: full };
}

function contentTypeByExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".md") return "text/markdown; charset=utf-8";
  if (ext === ".pdf") return "application/pdf";
  return "application/octet-stream";
}

function resolveSafeRepoPath(root, relPath) {
  const abs = path.resolve(root, String(relPath || ""));
  if (!abs.startsWith(path.resolve(root) + path.sep)) return null;
  return abs;
}

async function serveRepoFile(req, res, root) {
  const u = new URL(req.url, "http://127.0.0.1");
  const rel = u.searchParams.get("path");
  if (!rel) {
    json(res, 400, { ok: false, error: "path_required" });
    return;
  }

  const abs = resolveSafeRepoPath(root, rel);
  if (!abs) {
    json(res, 400, { ok: false, error: "invalid_path" });
    return;
  }

  const st = await statSafe(abs);
  if (!st || !st.isFile()) {
    json(res, 404, { ok: false, error: "file_not_found" });
    return;
  }

  const data = await fs.readFile(abs);
  res.writeHead(200, {
    "Content-Type": contentTypeByExt(abs),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

async function serveStatic(req, res, { uiDir }) {
  const reqPath = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
  let filePath;

  if (reqPath === "/" || reqPath === "") {
    filePath = path.join(uiDir, "index.html");
  } else {
    const safePath = reqPath.replace(/^\/+/, "");
    filePath = path.join(uiDir, safePath);
  }

  if (!(await pathExists(filePath))) {
    text(res, 404, "Not found");
    return;
  }

  const st = await statSafe(filePath);
  if (!st || !st.isFile()) {
    text(res, 404, "Not found");
    return;
  }

  const data = await fs.readFile(filePath);
  res.writeHead(200, {
    "Content-Type": contentTypeByExt(filePath),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function sseWrite(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function buildActionResponse(run, fallback = {}) {
  return {
    ok: run.ok,
    code: run.code,
    timed_out: run.timedOut,
    error: run.error,
    stdout: String(run.stdout || ""),
    stderr: String(run.stderr || ""),
    result: run.json || null,
    ...fallback,
  };
}

async function createApiHandler({ root = ROOT, uiDir }) {
  async function handleHealth(_req, res) {
    const payload = await getHealthPayload();
    json(res, 200, payload);
  }

  async function handleScripts(_req, res) {
    const payload = await getScriptsOverview();
    json(res, 200, payload);
  }

  async function handleOverview(_req, res) {
    const payload = await getOverviewPayload(root);
    json(res, 200, payload);
  }

  async function handleDoctorRecent(req, res) {
    const u = new URL(req.url, "http://127.0.0.1");
    const limit = Number(u.searchParams.get("limit") || 5);
    const payload = await getRecentDoctorReports(root, limit);
    json(res, 200, payload);
  }

  async function handleReviewList(_req, res) {
    const payload = await getReviewList(root);
    json(res, 200, payload);
  }

  async function handleRetryQueue(_req, res) {
    const payload = await getRetryQueuePayload(root);
    json(res, 200, payload);
  }

  async function handleWatcherStatus(_req, res) {
    const payload = await getWatcherStatusDetailed();
    json(res, 200, payload);
  }

  async function handleWatcherStart(_req, res) {
    const payload = await watcherStart();
    json(res, payload.ok ? 200 : 409, payload);
  }

  async function handleWatcherStop(_req, res) {
    const payload = await watcherStop();
    json(res, payload.ok ? 200 : 409, payload);
  }

  async function handleQueues(_req, res) {
    const payload = await getQueueStats();
    json(res, 200, payload);
  }

  async function handleCases(_req, res) {
    const payload = await getCaseOverview(root);
    json(res, 200, payload);
  }

  async function handleCaseFiles(req, res, caseId) {
    const u = new URL(req.url, "http://127.0.0.1");
    const type = u.searchParams.get("type") || "pdf";
    const payload = await getCaseFiles(root, caseId, type);
    json(res, 200, payload);
  }

  async function handleEvents(req, res) {
    const u = new URL(req.url, "http://127.0.0.1");
    const limit = Number(u.searchParams.get("limit") || 200);
    const caseId = u.searchParams.get("case_id") || null;
    const events = await tailEventsAll(limit, caseId);
    json(res, 200, { limit, count: events.length, case_id: caseId, events });
  }

  async function handleReports(req, res) {
    const u = new URL(req.url, "http://127.0.0.1");
    const limit = Number(u.searchParams.get("limit") || 200);
    const caseId = u.searchParams.get("case_id") || null;
    const reports = await listRuntimeReports(root, caseId, limit);
    json(res, 200, {
      count: reports.length,
      case_id: caseId,
      reports,
    });
  }

  async function handleDoctor(req, res) {
    const body = await readJsonBody(req);
    const mode = String(body.mode || "quick").toLowerCase();
    const run = mode === "full"
      ? await runNpmJson("system:doctor:full")
      : await runNpmJson("system:doctor:quick");

    const payload = buildActionResponse(run, { mode });
    if (run.json) {
      payload.readiness = run.json.readiness;
      payload.report_path = run.json.report_path;
      payload.summary_path = run.json.summary_path;
      payload.human_summary = run.json.human_summary;
    }
    json(res, run.ok ? 200 : 409, payload);
  }

  async function handlePromote(_req, res) {
    const run = await runNpmJson("system:promote", [], { timeoutMs: 20 * 60_000 });
    json(res, run.ok ? 200 : 409, buildActionResponse(run));
  }

  async function handleRetry(req, res) {
    const body = await readJsonBody(req);
    const args = ["--max", String(Number(body.max || 50))];
    if (body.older_than_minutes != null) {
      args.push("--older-than-minutes", String(Number(body.older_than_minutes)));
    }
    const run = await runNpmJson("ingest:retry", args, { timeoutMs: 20 * 60_000 });
    json(res, run.ok ? 200 : 409, buildActionResponse(run));
  }

  async function handleReprocess(req, res) {
    const body = await readJsonBody(req);
    const args = ["--max", String(Number(body.max || 50))];
    if (body.older_than_minutes != null) {
      args.push("--older-than-minutes", String(Number(body.older_than_minutes)));
    }
    if (parseBool(body.only_openai_errors)) {
      args.push("--only-openai-errors", "true");
    }
    const run = await runNpmJson("ingest:reprocess", args, { timeoutMs: 20 * 60_000 });
    json(res, run.ok ? 200 : 409, buildActionResponse(run));
  }

  async function handleRagRebuild(req, res) {
    const body = await readJsonBody(req);
    const args = [];
    if (body.domain) {
      args.push("--domain", String(body.domain));
    }
    if (parseBool(body.mock_embeddings)) {
      args.push("--mock-embeddings", "true");
    }
    const run = await runNpmJson("rag:rebuild", args, { timeoutMs: 30 * 60_000 });
    json(res, run.ok ? 200 : 409, buildActionResponse(run));
  }

  async function handleTest(_req, res) {
    const run = await runNpmJson("test", [], { timeoutMs: 30 * 60_000 });
    json(res, run.ok ? 200 : 409, buildActionResponse(run));
  }

  async function handleUpload(req, res) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    const parsed = parseMultipart(req, body);
    const file = parsed.files.find((f) => f.field === "file") || parsed.files[0];
    if (!file) {
      json(res, 400, { ok: false, error: "file_missing" });
      return;
    }

    const contentType = String(file.contentType || "").toLowerCase();
    const nameLower = String(file.filename || "").toLowerCase();
    if (!nameLower.endsWith(".pdf") && !contentType.includes("pdf")) {
      json(res, 400, { ok: false, error: "only_pdf_allowed" });
      return;
    }

    await ensureDir(DIRS.inbox);
    const safeName = safeUploadFilename(file.filename);
    const dest = await getUniquePath(path.join(DIRS.inbox, safeName));
    await fs.writeFile(dest, file.buffer);

    await appendEvent({
      type: "ui.upload",
      domain: "runtime",
      source: "ui-server",
      payload: {
        filename: path.basename(dest),
        path: safeRelative(root, dest),
        size: file.buffer.length,
      },
    });

    json(res, 200, {
      ok: true,
      file: path.basename(dest),
      path: safeRelative(root, dest),
      size: file.buffer.length,
    });
  }

  async function handleChat(req, res) {
    const body = await readJsonBody(req);
    const message = String(body.message || "").trim();
    if (!message) {
      json(res, 400, { ok: false, error: "message_required" });
      return;
    }

    const intent = await writeChatIntent(message);
    const [health, queues, events] = await Promise.all([
      getHealthPayload(),
      getQueueStats(),
      tailEventsAll(5),
    ]);

    const reply = [
      `Intent gespeichert: ${path.basename(intent.file)} (${intent.type})`,
      `Mode: ${health.mode}, Health: ${health.health_status}`,
      `Watcher: ${health.watcher.running ? "ON" : "OFF"}`,
      `Queue: ${queues.retry_queue_count} queued / Review: ${queues.review_required_count}`,
      `Letzte Events: ${events.length}`,
    ].join("\n");

    json(res, 200, {
      ok: true,
      intent_id: intent.id,
      intent_type: intent.type,
      intent_file: safeRelative(root, intent.file),
      reply,
    });
  }

  async function handleStream(_req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    const sendSnapshot = async () => {
      const [health, cases, queues, events] = await Promise.all([
        getHealthPayload(),
        getCaseOverview(root),
        getQueueStats(),
        tailEventsAll(20),
      ]);
      sseWrite(res, "snapshot", {
        ts: new Date().toISOString(),
        health,
        queues,
        cases: {
          count: cases.cases.length,
          review_required_count: cases.review_required_count,
          retry_queue_count: cases.retry_queue_count,
        },
        events,
      });
    };

    await sendSnapshot();
    const interval = setInterval(() => {
      sendSnapshot().catch((error) => {
        sseWrite(res, "error", { error: String(error?.message || error) });
      });
    }, 2000);

    const close = () => {
      clearInterval(interval);
      try {
        res.end();
      } catch {
        // ignore
      }
    };

    res.on("close", close);
    res.on("error", close);
  }

  return async function handle(req, res) {
    try {
      const u = new URL(req.url, "http://127.0.0.1");
      const method = req.method || "GET";
      const pathname = u.pathname;

      if (method === "GET" && pathname === "/api/health") return handleHealth(req, res);
      if (method === "GET" && pathname === "/api/overview") return handleOverview(req, res);
      if (method === "GET" && pathname === "/api/scripts") return handleScripts(req, res);
      if (method === "GET" && pathname === "/api/doctor/recent") return handleDoctorRecent(req, res);
      if (method === "GET" && pathname === "/api/review/list") return handleReviewList(req, res);
      if (method === "GET" && pathname === "/api/retry/queue") return handleRetryQueue(req, res);
      if (method === "GET" && pathname === "/api/watcher/status") return handleWatcherStatus(req, res);
      if (method === "POST" && pathname === "/api/watcher/start") return handleWatcherStart(req, res);
      if (method === "POST" && pathname === "/api/watcher/stop") return handleWatcherStop(req, res);
      if (method === "GET" && pathname === "/api/queues") return handleQueues(req, res);

      if (method === "GET" && pathname === "/api/cases") return handleCases(req, res);
      if (method === "GET" && pathname.startsWith("/api/case/")) {
        const m = pathname.match(/^\/api\/case\/([^/]+)\/files$/);
        if (m) return handleCaseFiles(req, res, decodeURIComponent(m[1]));
      }
      if (method === "GET" && pathname === "/api/events") return handleEvents(req, res);
      if (method === "GET" && pathname === "/api/reports") return handleReports(req, res);
      if (method === "GET" && pathname === "/api/file") return serveRepoFile(req, res, root);
      if (method === "GET" && pathname === "/api/stream") return handleStream(req, res);

      if (method === "POST" && pathname === "/api/actions/doctor") return handleDoctor(req, res);
      if (method === "POST" && pathname === "/api/actions/promote") return handlePromote(req, res);
      if (method === "POST" && pathname === "/api/actions/retry") return handleRetry(req, res);
      if (method === "POST" && pathname === "/api/actions/reprocess") return handleReprocess(req, res);
      if (method === "POST" && pathname === "/api/actions/rag-rebuild") return handleRagRebuild(req, res);
      if (method === "POST" && pathname === "/api/actions/test") return handleTest(req, res);
      if (method === "POST" && pathname === "/api/upload") return handleUpload(req, res);
      if (method === "POST" && pathname === "/api/chat") return handleChat(req, res);

      return serveStatic(req, res, { uiDir });
    } catch (error) {
      return json(res, 500, {
        ok: false,
        error: String(error?.message || error),
      });
    }
  };
}

async function createUiServer({ root = ROOT, host = "127.0.0.1", port = 3210 } = {}) {
  const uiDir = path.join(root, "ui");
  await ensureDir(uiDir);
  const handler = await createApiHandler({ root, uiDir });
  const server = http.createServer((req, res) => {
    handler(req, res).catch((error) => {
      json(res, 500, { ok: false, error: String(error?.message || error) });
    });
  });

  return {
    server,
    async listen() {
      await new Promise((resolve) => server.listen(port, host, resolve));
      return server.address();
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function startUiServer() {
  const host = process.env.UI_HOST || "127.0.0.1";
  const port = Number(process.env.UI_PORT || 3210);
  const ui = await createUiServer({ root: ROOT, host, port });
  const addr = await ui.listen();
  // eslint-disable-next-line no-console
  console.log(`[ui-server] listening on http://${host}:${addr.port}`);
}

if (require.main === module) {
  startUiServer().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error?.stack || error);
    process.exit(1);
  });
}

module.exports = {
  createUiServer,
  getCaseOverview,
  getScriptsOverview,
  getWatcherStatusDetailed,
};
