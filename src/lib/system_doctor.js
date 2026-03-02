const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { ensureDir, pathExists, readJson, writeJson } = require("./fsx");
const { updateSetupState } = require("./setup_state");

const LAUNCHAGENT_LABEL = "com.companion.ingestwatch";

function nowIso() {
  return new Date().toISOString();
}

function tsCompact(iso = nowIso()) {
  const ymd = iso.slice(0, 10).replace(/-/g, "");
  const hms = iso.slice(11, 19).replace(/:/g, "");
  return `${ymd}T${hms}Z`;
}

function resolveRoot() {
  return process.env.COMPANION_ROOT
    ? path.resolve(process.env.COMPANION_ROOT)
    : process.cwd();
}

function resolveHome() {
  return process.env.COMPANION_HOME
    ? path.resolve(process.env.COMPANION_HOME)
    : os.homedir();
}

function parseMinNodeMajor(range) {
  const raw = String(range || "");
  const m = raw.match(/>=\s*(\d+)/);
  return m ? Number(m[1]) : 20;
}

function parseMockBool(value) {
  if (value == null) return null;
  const v = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return null;
}

function runCommand(cmd, args, { cwd, timeoutMs = 60_000, env = process.env } = {}) {
  return new Promise((resolve) => {
    const cp = spawn(cmd, args, { cwd, env });
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
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr,
        timedOut,
        error: String(error?.message || error),
      });
    });
    cp.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

async function checkNodeVersion(root) {
  const pkgPath = path.join(root, "package.json");
  let minMajor = 20;
  try {
    const pkg = await readJson(pkgPath);
    minMajor = parseMinNodeMajor(pkg?.engines?.node);
  } catch {
    // fallback to default
  }
  const currentMajor = Number(String(process.versions.node).split(".")[0] || 0);
  const ok = Number.isFinite(currentMajor) && currentMajor >= minMajor;
  return {
    ok,
    current: process.versions.node,
    required: `>=${minMajor}`,
  };
}

async function checkNpmTests({ root, runTests }) {
  if (!runTests) {
    return { ok: null, skipped: true };
  }
  const mock = String(process.env.COMPANION_DOCTOR_MOCK_TEST_RESULT || "").trim().toLowerCase();
  if (mock === "pass") return { ok: true, mocked: true };
  if (mock === "fail") return { ok: false, mocked: true, error: "mocked_test_failure" };

  const res = await runCommand("npm", ["test"], { cwd: root, timeoutMs: 20 * 60_000 });
  return {
    ok: !!res.ok,
    code: res.code,
    timedOut: !!res.timedOut,
    stdout_tail: String(res.stdout || "").split("\n").slice(-20).join("\n"),
    stderr_tail: String(res.stderr || "").split("\n").slice(-20).join("\n"),
    error: res.error || null,
  };
}

async function checkOpenAi({ timeoutMs = 8_000 }) {
  const keyPresent = !!process.env.OPENAI_API_KEY;
  const keyCheck = { ok: keyPresent };

  const mock = String(process.env.COMPANION_DOCTOR_OPENAI_MOCK || "").trim().toLowerCase();
  if (mock === "ok") {
    return { keyCheck, connectivityCheck: { ok: true, mocked: true } };
  }
  if (mock === "fail") {
    return { keyCheck, connectivityCheck: { ok: false, mocked: true, error: "mocked_openai_failure" } };
  }
  if (mock === "skip") {
    return { keyCheck, connectivityCheck: { ok: null, skipped: true, mocked: true } };
  }

  if (!keyPresent) {
    return { keyCheck, connectivityCheck: { ok: false, error: "OPENAI_API_KEY missing" } };
  }

  try {
    // eslint-disable-next-line global-require
    const OpenAI = require("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const probe = client.models.list();
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`timeout_after_${timeoutMs}ms`)), timeoutMs);
    });
    const resp = await Promise.race([probe, timeout]);
    const count = Array.isArray(resp?.data) ? resp.data.length : null;
    return { keyCheck, connectivityCheck: { ok: true, model_count: count } };
  } catch (error) {
    return {
      keyCheck,
      connectivityCheck: {
        ok: false,
        error: String(error?.message || error),
      },
    };
  }
}

async function checkRagCurrents(root) {
  const domains = ["jur", "fin", "allg"];
  const perDomain = {};
  let ok = true;
  for (const d of domains) {
    const currentFile = path.join(root, "40_rag_index", d, "CURRENT");
    const exists = await pathExists(currentFile);
    if (!exists) {
      perDomain[d] = { ok: false, current_file: path.relative(root, currentFile), error: "CURRENT missing" };
      ok = false;
      continue;
    }
    let currentValue = "";
    try {
      currentValue = String(await fs.readFile(currentFile, "utf8")).trim();
    } catch (error) {
      perDomain[d] = {
        ok: false,
        current_file: path.relative(root, currentFile),
        error: `read_failed: ${String(error?.message || error)}`,
      };
      ok = false;
      continue;
    }
    const buildPath = path.join(path.dirname(currentFile), currentValue);
    const buildExists = !!currentValue && await pathExists(buildPath);
    perDomain[d] = {
      ok: !!buildExists,
      current_file: path.relative(root, currentFile),
      current_value: currentValue || null,
      build_exists: !!buildExists,
      build_path: path.relative(root, buildPath),
    };
    if (!buildExists) ok = false;
  }
  return { ok, domains: perDomain };
}

async function checkLaunchAgentTemplate(root) {
  const plistPath = path.join(root, "runtime", "launchagent", `${LAUNCHAGENT_LABEL}.plist`);
  const installPath = path.join(root, "runtime", "launchagent", "install.command");
  const plistExists = await pathExists(plistPath);
  const installExists = await pathExists(installPath);
  return {
    ok: plistExists && installExists,
    plist_path: path.relative(root, plistPath),
    install_path: path.relative(root, installPath),
    plist_exists: plistExists,
    install_exists: installExists,
  };
}

async function checkLaunchAgentHostInstalled(home) {
  const mock = parseMockBool(process.env.COMPANION_DOCTOR_MOCK_LAUNCHAGENT_INSTALLED);
  const hostPlist = path.join(home, "Library", "LaunchAgents", `${LAUNCHAGENT_LABEL}.plist`);
  if (mock != null) {
    return { ok: mock, mocked: true, host_plist: hostPlist };
  }
  return {
    ok: await pathExists(hostPlist),
    host_plist: hostPlist,
  };
}

async function checkLaunchAgentServiceRunning({ hostInstalled }) {
  const mock = parseMockBool(process.env.COMPANION_DOCTOR_MOCK_LAUNCHAGENT_RUNNING);
  if (mock != null) return { ok: mock, mocked: true };
  if (!hostInstalled) return { ok: false, reason: "launchagent_not_installed" };

  const uid = String(process.getuid ? process.getuid() : "");
  const service = `gui/${uid}/${LAUNCHAGENT_LABEL}`;
  const res = await runCommand("launchctl", ["print", service], { timeoutMs: 8_000 });
  return {
    ok: !!res.ok,
    service,
    code: res.code,
    stdout_tail: String(res.stdout || "").split("\n").slice(-20).join("\n"),
    stderr_tail: String(res.stderr || "").split("\n").slice(-20).join("\n"),
    timedOut: !!res.timedOut,
    error: res.error || null,
  };
}

async function checkSandboxWriteBlock({ home, writeProbe }) {
  if (!writeProbe) return { ok: null, skipped: true, detected: null };
  const mock = parseMockBool(process.env.COMPANION_DOCTOR_MOCK_SANDBOX_BLOCK);
  if (mock != null) {
    return { ok: !mock, detected: mock, mocked: true };
  }

  const launchAgentsDir = path.join(home, "Library", "LaunchAgents");
  const probePath = path.join(launchAgentsDir, `.companion-doctor-probe-${Date.now()}.tmp`);
  try {
    await ensureDir(launchAgentsDir);
    await fs.writeFile(probePath, "probe\n", "utf8");
    await fs.unlink(probePath);
    return { ok: true, detected: false, probe_path: probePath };
  } catch (error) {
    const msg = String(error?.message || error);
    const detected =
      /operation not permitted|permission denied|eacces|eperm/i.test(msg) || true;
    return {
      ok: !detected,
      detected,
      probe_path: probePath,
      error: msg,
    };
  }
}

function addIf(arr, value) {
  if (value) arr.push(value);
}

function uniqueStrings(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function buildRecommendations(blockers) {
  const steps = [];
  const b = blockers.join("\n");

  if (/LaunchAgent not installed|LaunchAgent service not running|Sandbox write block/i.test(b)) {
    steps.push(
      "Installiere den LaunchAgent außerhalb der Sandbox im Host-Terminal: `cd ~/Documents/Companion && ./runtime/launchagent/install.command`.",
    );
    steps.push(
      "Prüfe anschließend den Dienststatus: `launchctl print gui/$(id -u)/com.companion.ingestwatch` und `tail -n 50 ~/Documents/Companion/90_logs/ingest-watch.log`.",
    );
  }
  if (/OPENAI_API_KEY missing|OpenAI connectivity check failed/i.test(b)) {
    steps.push("Setze einen gültigen `OPENAI_API_KEY` und prüfe Netzwerkzugriff auf die OpenAI API.");
  }
  if (/RAG domain CURRENT invalid/i.test(b)) {
    steps.push("Führe Domain-Rebuilds aus: `npm run rag:rebuild -- --domain jur`, `fin`, `allg`.");
  }
  if (/npm test failed|strict mode requires --run-tests/i.test(b)) {
    steps.push("Behebe Testfehler und führe `npm test` erneut aus.");
  }
  if (/Node version check failed/i.test(b)) {
    steps.push("Nutze eine Node-Version entsprechend `package.json -> engines.node`.");
  }
  return uniqueStrings(steps);
}

function buildDoctorSummaryLines({
  timestamp,
  readiness,
  mode,
  healthStatus,
  blockers,
  warnings,
  maxLines = 10,
}) {
  const lines = [];
  lines.push(`timestamp: ${timestamp}`);
  lines.push(`readiness: ${readiness ? "GREEN" : "RED"}`);
  lines.push(`mode: ${mode} health_status: ${healthStatus}`);
  lines.push(`blockers: ${blockers.length}`);
  for (const b of blockers) {
    lines.push(`- ${b}`);
  }
  lines.push(`warnings: ${warnings.length}`);
  for (const w of warnings) {
    lines.push(`- ${w}`);
  }
  if (lines.length <= maxLines) return lines;
  const truncated = lines.slice(0, maxLines);
  truncated[maxLines - 1] = "... (truncated)";
  return truncated;
}

async function runSystemDoctor({
  strict = false,
  runTests = false,
  quick = false,
  writeProbe = false,
} = {}) {
  const root = resolveRoot();
  const home = resolveHome();
  const quickMode = !!quick;
  const strictMode = !!strict || quickMode;
  const runTestsMode = quickMode ? false : !!runTests;

  const checks = {};
  checks.node_version_ok = await checkNodeVersion(root);
  checks.npm_test_pass = await checkNpmTests({ root, runTests: runTestsMode });

  const openAi = await checkOpenAi({});
  checks.openai_api_key_present = openAi.keyCheck;
  checks.openai_connectivity_ok = openAi.connectivityCheck;

  checks.rag_domain_current_ok = await checkRagCurrents(root);
  checks.launchagent_template_present = await checkLaunchAgentTemplate(root);
  checks.launchagent_host_installed = await checkLaunchAgentHostInstalled(home);
  checks.launchagent_service_running = await checkLaunchAgentServiceRunning({
    hostInstalled: !!checks.launchagent_host_installed.ok,
  });
  checks.sandbox_write_block_detected = await checkSandboxWriteBlock({ home, writeProbe });

  const blockers = [];
  const warnings = [];

  addIf(blockers, checks.node_version_ok.ok ? null : `Node version check failed (current=${checks.node_version_ok.current}, required=${checks.node_version_ok.required})`);

  if (checks.npm_test_pass.ok === false) {
    addIf(blockers, "npm test failed");
  } else if (checks.npm_test_pass.ok == null && runTestsMode) {
    addIf(blockers, "npm test did not run");
  }
  if (strictMode && !runTestsMode && !quickMode) {
    addIf(blockers, "strict mode requires --run-tests");
  }

  addIf(blockers, checks.openai_api_key_present.ok ? null : "OPENAI_API_KEY missing");
  if (checks.openai_connectivity_ok.ok === false) {
    addIf(blockers, `OpenAI connectivity check failed: ${checks.openai_connectivity_ok.error || "unknown_error"}`);
  } else if (checks.openai_connectivity_ok.ok == null) {
    addIf(warnings, "OpenAI connectivity check skipped");
  }

  addIf(blockers, checks.rag_domain_current_ok.ok ? null : "RAG domain CURRENT invalid or missing for one or more domains");
  addIf(blockers, checks.launchagent_template_present.ok ? null : "LaunchAgent template/install script missing");
  addIf(
    blockers,
    checks.launchagent_host_installed.ok
      ? null
      : `LaunchAgent not installed at ${checks.launchagent_host_installed.host_plist}`,
  );
  addIf(blockers, checks.launchagent_service_running.ok ? null : "LaunchAgent service not running");

  if (checks.sandbox_write_block_detected.detected === true) {
    addIf(
      blockers,
      `Sandbox write block detected for ~/Library/LaunchAgents (${checks.sandbox_write_block_detected.error || "write_failed"})`,
    );
  } else if (checks.sandbox_write_block_detected.ok == null) {
    addIf(warnings, "Sandbox write probe skipped (use --write-probe)");
  }

  const finalBlockers = uniqueStrings(blockers);
  const finalWarnings = uniqueStrings(warnings);
  const readiness = finalBlockers.length === 0;
  const doctorTs = nowIso();
  const reportRelPath = path.join("90_logs", "doctor", `${tsCompact(doctorTs)}.json`);
  const summaryRelPath = path.join("90_logs", "doctor", `${tsCompact(doctorTs)}.summary.txt`);
  const reportAbsPath = path.join(root, reportRelPath);
  const summaryAbsPath = path.join(root, summaryRelPath);

  const result = {
    root,
    home,
    strict: strictMode,
    quick: quickMode,
    run_tests: runTestsMode,
    write_probe: !!writeProbe,
    timestamp: doctorTs,
    readiness,
    blockers: finalBlockers,
    warnings: finalWarnings,
    checks,
    recommended_next_steps: buildRecommendations(finalBlockers),
  };

  await ensureDir(path.dirname(reportAbsPath));
  await writeJson(reportAbsPath, result);

  const health_status = readiness
    ? (finalWarnings.length > 0 ? "degraded" : "stable")
    : "blocked";

  const nextState = await updateSetupState({
    health_status,
    blockers: finalBlockers,
    last_doctor_run: doctorTs,
    last_doctor_result_path: reportRelPath,
  });

  const summaryLinesTxt = buildDoctorSummaryLines({
    timestamp: doctorTs,
    readiness,
    mode: nextState.mode,
    healthStatus: nextState.health_status,
    blockers: finalBlockers,
    warnings: finalWarnings,
    maxLines: 10,
  });
  await fs.writeFile(summaryAbsPath, `${summaryLinesTxt.join("\n")}\n`, "utf8");

  const summaryLines = [
    `Readiness: ${readiness ? "GREEN" : "RED"}`,
    `Blockers: ${finalBlockers.length}`,
    `Warnings: ${finalWarnings.length}`,
    `Report: ${reportRelPath}`,
  ];

  return {
    ...result,
    report_path: reportRelPath,
    summary_path: summaryRelPath,
    human_summary: summaryLines.join("\n"),
  };
}

module.exports = {
  runSystemDoctor,
};
