const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { spawn } = require("node:child_process");

const SERVER_ENTRY = path.join(__dirname, "..", "src", "ui-server", "index.js");
const REPO_ROOT = path.join(__dirname, "..");

async function mkTmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr && addr.port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    srv.on("error", reject);
  });
}

async function setupFixtureRoot(root) {
  await writeJson(path.join(root, "package.json"), {
    name: "fixture-ui",
    private: true,
    scripts: {
      "system:doctor": "node src/cli.js system:doctor",
      "system:promote": "node src/cli.js system:promote",
      "ingest:retry": "node src/cli.js ingest:retry",
      "ingest:reprocess": "node src/cli.js ingest:reprocess",
      "rag:rebuild": "node src/cli.js rag:rebuild",
      test: "node --test",
    },
  });

  await writeJson(path.join(root, "docs", "ACTIVE", "SETUP_STATE.json"), {
    version: "local-v1",
    mode: "staged",
    health_status: "degraded",
    blockers: [],
  });

  await writeJson(path.join(root, "case_registry.json"), {
    version: 1,
    cases: [
      {
        case_id: "Strafrecht_Strafanzeigen_Schoenlein",
        title: "Strafanzeigen Schoenlein",
        aliases: [],
        tags: ["strafrecht"],
      },
    ],
  });

  const base = path.join(
    root,
    "10_processed",
    "juristische_faelle",
    "strafrecht",
    "Strafrecht_Strafanzeigen_Schoenlein",
  );
  await fs.mkdir(path.join(base, "pdf"), { recursive: true });
  await fs.mkdir(path.join(base, "md"), { recursive: true });
  await fs.mkdir(path.join(base, "meta"), { recursive: true });

  await fs.writeFile(path.join(base, "pdf", "a.pdf"), "%PDF-1.4\n", "utf8");
  await fs.writeFile(path.join(base, "md", "a.md"), "# md\n", "utf8");
  await writeJson(path.join(base, "meta", "a.json"), { ok: true });

  await fs.mkdir(path.join(root, "10_processed", "allgemein", "REVIEW_REQUIRED"), { recursive: true });
  await fs.writeFile(path.join(root, "10_processed", "allgemein", "REVIEW_REQUIRED", "review.pdf"), "%PDF-1.4\n", "utf8");

  await fs.mkdir(path.join(root, "50_events"), { recursive: true });
  await fs.mkdir(path.join(root, "60_intents"), { recursive: true });
  await fs.mkdir(path.join(root, "70_runtime"), { recursive: true });
  await fs.mkdir(path.join(root, "90_logs"), { recursive: true });
}

async function setupMockLaunchAgentHome(home) {
  const launchDir = path.join(home, "Library", "LaunchAgents");
  await fs.mkdir(launchDir, { recursive: true });
  await fs.writeFile(
    path.join(launchDir, "com.companion.ingestwatch.plist"),
    "<plist><dict></dict></plist>\n",
    "utf8",
  );
}

function startServer({ root, port, envExtra = {} }) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      COMPANION_ROOT: root,
      UI_HOST: "127.0.0.1",
      UI_PORT: String(port),
      ...envExtra,
    };

    const cp = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: REPO_ROOT,
      env,
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      cp.kill("SIGTERM");
      reject(new Error(`ui-server start timeout\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 8000);

    cp.stdout.on("data", (d) => {
      const s = String(d);
      stdout += s;
      if (s.includes("[ui-server] listening")) {
        clearTimeout(timer);
        resolve({ cp, stdout, stderr });
      }
    });
    cp.stderr.on("data", (d) => {
      stderr += String(d);
    });

    cp.on("exit", (code) => {
      if (!stdout.includes("[ui-server] listening")) {
        clearTimeout(timer);
        reject(new Error(`ui-server exited early code=${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    });
  });
}

test("ui-server smoke: /api/cases returns computed case counts", async () => {
  const root = await mkTmpDir("companion-ui-root-");
  await setupFixtureRoot(root);

  const port = await getFreePort();
  const { cp } = await startServer({ root, port });

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/cases`);
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.ok(Array.isArray(data.cases));
    assert.equal(data.cases.length, 1);
    assert.equal(data.cases[0].case_id, "Strafrecht_Strafanzeigen_Schoenlein");
    assert.equal(data.cases[0].pdf_count, 1);
    assert.equal(data.cases[0].md_count, 1);
    assert.equal(data.cases[0].meta_count, 1);
    assert.equal(data.review_required_count, 1);
  } finally {
    cp.kill("SIGTERM");
  }
});

test("ui-server route: /api/scripts returns script list", async () => {
  const root = await mkTmpDir("companion-ui-scripts-root-");
  await setupFixtureRoot(root);
  const port = await getFreePort();
  const { cp } = await startServer({ root, port });

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/scripts`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.scripts));
    assert.ok(data.scripts.some((s) => s.name === "system:doctor"));
    assert.ok(data.scripts.some((s) => s.name === "ingest:reprocess"));
  } finally {
    cp.kill("SIGTERM");
  }
});

test("ui-server route: /api/watcher/status returns watcher payload", async () => {
  const root = await mkTmpDir("companion-ui-watcher-root-");
  const companionHome = await mkTmpDir("companion-ui-home-");
  await setupFixtureRoot(root);
  await setupMockLaunchAgentHome(companionHome);
  const port = await getFreePort();
  const { cp } = await startServer({
    root,
    port,
    envExtra: {
      UI_SERVER_MOCK_LAUNCHCTL: "1",
      COMPANION_HOME: companionHome,
    },
  });

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/watcher/status`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(typeof data.running, "boolean");
    assert.equal(typeof data.ok, "boolean");
    assert.equal(data.label, "com.companion.ingestwatch");
    assert.equal(typeof data.stdout, "string");
    assert.equal(typeof data.stderr, "string");
    assert.equal(typeof data.last_log_tail, "string");
  } finally {
    cp.kill("SIGTERM");
  }
});

test("ui-server watcher start/stop/status flow works with mock runner", async () => {
  const root = await mkTmpDir("companion-ui-watcher-flow-root-");
  const companionHome = await mkTmpDir("companion-ui-home-flow-");
  await setupFixtureRoot(root);
  await setupMockLaunchAgentHome(companionHome);
  const port = await getFreePort();
  const { cp } = await startServer({
    root,
    port,
    envExtra: {
      UI_SERVER_MOCK_LAUNCHCTL: "1",
      COMPANION_HOME: companionHome,
    },
  });

  try {
    const startRes = await fetch(`http://127.0.0.1:${port}/api/watcher/start`, { method: "POST" });
    assert.equal(startRes.status, 200);
    const startData = await startRes.json();
    assert.equal(startData.ok, true);
    assert.equal(startData.running, true);
    assert.equal(typeof startData.stdout, "string");
    assert.equal(typeof startData.stderr, "string");

    const statusOnRes = await fetch(`http://127.0.0.1:${port}/api/watcher/status`);
    assert.equal(statusOnRes.status, 200);
    const statusOn = await statusOnRes.json();
    assert.equal(statusOn.running, true);

    const stopRes = await fetch(`http://127.0.0.1:${port}/api/watcher/stop`, { method: "POST" });
    assert.equal(stopRes.status, 200);
    const stopData = await stopRes.json();
    assert.equal(stopData.ok, true);
    assert.equal(stopData.running, false);
    assert.equal(typeof stopData.stdout, "string");
    assert.equal(typeof stopData.stderr, "string");

    const statusOffRes = await fetch(`http://127.0.0.1:${port}/api/watcher/status`);
    assert.equal(statusOffRes.status, 200);
    const statusOff = await statusOffRes.json();
    assert.equal(statusOff.running, false);
  } finally {
    cp.kill("SIGTERM");
  }
});
