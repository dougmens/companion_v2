const { newId } = require("./events");

function nowIso() {
  return new Date().toISOString();
}

function normalizeV2(input) {
  const obj = input && typeof input === "object" ? input : {};
  const intent = {
    // companion-json-v2-ish
    schema: obj.schema ? String(obj.schema) : "companion-json-v2",
    id: obj.id ? String(obj.id) : newId(),
    ts: obj.ts ? String(obj.ts) : nowIso(),
    type: obj.type ? String(obj.type).trim() : (obj.action ? String(obj.action).trim() : ""),
    domain: obj.domain == null ? null : String(obj.domain),
    entity_id:
      obj.entity_id == null
        ? (obj.entityId == null ? null : String(obj.entityId))
        : String(obj.entity_id),
    payload: obj.payload && typeof obj.payload === "object" ? obj.payload : {},
    source: obj.source == null ? null : String(obj.source),
    status: obj.status == null ? null : String(obj.status),
  };
  return intent;
}

function validateV2(intent) {
  if (!intent || typeof intent !== "object") throw new Error("v2 intent must be an object");
  for (const k of ["id", "ts", "type"]) {
    if (!intent[k] || typeof intent[k] !== "string") throw new Error(`v2.${k} must be a string`);
  }
  if (!intent.type) throw new Error("v2.type required");
  if (intent.payload !== null && typeof intent.payload !== "object") throw new Error("v2.payload must be object");
  return true;
}

function mapV2ToInternal(v2) {
  const type = String(v2.type || "").trim();
  const payload = v2.payload || {};

  if (type === "UPDATE_DASHBOARD_DATA") {
    if (payload.registry_case_add && typeof payload.registry_case_add === "object") {
      const p = payload.registry_case_add;
      return {
        decision: "mapped",
        internal: {
          id: v2.id,
          ts: v2.ts,
          action: "case:add",
          params: {
            case_id: p.case_id,
            title: p.title,
            aliases: p.aliases,
            tags: p.tags,
            aliasesCsv: p.aliasesCsv,
            tagsCsv: p.tagsCsv,
          },
          source: v2.source,
          status: v2.status,
        },
      };
    }

    if (payload.registry_case_update && typeof payload.registry_case_update === "object") {
      const p = payload.registry_case_update;
      return {
        decision: "mapped",
        internal: {
          id: v2.id,
          ts: v2.ts,
          action: "case:update",
          params: {
            case_id: p.case_id,
            title: p.title,
            aliases: p.aliases,
            tags: p.tags,
            aliasesCsv: p.aliasesCsv,
            tagsCsv: p.tagsCsv,
          },
          source: v2.source,
          status: v2.status,
        },
      };
    }

    return { decision: "noop", reason: "No safe registry_* payload provided" };
  }

  if (type === "PLAN_WORKFLOW") {
    return { decision: "noop", reason: "PLAN_WORKFLOW is event-only in phase 1" };
  }

  if (type === "SHOW_DASHBOARD") {
    return { decision: "noop", reason: "SHOW_DASHBOARD is event-only in phase 1" };
  }

  if (type === "FOCUS_ENTITY") {
    return { decision: "noop", reason: "FOCUS_ENTITY is event-only in phase 1" };
  }

  return { decision: "rejected", reason: `Unsupported v2 type: ${type}` };
}

module.exports = {
  mapV2ToInternal,
  normalizeV2,
  validateV2,
};
