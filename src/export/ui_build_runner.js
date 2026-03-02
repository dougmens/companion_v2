const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { ROOT } = require("../lib/config");
const { ensureDir, pathExists } = require("../lib/fsx");

function run(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const cp = spawn(cmd, args, { stdio: "inherit", ...options });
    cp.on("close", (code) => resolve(code));
    cp.on("error", () => resolve(1));
  });
}

async function copyFileSafe(src, dest) {
  await ensureDir(path.dirname(dest));
  await fs.copyFile(src, dest);
}

async function fallbackBuild(root) {
  const uiRoot = path.join(root, "ui");
  const dist = path.join(uiRoot, "dist");
  const fallbackDir = path.join(uiRoot, "fallback");
  const snapshot = path.join(uiRoot, "public", "dashboard_state.json");

  if (!(await pathExists(snapshot))) {
    throw new Error("Missing ui/public/dashboard_state.json. Run npm run ui:export && npm run ui:sync first.");
  }

  await ensureDir(dist);
  await copyFileSafe(path.join(fallbackDir, "index.html"), path.join(dist, "index.html"));
  await copyFileSafe(path.join(fallbackDir, "app.js"), path.join(dist, "app.js"));
  await copyFileSafe(path.join(fallbackDir, "styles.css"), path.join(dist, "styles.css"));
  await copyFileSafe(snapshot, path.join(dist, "dashboard_state.json"));

  return {
    ok: true,
    mode: "fallback",
    dist,
  };
}

async function buildUi({ root = ROOT } = {}) {
  const uiRoot = path.join(root, "ui");
  const viteBin = path.join(uiRoot, "node_modules", "vite", "bin", "vite.js");

  if (await pathExists(viteBin)) {
    const code = await run(process.execPath, [viteBin, "build"], { cwd: uiRoot });
    if (code !== 0) throw new Error(`vite build failed with code ${code}`);
    return {
      ok: true,
      mode: "vite",
      dist: path.join(uiRoot, "dist"),
    };
  }

  return fallbackBuild(root);
}

async function main() {
  const result = await buildUi();
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
  buildUi,
};
