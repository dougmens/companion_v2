const path = require("node:path");

const { DIRS } = require("./config");
const { readJson } = require("./fsx");
const { appendEvent, newId } = require("./events");
const { addCase, updateCase } = require("./registry");

function nowIso() {
  return new Date().toISOString();
}

function normalizeIntent(input) {
  const obj = input && typeof input === "object" ? input : {};
  const intent = {
    id: obj.id ? String(obj.id) : newId(),
    ts: obj.ts ? String(obj.ts) : nowIso(),
    action: String(obj.action ?? "").trim(),
    params: obj.params && typeof obj.params === "object" ? obj.params : {},
    source: obj.source == null ? null : String(obj.source),
    status: obj.status == null ? null : String(obj.status),
  };
  return intent;
}

function validateIntent(intent) {
  if (!intent || typeof intent !== "object") throw new Error("intent must be an object");
  for (const k of ["id", "ts", "action"]) {
    if (!intent[k] || typeof intent[k] !== "string") throw new Error(`intent.${k} must be a string`);
  }
  if (!intent.action) throw new Error("intent.action required");
  if (intent.params !== null && typeof intent.params !== "object") throw new Error("intent.params must be an object");
  return true;
}

async function applyIntent(
  intentInput,
  { eventsDir = DIRS.events, eventSource = "intent:apply" } = {},
) {
  const intent = normalizeIntent(intentInput);
  validateIntent(intent);

  const { action, params } = intent;
  let result = { ok: true, action, changed: false };
  let entity_id = null;

  if (action === "case:add") {
    const case_id = params.case_id;
    const title = params.title;
    const aliasesCsv = Array.isArray(params.aliases) ? params.aliases.join(",") : params.aliasesCsv;
    const tagsCsv = Array.isArray(params.tags) ? params.tags.join(",") : params.tagsCsv;
    const res = await addCase({ case_id, title, aliasesCsv, tagsCsv });
    result = { ok: true, action, changed: true, added: res.added };
    entity_id = res.added;
  } else if (action === "case:update") {
    const case_id = params.case_id;
    const title = params.title;
    const aliasesCsv = Array.isArray(params.aliases) ? params.aliases.join(",") : params.aliasesCsv;
    const tagsCsv = Array.isArray(params.tags) ? params.tags.join(",") : params.tagsCsv;
    const res = await updateCase({ case_id, title, aliasesCsv, tagsCsv });
    result = { ok: true, action, changed: true, updated: res.updated };
    entity_id = res.updated;
  } else if (action === "noop") {
    result = { ok: true, action, changed: false };
  } else {
    throw new Error(`Unsupported intent action: ${action}`);
  }

  const eventInput = {
    ts: nowIso(),
    type: "intent.applied",
    domain: "runtime",
    entity_id,
    source: eventSource,
    payload: {
      intent_id: intent.id,
      intent_ts: intent.ts,
      intent_source: intent.source,
      action,
      params,
      result,
    },
  };

  const ev = await appendEvent(eventInput, { eventsDir });
  return { intent, event: ev.event, eventFile: ev.filePath, result };
}

async function applyIntentFromFile(intentPath, opts = {}) {
  const full = path.resolve(String(intentPath));
  const raw = await readJson(full);
  return applyIntent(raw, opts);
}

module.exports = {
  applyIntent,
  applyIntentFromFile,
  normalizeIntent,
  validateIntent,
};
