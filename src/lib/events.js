const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const { DIRS } = require("./config");
const { appendLine, ensureDir, listFiles, safeRelative } = require("./fsx");

function nowIso() {
  return new Date().toISOString();
}

function dateOnly(isoTs) {
  return String(isoTs).slice(0, 10);
}

function newId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `evt_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function normalizeEvent(input) {
  const ts = input?.ts ? String(input.ts) : nowIso();
  const ev = {
    id: input?.id ? String(input.id) : newId(),
    ts,
    type: String(input?.type ?? "event.unknown"),
    domain: input?.domain == null ? null : String(input.domain),
    entity_id: input?.entity_id == null ? null : String(input.entity_id),
    payload: input?.payload ?? null,
    source: input?.source == null ? null : String(input.source),
  };
  return ev;
}

function validateEvent(ev) {
  if (!ev || typeof ev !== "object") throw new Error("event must be an object");
  for (const k of ["id", "ts", "type"]) {
    if (!ev[k] || typeof ev[k] !== "string") throw new Error(`event.${k} must be a string`);
  }
  if (ev.domain !== null && typeof ev.domain !== "string") throw new Error("event.domain must be string|null");
  if (ev.entity_id !== null && typeof ev.entity_id !== "string") throw new Error("event.entity_id must be string|null");
  return true;
}

function eventLogPath({ ts, eventsDir = DIRS.events } = {}) {
  const day = dateOnly(ts || nowIso());
  return path.join(eventsDir, `${day}.jsonl`);
}

async function appendEvent(input, { eventsDir = DIRS.events } = {}) {
  const ev = normalizeEvent(input);
  validateEvent(ev);

  const filePath = eventLogPath({ ts: ev.ts, eventsDir });
  await ensureDir(path.dirname(filePath));
  await appendLine(filePath, JSON.stringify(ev));
  return { event: ev, filePath };
}

function parseJsonlLines(lines) {
  const out = [];
  for (const line of lines) {
    const t = String(line ?? "").trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // ignore malformed lines
    }
  }
  return out;
}

async function mostRecentEventLog({ eventsDir = DIRS.events } = {}) {
  const files = await listFiles(eventsDir).catch(() => []);
  const jsonl = files.filter((f) => f.toLowerCase().endsWith(".jsonl")).sort();
  if (jsonl.length === 0) return null;
  return jsonl[jsonl.length - 1];
}

async function tailEvents({ n = 20, eventsDir = DIRS.events } = {}) {
  const filePath = await mostRecentEventLog({ eventsDir });
  if (!filePath) return { filePath: null, events: [] };

  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const take = lines.slice(Math.max(0, lines.length - Number(n || 20)));
  const events = parseJsonlLines(take);
  return { filePath: safeRelative(process.cwd(), filePath), events };
}

module.exports = {
  appendEvent,
  eventLogPath,
  mostRecentEventLog,
  newId,
  normalizeEvent,
  tailEvents,
  validateEvent,
};

