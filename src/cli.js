const { isFachCommand, runFachCommand } = require("./fach/commands");
const { isAdminCommand, runAdminCommand } = require("./admin/commands");

function usage() {
  // eslint-disable-next-line no-console
  console.log(`Usage:
  node src/cli.js fach <command> [args]
  node src/cli.js admin <command> [args]
`);
}

async function routeLegacyCommand(firstArg, restArgs) {
  if (isFachCommand(firstArg)) {
    // eslint-disable-next-line no-console
    console.warn(`[router] Legacy command form detected. Use: node src/cli.js fach ${firstArg}`);
    return runFachCommand(firstArg, restArgs);
  }
  if (isAdminCommand(firstArg)) {
    // eslint-disable-next-line no-console
    console.warn(`[router] Legacy command form detected. Use: node src/cli.js admin ${firstArg}`);
    return runAdminCommand(firstArg, restArgs);
  }
  usage();
  process.exitCode = 1;
  return null;
}

async function main() {
  const scope = process.argv[2];
  const cmd = process.argv[3];

  if (!scope) {
    usage();
    process.exitCode = 1;
    return;
  }

  if (scope === "fach") {
    await runFachCommand(cmd, process.argv.slice(4));
    return;
  }

  if (scope === "admin") {
    await runAdminCommand(cmd, process.argv.slice(4));
    return;
  }

  await routeLegacyCommand(scope, process.argv.slice(3));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err?.stack || err);
  process.exit(1);
});

const path = require("path");
const fs = require("fs");
const { rebuildRegistryFromEvents } = require("./projection/registryProjector");

if (process.argv[2] === "registry:rebuild") {
  const eventsDir = path.join(process.cwd(), "50_events");
  let events = [];

  if (fs.existsSync(eventsDir)) {
    const files = fs.readdirSync(eventsDir).filter(f => f.endsWith(".jsonl"));
    for (const file of files) {
      const lines = fs.readFileSync(path.join(eventsDir, file), "utf8")
        .split("\n")
        .filter(Boolean);
      for (const line of lines) {
        try {
          events.push(JSON.parse(line));
        } catch (_) {}
      }
    }
  }

  events.sort((a, b) => new Date(a.ts || 0) - new Date(b.ts || 0));
  const registry = rebuildRegistryFromEvents(events);
  fs.writeFileSync("case_registry.json", JSON.stringify(registry, null, 2));
  console.log("Registry rebuilt from events.");
  process.exit(0);
}
