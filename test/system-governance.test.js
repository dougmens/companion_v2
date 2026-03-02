const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const CLI_PATH = path.join(__dirname, "..", "src", "cli.js");

async function mkTmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function setupGovernanceFixture(root) {
  await writeJson(path.join(root, "package.json"), {
    name: "fixture",
    version: "1.0.0",
    private: true,
    engines: { node: ">=20" },
    scripts: { test: "node --test" },
  });

  await writeJson(path.join(root, "docs", "ACTIVE", "SETUP_STATE.json"), {
    version: "local-v1",
    mode: "test",
    watcher_configured: false,
    reset_required_before_go_live: true,
    rag_index_current: null,
  });

  await fs.mkdir(path.join(root, "runtime", "launchagent"), { recursive: true });
  await fs.writeFile(
    path.join(root, "runtime", "launchagent", "com.companion.ingestwatch.plist"),
    "<plist/>",
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "runtime", "launchagent", "install.command"),
    "#!/bin/zsh\necho install\n",
    "utf8",
  );

  const ts = "20260302T000000Z";
  for (const d of ["jur", "fin", "allg"]) {
    const domainDir = path.join(root, "40_rag_index", d);
    await fs.mkdir(path.join(domainDir, "_builds", ts), { recursive: true });
    await fs.writeFile(path.join(domainDir, "CURRENT"), `_builds/${ts}\n`, "utf8");
  }
}

function runCli(args, { cwd, env }) {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, [CLI_PATH, ...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    cp.stdout.on("data", (d) => { stdout += String(d); });
    cp.stderr.on("data", (d) => { stderr += String(d); });
    cp.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("doctor readiness=false when LaunchAgent is missing on host", async () => {
  const root = await mkTmpDir("companion-doctor-root-");
  const home = await mkTmpDir("companion-doctor-home-");
  await setupGovernanceFixture(root);

  const env = {
    ...process.env,
    COMPANION_ROOT: root,
    COMPANION_HOME: home,
    OPENAI_API_KEY: "sk-test",
    COMPANION_DOCTOR_OPENAI_MOCK: "ok",
  };

  const res = await runCli(["system:doctor"], { cwd: root, env });
  assert.equal(res.code, 1, `stderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout);
  assert.equal(out.readiness, false);
  assert.ok(out.blockers.some((b) => b.includes("LaunchAgent not installed")));
});

test("promote does not set production when blockers exist", async () => {
  const root = await mkTmpDir("companion-promote-blocked-root-");
  const home = await mkTmpDir("companion-promote-blocked-home-");
  await setupGovernanceFixture(root);

  const env = {
    ...process.env,
    COMPANION_ROOT: root,
    COMPANION_HOME: home,
    OPENAI_API_KEY: "sk-test",
    COMPANION_DOCTOR_OPENAI_MOCK: "ok",
    COMPANION_DOCTOR_MOCK_TEST_RESULT: "pass",
  };

  const res = await runCli(["system:promote"], { cwd: root, env });
  assert.equal(res.code, 1, `stderr:\n${res.stderr}`);

  const state = JSON.parse(
    await fs.readFile(path.join(root, "docs", "ACTIVE", "SETUP_STATE.json"), "utf8"),
  );
  assert.equal(state.mode, "staged");
  assert.equal(state.health_status, "blocked");
  assert.ok(Array.isArray(state.blockers));
  assert.ok(state.blockers.length > 0);
});

test("promote sets production only when all checks are green", async () => {
  const root = await mkTmpDir("companion-promote-green-root-");
  const home = await mkTmpDir("companion-promote-green-home-");
  await setupGovernanceFixture(root);

  const env = {
    ...process.env,
    COMPANION_ROOT: root,
    COMPANION_HOME: home,
    OPENAI_API_KEY: "sk-test",
    COMPANION_DOCTOR_OPENAI_MOCK: "ok",
    COMPANION_DOCTOR_MOCK_TEST_RESULT: "pass",
    COMPANION_DOCTOR_MOCK_LAUNCHAGENT_INSTALLED: "true",
    COMPANION_DOCTOR_MOCK_LAUNCHAGENT_RUNNING: "true",
  };

  const res = await runCli(["system:promote"], { cwd: root, env });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, true);

  const state = JSON.parse(
    await fs.readFile(path.join(root, "docs", "ACTIVE", "SETUP_STATE.json"), "utf8"),
  );
  assert.equal(state.mode, "production");
  assert.equal(state.health_status, "stable");
  assert.deepEqual(state.blockers, []);
  assert.ok(typeof state.last_doctor_result_path === "string");
  await assert.doesNotReject(() =>
    fs.access(path.join(root, state.last_doctor_result_path)),
  );
});

test("doctor writes summary file with compact human-readable content", async () => {
  const root = await mkTmpDir("companion-doctor-summary-root-");
  const home = await mkTmpDir("companion-doctor-summary-home-");
  await setupGovernanceFixture(root);

  const env = {
    ...process.env,
    COMPANION_ROOT: root,
    COMPANION_HOME: home,
    OPENAI_API_KEY: "sk-test",
    COMPANION_DOCTOR_OPENAI_MOCK: "ok",
    COMPANION_DOCTOR_MOCK_TEST_RESULT: "pass",
    COMPANION_DOCTOR_MOCK_LAUNCHAGENT_INSTALLED: "true",
    COMPANION_DOCTOR_MOCK_LAUNCHAGENT_RUNNING: "true",
  };

  const res = await runCli(["system:doctor", "--strict", "--run-tests"], { cwd: root, env });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout);
  assert.ok(typeof out.summary_path === "string");

  const summaryAbs = path.join(root, out.summary_path);
  const summaryRaw = await fs.readFile(summaryAbs, "utf8");
  const lines = summaryRaw.trim().split("\n");
  assert.ok(lines.length <= 10, `summary has ${lines.length} lines`);
  assert.ok(lines.some((l) => l.startsWith("timestamp: ")));
  assert.ok(lines.some((l) => l.startsWith("readiness: ")));
  assert.ok(lines.some((l) => l.startsWith("mode: ")));
});

test("doctor --quick implies strict without running npm tests", async () => {
  const root = await mkTmpDir("companion-doctor-quick-root-");
  const home = await mkTmpDir("companion-doctor-quick-home-");
  await setupGovernanceFixture(root);

  const env = {
    ...process.env,
    COMPANION_ROOT: root,
    COMPANION_HOME: home,
    OPENAI_API_KEY: "sk-test",
    COMPANION_DOCTOR_OPENAI_MOCK: "ok",
    COMPANION_DOCTOR_MOCK_LAUNCHAGENT_INSTALLED: "true",
    COMPANION_DOCTOR_MOCK_LAUNCHAGENT_RUNNING: "true",
  };

  const res = await runCli(["system:doctor", "--strict", "--quick"], { cwd: root, env });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout);
  assert.equal(out.strict, true);
  assert.equal(out.quick, true);
  assert.equal(out.run_tests, false);
  assert.equal(out.checks.npm_test_pass.skipped, true);
  assert.ok(!out.blockers.some((b) => b.includes("strict mode requires --run-tests")));
});
