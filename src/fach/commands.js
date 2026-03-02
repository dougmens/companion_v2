const { loadRegistry, addCase } = require("../lib/registry");
const { mergeCases } = require("../lib/case_merge");
const { generateFachDashboard } = require("./dashboard");
const { listCaseDocuments } = require("./documents");
const { runWithFachFsGuard } = require("./guard");

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

async function prompt(question) {
  process.stdout.write(question);
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (data) => {
      process.stdin.pause();
      resolve(String(data).trim());
    });
  });
}

async function cmdCaseList() {
  const reg = await loadRegistry();
  const rows = (reg.cases || []).map((c) => ({
    case_id: c.case_id,
    title: c.title,
    aliases: (c.aliases || []).join(", "),
    tags: (c.tags || []).join(", "),
  }));
  // eslint-disable-next-line no-console
  console.table(rows);
}

async function cmdCaseAdd(argv) {
  const args = parseArgs(argv);
  const case_id = args.case_id || (await prompt("case_id (A-Za-z0-9_): "));
  const title = args.title || (await prompt("title: "));
  const aliasesCsv = args.aliases || (await prompt("aliases CSV: "));
  const tagsCsv = args.tags || (await prompt("tags CSV: "));

  const res = await addCase({ case_id, title, aliasesCsv, tagsCsv });
  // eslint-disable-next-line no-console
  console.log(`Added case: ${res.added}`);
}

async function cmdCaseMerge(argv) {
  const args = parseArgs(argv);
  const from = args.from || (await prompt("from case_id: "));
  const to = args.to || (await prompt("to case_id: "));
  const res = await mergeCases({ from, to });
  // eslint-disable-next-line no-console
  console.log(
    `Merged ${res.from} -> ${res.to} (moved pdf:${res.moved.pdf} md:${res.moved.md} meta:${res.moved.meta} evidence:${res.moved.evidence})`,
  );
}

async function cmdDocumentsList(argv) {
  const args = parseArgs(argv);
  const caseId = args.case_id || args.case;
  const out = await listCaseDocuments(caseId);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(out, null, 2));
}

async function cmdDashboardOverview() {
  const out = await generateFachDashboard();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(out, null, 2));
}

function usage() {
  // eslint-disable-next-line no-console
  console.log(`Fach commands:
  node src/cli.js fach case:list
  node src/cli.js fach case:add --case_id X --title "..." --aliases "a,b" --tags "t1,t2"
  node src/cli.js fach case:merge --from <case_id_A> --to <case_id_B>
  node src/cli.js fach dashboard:overview
  node src/cli.js fach docs:list --case-id <case_id>
`);
}

const FACH_COMMANDS = new Set([
  "case:list",
  "case:add",
  "case:merge",
  "dashboard:overview",
  "docs:list",
]);

function isFachCommand(cmd) {
  return FACH_COMMANDS.has(String(cmd || ""));
}

async function runFachCommand(cmd, argv) {
  if (!cmd) {
    usage();
    return;
  }

  return runWithFachFsGuard(async () => {
    if (cmd === "case:list") return cmdCaseList();
    if (cmd === "case:add") return cmdCaseAdd(argv);
    if (cmd === "case:merge") return cmdCaseMerge(argv);
    if (cmd === "dashboard:overview") return cmdDashboardOverview();
    if (cmd === "docs:list") return cmdDocumentsList(argv);

    usage();
    process.exitCode = 1;
  });
}

module.exports = {
  FACH_COMMANDS,
  isFachCommand,
  runFachCommand,
};
