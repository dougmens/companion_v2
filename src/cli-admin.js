const { runAdminCommand } = require("./admin/commands");

async function main() {
  const cmd = process.argv[2];
  await runAdminCommand(cmd, process.argv.slice(3));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err?.stack || err);
  process.exit(1);
});
