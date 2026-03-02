const path = require("node:path");

const { DIRS } = require("./config");
const { readJson } = require("./fsx");
const { appendEvent, newId } = require("./events");
const { loadRegistry, normalizeCaseId } = require("./registry");

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

function csvToList(value) {
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeListValue(listValue, csvValue, { fallback = [] } = {}) {
  if (Array.isArray(listValue)) {
    return listValue
      .map((s) => String(s ?? "").trim())
      .filter(Boolean);
  }
  if (csvValue !== undefined) return csvToList(csvValue);
  return fallback;
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
  let registryEvent = null;

  if (action === "case:add") {
    const case_id = params.case_id;
    const title = params.title;
    const normalizedId = normalizeCaseId(case_id);
    if (!normalizedId) {
      throw new Error("case_id must match /^[A-Za-z0-9_]+$/");
    }

    const registry = await loadRegistry();
    const duplicate = (registry.cases || []).some((c) => c && c.case_id === normalizedId);
    if (duplicate) {
      throw new Error(`Duplicate case_id: ${normalizedId}`);
    }

    const aliases = normalizeListValue(params.aliases, params.aliasesCsv, { fallback: [] });
    const tags = normalizeListValue(params.tags, params.tagsCsv, { fallback: [] });
    const normalizedTitle = String(title ?? "").trim() || normalizedId;

    registryEvent = {
      ts: nowIso(),
      type: "CASE_CREATED",
      domain: "registry",
      entity_id: normalizedId,
      source: eventSource,
      payload: {
        case_id: normalizedId,
        title: normalizedTitle,
        aliases,
        tags,
      },
    };
    result = { ok: true, action, changed: true, added: normalizedId };
    entity_id = normalizedId;
  } else if (action === "case:update") {
    const case_id = params.case_id;
    const normalizedId = normalizeCaseId(case_id);
    if (!normalizedId) {
      throw new Error("case_id must match /^[A-Za-z0-9_]+$/");
    }

    const registry = await loadRegistry();
    const current = (registry.cases || []).find((c) => c && c.case_id === normalizedId);
    if (!current) {
      throw new Error(`Unknown case_id: ${normalizedId}`);
    }

    const payload = { case_id: normalizedId };
    if (params.title !== undefined) {
      payload.title = String(params.title ?? "").trim() || normalizedId;
    }
    if (params.aliases !== undefined || params.aliasesCsv !== undefined) {
      payload.aliases = normalizeListValue(params.aliases, params.aliasesCsv, { fallback: [] });
    }
    if (params.tags !== undefined || params.tagsCsv !== undefined) {
      payload.tags = normalizeListValue(params.tags, params.tagsCsv, { fallback: [] });
    }

    registryEvent = {
      ts: nowIso(),
      type: "CASE_UPDATED",
      domain: "registry",
      entity_id: normalizedId,
      source: eventSource,
      payload,
    };

    result = { ok: true, action, changed: true, updated: normalizedId };
    entity_id = normalizedId;
  } else if (action === "noop") {
    result = { ok: true, action, changed: false };
  } else {
    throw new Error(`Unsupported intent action: ${action}`);
  }

  const emitted = [];
  if (registryEvent) {
    const regEv = await appendEvent(registryEvent, { eventsDir });
    emitted.push(regEv);
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
  emitted.push(ev);
  return {
    intent,
    event: ev.event,
    eventFile: ev.filePath,
    events: emitted.map((item) => ({ event: item.event, filePath: item.filePath })),
    result,
  };
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
