const path = require("node:path");
const { spawn } = require("node:child_process");

const { ROOT } = require("../lib/config");
const { pathExists } = require("../lib/fsx");

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const cp = spawn(cmd, args, { stdio: "inherit", ...opts });
    cp.on("close", (code) => resolve(code || 0));
    cp.on("error", () => resolve(1));
  });
}

async function main() {
  const uiRoot = path.join(ROOT, "ui");
  const vitestBin = path.join(uiRoot, "node_modules", "vitest", "vitest.mjs");

  if (await pathExists(vitestBin)) {
    const code = await run(process.execPath, [vitestBin, "run"], { cwd: uiRoot });
    process.exit(code);
  }

  const code = await run(process.execPath, ["--test", "ui/test/ui_helpers.test.cjs"], { cwd: ROOT });
  process.exit(code);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error?.stack || error);
  process.exit(1);
});
