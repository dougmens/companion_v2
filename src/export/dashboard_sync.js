const fs = require("node:fs/promises");
const path = require("node:path");

const { ROOT } = require("../lib/config");
const { ensureDir, pathExists } = require("../lib/fsx");

async function syncDashboardSnapshot({ root = ROOT } = {}) {
  const absRoot = path.resolve(root);
  const src = path.join(absRoot, "80_export", "dashboard_state.json");
  const dest = path.join(absRoot, "ui", "public", "dashboard_state.json");

  const exists = await pathExists(src);
  if (!exists) {
    throw new Error(`dashboard snapshot missing at ${src}. Run npm run ui:export first.`);
  }

  await ensureDir(path.dirname(dest));
  await fs.copyFile(src, dest);

  return {
    ok: true,
    src,
    dest,
  };
}

async function main() {
  const result = await syncDashboardSnapshot();
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
  syncDashboardSnapshot,
};
